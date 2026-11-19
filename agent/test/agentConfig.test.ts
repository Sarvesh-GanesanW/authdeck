/**
 * agent.json and link-key shared by several processes (the desktop app or the agent, and the
 * command line), and a real agent started on a temporary AUTHDECK_HOME.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { startAgent } from '../src/agent';
import { AGENT_LOCK_WAIT_MS, loadConfig, loadLinkKey, saveConfig, updateConfig } from '../src/config';
import { Pairing } from '../src/pairing';
import type { AgentEvent } from '../src/events';
import { connectDevice, newDeviceKey, pairByQr } from './helpers/link';

const SRC = path.join(import.meta.dirname, '..', 'src');
const homes: string[] = [];
const tempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-config-'));
  homes.push(home);
  return home;
};
after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

/** Runs a snippet in a separate Node process with the agent's source; resolves with its stdout. */
function inChild(code: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, ...env }, cwd: path.join(SRC, '..') });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('exit', (status) => (status === 0 ? resolve(out) : reject(new Error(`child exited ${status}: ${err}`))));
  });
}

/**
 * Waits for `condition`. The timeout is only a backstop for a broken test, generous enough that
 * machine load never trips it; tests wait on what they need, never on a fixed time.
 */
const until = (condition: () => boolean, what: string, timeoutMs = 30_000) =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(check, 20);
    };
    check();
  });

/**
 * A start line for child processes: each child marks itself ready and spins until the parent says
 * go, so they really run at once however long each takes to start under load.
 */
function startLine(count: number): { childCode: string; release: () => Promise<void> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-barrier-'));
  homes.push(dir);
  const childCode = `{
    const fs = await import('node:fs');
    fs.writeFileSync(${JSON.stringify(dir)} + '/ready-' + process.pid, '');
    while (!fs.existsSync(${JSON.stringify(dir)} + '/go')) {}
  }`;
  const release = async () => {
    await until(() => fs.readdirSync(dir).filter((n) => n.startsWith('ready-')).length === count, `${count} children ready`);
    fs.writeFileSync(path.join(dir, 'go'), '');
  };
  return { childCode, release };
}

describe('agent.json written by several processes', () => {
  it('devices --revoke-all sticks while the running agent keeps writing lastSeenAt', async () => {
    const home = tempHome();
    const seeded = loadConfig(home);
    saveConfig(home, { ...seeded, devices: [{ deviceId: 'stolen-phone', deviceName: 'Phone', linkKey: 'k', pairedAt: 'x', lastSeenAt: 'x' }] });
    // The running agent's side: lastSeenAt writes, as many as it can, from its first write until
    // the revoke is done. It says when it has started, so the revoke lands while it writes.
    const started = path.join(home, 'writer-started');
    const stop = path.join(home, 'writer-stop');
    const writer = inChild(
      `import fs from 'node:fs';
       import { updateConfig } from ${JSON.stringify(path.join(SRC, 'config.ts'))};
       let writes = 0;
       while (!fs.existsSync(process.env.STOP) && writes < 1_000_000) {
         updateConfig(process.env.HOME_DIR, (c) => { for (const d of c.devices) d.lastSeenAt = new Date().toISOString(); });
         if (++writes === 10) fs.writeFileSync(process.env.STARTED, '');
       }
       process.stdout.write(String(writes));`,
      { HOME_DIR: home, STARTED: started, STOP: stop },
    );
    await until(() => fs.existsSync(started), 'the writer to be writing');
    updateConfig(home, (latest) => (latest.devices = []));
    fs.writeFileSync(stop, '');
    assert.ok(Number(await writer) >= 10, 'the writer really was writing');
    assert.deepEqual(loadConfig(home).devices, []);
  });

  it('two first starts at once end up with one link key', async () => {
    const home = tempHome();
    const line = startLine(4);
    const code = `import { loadLinkKey } from ${JSON.stringify(path.join(SRC, 'config.ts'))};
      ${line.childCode}
      process.stdout.write(Buffer.from(loadLinkKey(process.env.HOME_DIR).public).toString('hex'));`;
    const running = Array.from({ length: 4 }, () => inChild(code, { HOME_DIR: home }));
    await line.release();
    const keys = await Promise.all(running);
    assert.equal(new Set(keys).size, 1, keys.join(' '));
    assert.equal(Buffer.from(loadLinkKey(home).public).toString('hex'), keys[0]);
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith('.tmp')), []);
  });

  it('two first starts at once agree on the agent id', async () => {
    const home = tempHome();
    const line = startLine(4);
    const code = `import { loadConfig } from ${JSON.stringify(path.join(SRC, 'config.ts'))};
      ${line.childCode}
      process.stdout.write(loadConfig(process.env.HOME_DIR).agentId);`;
    const running = Array.from({ length: 4 }, () => inChild(code, { HOME_DIR: home }));
    await line.release();
    const ids = await Promise.all(running);
    assert.equal(new Set(ids).size, 1, ids.join(' '));
  });
});

describe('a running agent', () => {
  it('replaces the pairing secrets on start, never logs them, and drops devices revoked from the command line', async () => {
    const home = tempHome();
    const before = loadConfig(home);
    saveConfig(home, { ...before, pin: '424242', pairSecret: 'old-secret-from-the-last-run', pairingOpenUntil: Date.now() + 3_600_000 });
    process.env.AUTHDECK_HOME = home;
    const lines: string[] = [];
    const events: AgentEvent[] = [];
    const agent = await startAgent({ port: 0, dryRun: true, onEvent: (event) => events.push(event) }, (line) => lines.push(line));
    try {
      const started = loadConfig(home);
      assert.notEqual(started.pin, '424242');
      assert.notEqual(started.pairSecret, 'old-secret-from-the-last-run');
      assert.equal(agent.pairingWindow(), null, 'pairing starts closed');

      const window = agent.openPairing();
      const device = newDeviceKey();
      (await pairByQr(agent.port, loadLinkKey(home).public, window.pairSecret, device, { deviceId: 'pad', deviceName: 'Pad' })).close();
      assert.equal(agent.pairingWindow(), null, 'the agent closes pairing itself after a pairing');
      const log = lines.join('\n');
      for (const secret of [started.pin, started.pairSecret, window.pin, window.pairSecret]) assert.equal(log.includes(secret), false, 'a secret reached the log');

      const session = await connectDevice(agent.port, device, loadLinkKey(home).public);
      // `authdeck-agent devices --revoke-all`, from another process.
      await inChild(`import { updateConfig } from ${JSON.stringify(path.join(SRC, 'config.ts'))}; updateConfig(process.env.HOME_DIR, (c) => { c.devices = []; });`, { HOME_DIR: home });
      await session.closed;
      await until(() => events.some((e) => e.type === 'device.revoked' && e.deviceId === 'pad'), 'device.revoked');

      agent.closePairing();
      assert.equal(agent.pairingWindow(), null);
    } finally {
      await agent.stop();
      delete process.env.AUTHDECK_HOME;
    }
  });
});

describe('the computer name', () => {
  it('a name changed in agent.json is the one discovery and the handshake give, as the QR code does', async () => {
    const home = tempHome();
    loadConfig(home);
    process.env.AUTHDECK_HOME = home;
    const agent = await startAgent({ port: 0, dryRun: true }, () => {});
    try {
      updateConfig(home, (c) => (c.name = 'Renamed Mac'));
      // Wait for the config watch to pick the new name up, however long load makes that take.
      let hello = { name: '' };
      const backstop = performance.now() + 30_000;
      while (hello.name !== 'Renamed Mac' && performance.now() < backstop) {
        hello = (await (await fetch(`http://127.0.0.1:${agent.port}/authdeck/hello`)).json()) as { name: string };
        if (hello.name !== 'Renamed Mac') await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(hello.name, 'Renamed Mac', 'the config watch picks up the new name');
      const window = agent.openPairing();
      const device = await pairByQr(agent.port, loadLinkKey(home).public, window.pairSecret, newDeviceKey(), { deviceId: 'pad', deviceName: 'Pad' });
      assert.equal(device.agent.name, 'Renamed Mac');
      device.close();
    } finally {
      await agent.stop();
    }
  });
});

describe('authdeck-agent pair', () => {
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    it(`closes pairing when its terminal closes or it is killed (${signal})`, { skip: process.platform === 'win32' }, async () => {
      const home = tempHome();
      loadConfig(home);
      process.env.AUTHDECK_HOME = home;
      const agent = await startAgent({ port: 0, dryRun: true }, () => {});
      try {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', `import { runPairCommand } from ${JSON.stringify(path.join(SRC, 'pairCommand.ts'))};
           await runPairCommand(process.env.HOME_DIR, ${agent.port}, (text) => process.stdout.write(text + '\\n'));`],
          { env: { ...process.env, HOME_DIR: home }, cwd: path.join(SRC, '..') },
        );
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        await until(() => agent.pairingWindow() !== null && out.includes('PIN'), 'pairing to open', 10_000);
        const shownPin = agent.pairingWindow()!.pin;
        child.kill(signal);
        const status = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
        assert.equal(status, 0);
        assert.equal(agent.pairingWindow(), null);
        assert.notEqual(loadConfig(home).pin, shownPin, 'the PIN it showed works no more');
        assert.match(out, /Pairing closed\./);
      } finally {
        await agent.stop();
      }
    });
  }
});

describe('the agent.json lock', () => {
  const lockOf = (home: string) => path.join(home, 'agent.json.lock');
  const withDevice = (home: string) => updateConfig(home, (c) => (c.devices = [{ deviceId: 'stolen-phone', deviceName: 'Phone', linkKey: 'k', pairedAt: '', lastSeenAt: '' }]));
  const agentPairing = (home: string) =>
    new Pairing({ load: () => loadConfig(home), update: (change) => updateConfig(home, change, AGENT_LOCK_WAIT_MS), newPin: () => '111111', newPairSecret: () => 'x' });
  /** The pid of a process that has exited. */
  const deadPid = async () => {
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => child.on('exit', resolve));
    return child.pid!;
  };

  it('a lock left a moment ago by a writer that died is taken over at once (the review PoC)', async () => {
    const home = tempHome();
    withDevice(home);
    for (const text of [JSON.stringify({ pid: await deadPid(), nonce: 'n' }), String(await deadPid())]) {
      fs.writeFileSync(lockOf(home), text);
      // "At once": taken over on the first look, with no waiting rounds. Counted on a clock the
      // test drives (each reading moves it 5 ms), not on wall time, which load stretches.
      const realNow = Date.now;
      const start = realNow();
      let virtual = start;
      Date.now = () => (virtual += 5);
      try {
        assert.equal(agentPairing(home).revoke('stolen-phone'), true);
      } finally {
        Date.now = realNow;
      }
      assert.ok(virtual - start < 100, `waited ${virtual - start} ms of its clock`);
      assert.deepEqual(loadConfig(home).devices, []);
      assert.equal(fs.existsSync(lockOf(home)), false);
      withDevice(home);
    }
  });

  it('a lock held by a live, stuck process makes the agent fail fast, never freeze; it is taken over once stale', async () => {
    const home = tempHome();
    withDevice(home);
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    try {
      fs.writeFileSync(lockOf(home), JSON.stringify({ pid: holder.pid, nonce: 'theirs' }));
      // The wait is synchronous, so "fails fast" is measured by the deadline it gives up at, on a
      // clock the test drives (each reading moves it 5 ms), not by wall time, which machine load
      // stretches. The agent must give up at its own short wait, never the command line's 3 s.
      const realNow = Date.now;
      const start = realNow();
      let virtual = start;
      let readings = 0;
      Date.now = () => {
        readings++;
        return (virtual += 5);
      };
      const wallStart = performance.now();
      let gaveUpAt: number;
      try {
        assert.throws(() => agentPairing(home).revoke('stolen-phone'), /Another AuthDeck process is changing/);
        gaveUpAt = virtual - start;
      } finally {
        Date.now = realNow;
      }
      const wall = performance.now() - wallStart;
      assert.ok(gaveUpAt >= AGENT_LOCK_WAIT_MS && gaveUpAt < AGENT_LOCK_WAIT_MS + 100, `gave up after ${gaveUpAt} ms of its clock`);
      assert.ok(readings < 400, `read the clock ${readings} times`);
      assert.ok(wall < 5000, `backstop: the wait took ${Math.round(wall)} ms of wall time`);
      assert.equal(loadConfig(home).devices.length, 1, 'the caller is told; the desktop shows the error');
      // Once the call returns, the event loop runs again.
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 10);
      await new Promise((resolve) => setTimeout(resolve, 1700));
      clearInterval(ticker);
      assert.ok(ticks > 0, 'the event loop ran after the agent gave up');
      assert.equal(agentPairing(home).revoke('stolen-phone'), true, 'a lock held that long is stale');
    } finally {
      holder.kill();
    }
  });

  it('is released only by its owner: a lock taken over meanwhile stays', () => {
    const home = tempHome();
    const theirs = JSON.stringify({ pid: process.pid, nonce: 'someone-else' });
    updateConfig(home, () => {
      fs.rmSync(lockOf(home));
      fs.writeFileSync(lockOf(home), theirs);
    });
    assert.equal(fs.readFileSync(lockOf(home), 'utf8'), theirs);
    fs.rmSync(lockOf(home));
  });

  it('several waiters finding one stale lock lose no write (the review PoC)', async () => {
    for (let round = 0; round < 3; round++) {
      const home = tempHome();
      loadConfig(home);
      fs.writeFileSync(lockOf(home), '99999');
      const old = new Date(2020, 0, 1);
      fs.utimesSync(lockOf(home), old, old);
      const line = startLine(6);
      const writers = Array.from({ length: 6 }, (_, i) =>
        inChild(
          `import { updateConfig } from ${JSON.stringify(path.join(SRC, 'config.ts'))};
           ${line.childCode}
           updateConfig(process.env.HOME_DIR, (c) => {
             const t = Date.now() + 30; while (Date.now() < t) {}
             c.devices.push({ deviceId: 'dev${i}', deviceName: 'dev${i}', pairedAt: '', lastSeenAt: '' });
           });`,
          { HOME_DIR: home },
        ),
      );
      await line.release();
      await Promise.all(writers);
      assert.equal(loadConfig(home).devices.length, 6, `round ${round}`);
    }
  });
});
