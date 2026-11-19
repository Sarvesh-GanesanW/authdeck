import ExpoModulesCore
import Foundation
import Network

/// Largest single read, so one onData event never carries more than this.
private let readChunkBytes = 64 * 1024

/// Mirrors MAX_UNACKED_BYTES in index.ts: reading pauses while JS holds more than this.
private let maxUnackedBytes = 256 * 1024

/// Open (and connecting) sockets allowed at once; connect rejects past it.
private let maxOpenSockets = 64

private let eventData = "onData"
private let eventClose = "onClose"
private let eventError = "onError"

/// Raw TCP sockets for the link to AuthDeck Agent. The contract is in modules/authdeck-socket/index.ts:
/// bytes only, base64 across the bridge, reads paused by unacknowledged bytes, and every socket
/// ends with exactly one onClose.
public final class AuthdeckSocketModule: Module {
  private let registryLock = NSLock()
  private var sockets: [Int: SocketConnection] = [:]
  private var nextId = 1

  public func definition() -> ModuleDefinition {
    Name("AuthdeckSocket")

    Events(eventData, eventClose, eventError)

    AsyncFunction("connect") { (host: String, port: Int, timeoutMs: Int, promise: Promise) in
      self.connect(host: host, port: port, timeoutMs: timeoutMs, promise: promise)
    }

    AsyncFunction("write") { (id: Int, data: String, promise: Promise) in
      guard let bytes = Data(base64Encoded: data) else {
        promise.reject("ERR_SOCKET_ARGS", "write: data is not base64")
        return
      }
      // An unknown id is a socket that already sent its onClose; the write has nowhere to go.
      guard let connection = self.socket(id) else {
        promise.resolve()
        return
      }
      connection.write(bytes) { promise.resolve() }
    }

    Function("ack") { (id: Int, bytes: Int) in
      self.socket(id)?.ack(bytes)
    }

    Function("close") { (id: Int) in
      self.socket(id)?.close()
    }

    OnDestroy {
      self.registryLock.lock()
      let open = Array(self.sockets.values)
      self.registryLock.unlock()
      open.forEach { $0.close() }
    }
  }

  private func connect(host: String, port: Int, timeoutMs: Int, promise: Promise) {
    if let invalid = invalidConnectArgs(host: host, port: port, timeoutMs: timeoutMs) {
      promise.reject("ERR_SOCKET_ARGS", invalid)
      return
    }
    guard let connection = reserve(host: host, port: port) else {
      promise.reject("ERR_SOCKET_LIMIT", "Too many open sockets (\(maxOpenSockets)); close one first")
      return
    }
    connection.start(timeoutMs: timeoutMs) { failure in
      if let failure {
        promise.reject("ERR_SOCKET_CONNECT", "Could not connect to \(host):\(port): \(failure)")
      } else {
        promise.resolve(connection.id)
      }
    }
  }

  /// Takes a socket slot and id, or nil when every slot is taken.
  private func reserve(host: String, port: Int) -> SocketConnection? {
    registryLock.lock()
    defer { registryLock.unlock() }
    guard sockets.count < maxOpenSockets else { return nil }
    let id = nextId
    nextId += 1
    let connection = SocketConnection(
      id: id,
      host: stripBrackets(host),
      port: UInt16(port),
      emit: { [weak self] event, body in self?.sendEvent(event, body) },
      onFinished: { [weak self] in self?.forget(id) }
    )
    sockets[id] = connection
    return connection
  }

  private func socket(_ id: Int) -> SocketConnection? {
    registryLock.lock()
    defer { registryLock.unlock() }
    return sockets[id]
  }

  private func forget(_ id: Int) {
    registryLock.lock()
    sockets.removeValue(forKey: id)
    registryLock.unlock()
  }
}

/// One TCP socket. All its state lives on its own serial queue; `receive` is only called again
/// while JS holds at most maxUnackedBytes, so a peer that never stops sending can't grow memory.
private final class SocketConnection: @unchecked Sendable {
  let id: Int
  private let connection: NWConnection
  private let queue: DispatchQueue
  private let emit: (String, [String: Any?]) -> Void
  private let onFinished: () -> Void

  private var unackedBytes = 0
  private var isReceiving = false
  private var isFinished = false
  /// Set until connect settles; called once with nil (connected) or the failure.
  private var connectCompletion: ((String?) -> Void)?

  init(
    id: Int,
    host: String,
    port: UInt16,
    emit: @escaping (String, [String: Any?]) -> Void,
    onFinished: @escaping () -> Void
  ) {
    self.id = id
    self.emit = emit
    self.onFinished = onFinished
    queue = DispatchQueue(label: "dev.authdeck.socket.\(id)")
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    connection = NWConnection(
      host: NWEndpoint.Host(host),
      port: NWEndpoint.Port(rawValue: port)!,  // port was checked to be in 1...65535
      using: NWParameters(tls: nil, tcp: tcp)
    )
  }

  func start(timeoutMs: Int, completion: @escaping (String?) -> Void) {
    queue.async { [weak self] in self?.begin(timeoutMs: timeoutMs, completion: completion) }
  }

  func write(_ bytes: Data, done: @escaping () -> Void) {
    queue.async {
      guard !self.isFinished else {
        done()
        return
      }
      self.connection.send(content: bytes, completion: .contentProcessed { error in
        if let error { self.finish(error: "\(error)") }
        done()
      })
    }
  }

  func ack(_ bytes: Int) {
    queue.async {
      self.unackedBytes = max(0, self.unackedBytes - max(0, bytes))
      self.receiveIfAllowed()
    }
  }

  /// A local close: onClose without onError.
  func close() {
    queue.async {
      if self.connectCompletion != nil {
        self.failConnect("closed while connecting")
      } else {
        self.finish(error: nil)
      }
    }
  }

  private func begin(timeoutMs: Int, completion: @escaping (String?) -> Void) {
    connectCompletion = completion
    // Weak: the connection keeps this handler until release() clears it.
    connection.stateUpdateHandler = { [weak self] state in self?.handle(state) }
    connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
      self?.failConnect("timed out after \(timeoutMs) ms")
    }
  }

  private func handle(_ state: NWConnection.State) {
    switch state {
    case .ready:
      guard let completion = connectCompletion else { return }
      connectCompletion = nil
      completion(nil)
      receiveIfAllowed()
    case .waiting(let error), .failed(let error):
      // A refused or unreachable TCP connect parks in .waiting to retry later; treat it as failed.
      if connectCompletion != nil {
        failConnect("\(error)")
      } else {
        finish(error: "\(error)")
      }
    case .cancelled:
      finish(error: nil)
    default:
      break
    }
  }

  /// Fails a connect still in progress: rejects it and drops the socket without events.
  private func failConnect(_ reason: String) {
    guard let completion = connectCompletion else { return }
    connectCompletion = nil
    isFinished = true
    release()
    completion(reason)
  }

  private func receiveIfAllowed() {
    guard !isFinished, !isReceiving, connectCompletion == nil, unackedBytes <= maxUnackedBytes else { return }
    isReceiving = true
    connection.receive(minimumIncompleteLength: 1, maximumLength: readChunkBytes) {
      [weak self] content, _, isComplete, error in
      self?.received(content, isComplete: isComplete, error: error)
    }
  }

  private func received(_ content: Data?, isComplete: Bool, error: NWError?) {
    isReceiving = false
    guard !isFinished else { return }
    if let content, !content.isEmpty {
      unackedBytes += content.count
      emit(eventData, ["id": id, "data": content.base64EncodedString()])
    }
    if let error {
      finish(error: "\(error)")
    } else if isComplete {
      finish(error: nil)
    } else {
      receiveIfAllowed()
    }
  }

  /// Ends the socket once: onError (if `error`) then onClose. Later calls do nothing.
  private func finish(error: String?) {
    guard !isFinished else { return }
    isFinished = true
    release()
    if let error { emit(eventError, ["id": id, "message": error]) }
    emit(eventClose, ["id": id])
  }

  private func release() {
    connection.stateUpdateHandler = nil
    connection.cancel()
    onFinished()
  }
}

private func invalidConnectArgs(host: String, port: Int, timeoutMs: Int) -> String? {
  if host.trimmingCharacters(in: .whitespaces).isEmpty { return "connect: host is empty" }
  if !(1...65535).contains(port) { return "connect: port \(port) is outside 1-65535" }
  if timeoutMs <= 0 { return "connect: timeoutMs must be positive, got \(timeoutMs)" }
  return nil
}

/// Accepts "[::1]" as well as "::1" for IPv6 literals.
private func stripBrackets(_ host: String) -> String {
  guard host.hasPrefix("["), host.hasSuffix("]") else { return host }
  return String(host.dropFirst().dropLast())
}
