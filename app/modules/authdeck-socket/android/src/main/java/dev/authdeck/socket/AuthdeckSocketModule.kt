package dev.authdeck.socket

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Largest single read, so one onData event never carries more than this. */
internal const val READ_CHUNK_BYTES = 64 * 1024

/** Mirrors MAX_UNACKED_BYTES in index.ts: reading pauses while JS holds more than this. */
internal const val MAX_UNACKED_BYTES = 256L * 1024

/** Open (and connecting) sockets allowed at once; connect rejects past it. */
internal const val MAX_OPEN_SOCKETS = 64

private const val EVENT_DATA = "onData"
private const val EVENT_CLOSE = "onClose"
private const val EVENT_ERROR = "onError"

/**
 * Raw TCP sockets for the link to AuthDeck Agent. The contract is in modules/authdeck-socket/index.ts:
 * bytes only, base64 across the bridge, reads paused by unacknowledged bytes, and every socket
 * ends with exactly one onClose. Nothing here throws on a background thread.
 */
class AuthdeckSocketModule : Module() {
  private val sockets = ConcurrentHashMap<Int, SocketConnection>()
  private val nextId = AtomicInteger(1)
  private val workers: ExecutorService = Executors.newCachedThreadPool(daemonThreads("authdeck-socket"))
  private val timers: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor(daemonThreads("authdeck-socket-timer"))

  override fun definition() = ModuleDefinition {
    Name("AuthdeckSocket")

    Events(EVENT_DATA, EVENT_CLOSE, EVENT_ERROR)

    AsyncFunction("connect") { host: String, port: Int, timeoutMs: Int, promise: Promise ->
      connect(host, port, timeoutMs, promise)
    }

    AsyncFunction("write") { id: Int, data: String, promise: Promise ->
      write(id, data, promise)
    }

    Function("ack") { id: Int, bytes: Int ->
      sockets[id]?.ack(bytes)
    }

    Function("close") { id: Int ->
      sockets[id]?.close()
    }

    OnDestroy {
      sockets.values.forEach { it.close() }
      workers.shutdownNow()
      timers.shutdownNow()
    }
  }

  private fun connect(host: String, port: Int, timeoutMs: Int, promise: Promise) {
    val invalid = invalidConnectArgs(host, port, timeoutMs)
    if (invalid != null) {
      promise.reject("ERR_SOCKET_ARGS", invalid, null)
      return
    }
    val connection = reserve(promise) ?: return
    val settled = AtomicBoolean(false)
    val timeout = timers.schedule({
      if (settled.compareAndSet(false, true)) {
        connection.abandon()
        promise.reject("ERR_SOCKET_TIMEOUT", "Timed out after $timeoutMs ms connecting to $host:$port", null)
      }
    }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
    workers.execute {
      try {
        // Resolving the name happens here, off the JS thread; the overall deadline above covers it.
        connection.socket.connect(InetSocketAddress(stripBrackets(host), port), timeoutMs)
        connection.socket.tcpNoDelay = true
        timeout.cancel(false)
        if (!settled.compareAndSet(false, true)) {
          connection.abandon()
          return@execute
        }
        promise.resolve(connection.id)
        connection.startReading(workers)
      } catch (failure: Throwable) {
        timeout.cancel(false)
        connection.abandon()
        if (settled.compareAndSet(false, true)) {
          promise.reject("ERR_SOCKET_CONNECT", "Could not connect to $host:$port: ${describe(failure)}", null)
        }
      }
    }
  }

  /** Takes a socket slot and id, or rejects when every slot is taken. */
  private fun reserve(promise: Promise): SocketConnection? = synchronized(sockets) {
    if (sockets.size >= MAX_OPEN_SOCKETS) {
      promise.reject("ERR_SOCKET_LIMIT", "Too many open sockets ($MAX_OPEN_SOCKETS); close one first", null)
      return null
    }
    val id = nextId.getAndIncrement()
    SocketConnection(id, Socket(), ::emit) { sockets.remove(id) }.also { sockets[id] = it }
  }

  private fun write(id: Int, data: String, promise: Promise) {
    val bytes = try {
      Base64.decode(data, Base64.DEFAULT)
    } catch (failure: IllegalArgumentException) {
      promise.reject("ERR_SOCKET_ARGS", "write: data is not base64", null)
      return
    }
    // An unknown id is a socket that already sent its onClose; the write has nowhere to go.
    val connection = sockets[id] ?: return promise.resolve()
    connection.write(bytes) { promise.resolve() }
  }

  private fun emit(event: String, body: Map<String, Any?>) {
    try {
      sendEvent(event, body)
    } catch (_: Throwable) {
      // The JS runtime is gone (reload or teardown); nobody is left to tell.
    }
  }
}

/**
 * One TCP socket: a reader on a pool thread that blocks while JS holds too many unacked bytes,
 * and a single writer thread so writes go out in order without blocking the module.
 */
internal class SocketConnection(
  val id: Int,
  val socket: Socket,
  private val emit: (String, Map<String, Any?>) -> Unit,
  private val onFinished: () -> Unit,
) {
  private val lock = Object()
  private var unackedBytes = 0L
  private val finished = AtomicBoolean(false)
  private val writer: ExecutorService = Executors.newSingleThreadExecutor(daemonThreads("authdeck-socket-$id-write"))

  fun startReading(pool: ExecutorService) {
    try {
      pool.execute(::readLoop)
    } catch (failure: Throwable) {
      finish(describe(failure))
    }
  }

  fun ack(bytes: Int) {
    synchronized(lock) {
      unackedBytes = (unackedBytes - bytes.coerceAtLeast(0)).coerceAtLeast(0)
      lock.notifyAll()
    }
  }

  fun write(bytes: ByteArray, done: () -> Unit) {
    try {
      writer.execute {
        try {
          if (!finished.get()) {
            socket.getOutputStream().write(bytes)
          }
        } catch (failure: Throwable) {
          finish(describe(failure))
        } finally {
          done()
        }
      }
    } catch (_: Throwable) {
      // The writer was shut down by a close racing this write; the socket's onClose covers it.
      done()
    }
  }

  /** A local close: onClose without onError. */
  fun close() = finish(null)

  /** Drops a socket that never reached JS (connect failed or timed out): no events. */
  fun abandon() {
    if (finished.compareAndSet(false, true)) release()
  }

  private fun readLoop() {
    try {
      val input = socket.getInputStream()
      val buffer = ByteArray(READ_CHUNK_BYTES)
      while (!finished.get()) {
        if (!awaitAckedBelowLimit()) return
        val count = input.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        synchronized(lock) { unackedBytes += count }
        emit(EVENT_DATA, mapOf("id" to id, "data" to Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)))
      }
      finish(null)
    } catch (failure: Throwable) {
      finish(describe(failure))
    }
  }

  /** Blocks while JS holds more than MAX_UNACKED_BYTES; false once the socket is finished. */
  private fun awaitAckedBelowLimit(): Boolean = synchronized(lock) {
    while (unackedBytes > MAX_UNACKED_BYTES && !finished.get()) {
      lock.wait()
    }
    !finished.get()
  }

  /** Ends the socket once: onError (if [error]) then onClose. Later calls do nothing. */
  private fun finish(error: String?) {
    if (!finished.compareAndSet(false, true)) return
    release()
    if (error != null) emit(EVENT_ERROR, mapOf("id" to id, "message" to error))
    emit(EVENT_CLOSE, mapOf("id" to id))
  }

  private fun release() {
    try {
      socket.close()
    } catch (_: Throwable) {
      // Already closed or never opened; the descriptor is released either way.
    }
    // Writes still queued see `finished` and skip the socket; running them settles their promises.
    writer.shutdownNow().forEach { queued -> queued.run() }
    synchronized(lock) { lock.notifyAll() }
    onFinished()
  }
}

internal fun invalidConnectArgs(host: String, port: Int, timeoutMs: Int): String? = when {
  host.isBlank() -> "connect: host is empty"
  port !in 1..65535 -> "connect: port $port is outside 1-65535"
  timeoutMs <= 0 -> "connect: timeoutMs must be positive, got $timeoutMs"
  else -> null
}

/** Accepts "[::1]" as well as "::1" for IPv6 literals. */
internal fun stripBrackets(host: String): String =
  if (host.startsWith("[") && host.endsWith("]")) host.substring(1, host.length - 1) else host

internal fun describe(failure: Throwable): String =
  failure.message?.takeIf { it.isNotBlank() } ?: failure.javaClass.simpleName

private fun daemonThreads(name: String): ThreadFactory {
  val count = AtomicInteger(0)
  return ThreadFactory { task ->
    Thread(task, "$name-${count.incrementAndGet()}").apply { isDaemon = true }
  }
}
