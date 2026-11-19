// Engine scenarios for the review-7 fixes, one per process: `node --import tsx scenarios.mts <name>`.
// Each prints `RESULT <json>` for engineScenarios.test.ts to check. No secrets are printed.
// Loaded by URL: the app's tsc config takes no `.mts` import paths.
const { actions, bootComputer, core, engineAs, engineMod, helpers, message, recoveryIdOf, secureStub, sleep, syncNow, view } = await import(new URL('./harness.mts', import.meta.url).href);

const fsMod = await import('node:fs');
const osMod = await import('node:os');
const pathMod = await import('node:path');
const name = process.argv[2];
const pc = bootComputer(name ?? 'x');
const stop = engineMod.startVaultEngine();
await sleep(300);
const out: Record<string, unknown> = {};
const ACCOUNT = { issuer: 'Example', label: 'a', secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, counter: 0 };

async function setUp() {
  const made = await actions.createVault('Home');
  await actions.confirmRecoverySaved(made.flow);
  await actions.addAccounts([ACCOUNT]);
  await syncNow(800);
  const vaultId: string = pc.store.list()[0].vaultId;
  return { words: made.phrase as string[], vaultId };
}

/** A second install of the app on empty storage (a new phone); the first phone's engine must be stopped. */
async function newPhone(tag: string) {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as any;
  for (const key of await AsyncStorage.getAllKeys()) await AsyncStorage.removeItem(key);
  (secureStub.__secure as Map<string, string>).clear();
  const phone = await engineAs(tag);
  const stopPhone = phone.startVaultEngine();
  await sleep(300);
  return { actions: phone.engineActions, stop: stopPhone };
}

/** Copies the vault folder aside, and puts a copy back (a computer serving an older folder). */
function folderSnapshots(vaultId: string) {
  const { mkdtempSync, cpSync, rmSync } = fsMod;
  const dir = pathMod.join(pc.home, 'vault', vaultId);
  const saved = new Map<string, string>();
  return {
    take(label: string) {
      const to = mkdtempSync(pathMod.join(osMod.tmpdir(), `authdeck-snap-${label}-`));
      cpSync(dir, to, { recursive: true });
      saved.set(label, to);
    },
    put(label: string) {
      rmSync(dir, { recursive: true, force: true });
      cpSync(saved.get(label)!, dir, { recursive: true });
    },
    cleanup() {
      for (const to of saved.values()) rmSync(to, { recursive: true, force: true });
    },
  };
}

switch (name) {
  case 'stop-then-normal': {
    const { words, vaultId } = await setUp();
    const abandoned = await actions.replaceVaultWithoutPhrase();
    actions.endRecoveryFlow(abandoned.flow); // "Stop"
    const next = await actions.newRecoveryPhrase(words);
    out.confirm = await message(actions.confirmRecoverySaved(next.flow));
    await syncNow(800);
    out.vaults = pc.store.list().map((v: any) => ({ same: v.vaultId === vaultId, retired: Boolean(v.retired) }));
    out.recoveryIsNew = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(next.phrase, vaultId);
    out.retires = pc.retires.length;
    break;
  }
  case 'stop-then-replace-again': {
    const { vaultId } = await setUp();
    const first = await actions.replaceVaultWithoutPhrase();
    actions.endRecoveryFlow(first.flow);
    const second = await actions.replaceVaultWithoutPhrase();
    out.staleConfirm = await message(actions.confirmRecoverySaved(first.flow));
    out.confirm = await message(actions.confirmRecoverySaved(second.flow));
    await syncNow(800);
    const live = pc.store.list().filter((v: any) => !v.retired);
    out.live = live.length;
    out.oldRetired = pc.store.list().some((v: any) => v.vaultId === vaultId && v.retired);
    out.newPhraseIsSecond = live.length === 1 && pc.stateOf(live[0].vaultId).recovery?.deviceId === recoveryIdOf(second.phrase, live[0].vaultId);
    out.accounts = view().accounts.length;
    break;
  }
  case 'replace-stop-reopen': {
    const { vaultId } = await setUp();
    const first = await actions.replaceVaultWithoutPhrase();
    actions.endRecoveryFlow(first.flow); // closed
    // Reopened: a new surface has no flow until it makes one; the old token confirms nothing.
    out.staleConfirm = await message(actions.confirmRecoverySaved(first.flow));
    await syncNow(800);
    out.vaults = pc.store.list().map((v: any) => ({ same: v.vaultId === vaultId, retired: Boolean(v.retired) }));
    out.retires = pc.retires.length;
    break;
  }
  case 'replacement-resumes-on-unlock': {
    // Integration 1: "I don't have my phrase" stopped part-way (the computer refused the new vault's
    // lines), then the vault was locked. Unlocking finishes it at once, with no vault change and no
    // reconnect; meanwhile Backup says the new phrase is being finished.
    const { vaultId } = await setUp();
    const made = await actions.replaceVaultWithoutPhrase();
    pc.hooks.beforeAppend = () => 'refuse';
    out.firstTry = await message(actions.confirmRecoverySaved(made.flow).then(() => 'saved'));
    out.finishingShown = view().recovery.finishing === true;
    actions.lock();
    pc.hooks.beforeAppend = undefined;
    await sleep(300);
    out.stillPending = view().recovery.finishing === true;
    await actions.unlock();
    await sleep(1500);
    out.finishedAfterUnlock = view().recovery.finishing !== true && view().recovery.savedAt !== null;
    out.vaults = pc.store.list().map((v: any) => ({ same: v.vaultId === vaultId, retired: Boolean(v.retired) }));
    break;
  }
  case 'never-set-phrase': {
    // Integration 4: setup stopped before the phrase was checked: Backup offers to set one up.
    const made = await actions.createVault('Home');
    out.neverSet = view().recovery.neverSet === true;
    await actions.confirmRecoverySaved(made.flow);
    out.afterCheck = view().recovery.neverSet === true;
    break;
  }
  case 'check-with-nothing': {
    await setUp();
    out.noFlow = await message(actions.confirmRecoverySaved('made-up-token'));
    break;
  }
  case 'refused-phrase-change': {
    // A1 + A2: the computer refuses R's lines. The change is kept and resent, never signed twice;
    // a second change is refused while it is pending; "saved" only once the folder shows it.
    const { words, vaultId } = await setUp();
    const rOld = recoveryIdOf(words, vaultId);
    const seen = new Set<string>();
    pc.hooks.beforeAppend = (entries: any[]) => {
      const r = entries.filter((e: any) => e.author === rOld);
      r.forEach((e: any) => seen.add(`${e.seq}:${e.sig}`));
      return r.length > 0 ? 'refuse' : 'pass';
    };
    const made = await actions.newRecoveryPhrase(words);
    out.first = await message(actions.confirmRecoverySaved(made.flow));
    out.second = await message(actions.confirmRecoverySaved(made.flow));
    out.pendingShown = view().recovery.pending === true;
    out.another = await message(actions.newRecoveryPhrase(words));
    out.replace = await message(actions.replaceVaultWithoutPhrase());
    pc.hooks.beforeAppend = undefined;
    await syncNow(1200);
    out.distinctLines = seen.size;
    out.applied = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(made.phrase, vaultId);
    out.pendingAfter = view().recovery.pending === true;
    out.savedAtSet = view().recovery.savedAt !== null;
    break;
  }
  case 'dropped-phrase-change': {
    // A3: the computer answers ok and stores nothing.
    const { words, vaultId } = await setUp();
    const rOld = recoveryIdOf(words, vaultId);
    const savedBefore = view().recovery.savedAt;
    pc.hooks.beforeAppend = (entries: any[]) => (entries.some((e: any) => e.author === rOld) ? 'drop' : 'pass');
    const made = await actions.newRecoveryPhrase(words);
    out.confirm = await message(actions.confirmRecoverySaved(made.flow));
    out.savedAtMoved = view().recovery.savedAt !== savedBefore;
    out.pendingShown = view().recovery.pending === true;
    actions.lock();
    out.unlockNew = await message(actions.unlockWithPhrase(made.phrase));
    actions.lock();
    out.unlockOld = await message(actions.unlockWithPhrase(words));
    pc.hooks.beforeAppend = undefined;
    await syncNow(1200);
    out.applied = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(made.phrase, vaultId);
    out.savedAtMovedAfter = view().recovery.savedAt !== savedBefore;
    actions.lock();
    out.unlockOldAfter = await message(actions.unlockWithPhrase(words));
    break;
  }
  case 'replace-retires': {
    // B1: the old vault is set aside (signed by this device for this computer), kept and still restorable.
    const { words, vaultId } = await setUp();
    const made = await actions.replaceVaultWithoutPhrase();
    out.confirm = await message(actions.confirmRecoverySaved(made.flow));
    const old = pc.store.list().find((v: any) => v.vaultId === vaultId);
    out.oldKept = Boolean(old?.retired);
    out.keptDays = old?.retired ? Math.round((old.retired.keptUntil - old.retired.at) / 86_400_000) : null;
    out.oldPhraseStillOpens = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(words, vaultId);
    out.retireSigned = pc.retires.every((r: any) => r.request.agentId === 'test-agent-1' && typeof r.request.sig === 'string');
    break;
  }
  case 'solo-no-seal-proofs': {
    // Low: a solo vault keeps and shares no seal proofs, even ones the computer serves.
    const { vaultId } = await setUp();
    const { loadSealProofs } = await import(new URL('../../src/auth/engine/localCopy.ts', import.meta.url).href);
    const head = pc.stateOf(vaultId).history.at(-1);
    pc.hooks.extraSealProofs = [{ entry: head.hash, to: head.author, proof: 'A'.repeat(128) }];
    await syncNow(1000);
    await actions.addAccounts([{ ...ACCOUNT, label: 'b' }]);
    await syncNow(1000);
    out.kept = (await loadSealProofs(vaultId)).length;
    out.sealWrites = pc.forkWrites.filter((w: any) => w.sealProof !== undefined).length;
    out.accounts = view().accounts.length;
    break;
  }
  case 'phrase-change-lost': {
    // A1.2 in the engine: the computer stores another version of R's line at that seq (signed with
    // the same old phrase) in place of the app's. The app's change lost: it says which phrase works,
    // forgets the change, and a new change can start.
    const { words, vaultId } = await setUp();
    const rKeys = core.recovery.recoveryKeysFromPhrase(words.join(' '), vaultId);
    const { randomBytes } = await import('node:crypto');
    const random = (n: number) => new Uint8Array(randomBytes(n));
    let otherWords: string[] | null = null;
    pc.hooks.beforeAppend = (entries: any[]) => {
      if (!entries.some((e: any) => e.author === rKeys.deviceId) || otherWords) return 'pass';
      const state = pc.stateOf(vaultId);
      const opened = core.open.openVault(state, rKeys);
      otherWords = core.recovery.generateRecoveryPhrase(random).split(' ');
      const other = core.recovery.buildRecoverySetFromPhrase(state, rKeys, { phrase: otherWords!.join(' '), currentKey: opened.currentKey, random, time: Date.now() });
      pc.store.append(vaultId, [other.entry], false);
      return 'drop';
    };
    const made = await actions.newRecoveryPhrase(words);
    out.confirm = await message(actions.confirmRecoverySaved(made.flow));
    pc.hooks.beforeAppend = undefined;
    for (let i = 0; i < 4; i++) await syncNow(800);
    out.pending = view().recovery.pending === true;
    out.otherCounts = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(otherWords!, vaultId);
    out.oursCounts = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(made.phrase, vaultId);
    out.toasts = pc.toasts;
    out.next = await message(actions.newRecoveryPhrase(made.phrase).then((m: any) => actions.confirmRecoverySaved(m.flow)));
    out.warnings = view().warnings.map((w: any) => w.text).filter((t: string) => /Remove that device/i.test(t)).length;
    break;
  }
  case 'damaged-phrase-change': {
    // Low: the stored record of a pending phrase change is damaged. The app says so once and lets a
    // new phrase be made, instead of forgetting it silently.
    const { words, vaultId } = await setUp();
    const rOld = recoveryIdOf(words, vaultId);
    pc.hooks.beforeAppend = (entries: any[]) => (entries.some((e: any) => e.author === rOld) ? 'refuse' : 'pass');
    const made = await actions.newRecoveryPhrase(words);
    await message(actions.confirmRecoverySaved(made.flow));
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as any;
    const keys = (await AsyncStorage.getAllKeys()).filter((k: string) => k.includes(recoveryIdOf(made.phrase, vaultId)) || k.includes(rOld));
    for (const key of keys) await AsyncStorage.setItem(key, '{"damaged":');
    out.damagedKeys = keys.length;
    pc.hooks.beforeAppend = undefined;
    await syncNow(1000);
    await syncNow(800);
    out.told = pc.toasts.filter((t: string) => t.includes("couldn't be read back")).length;
    out.pending = view().recovery.pending === true;
    // The change this device acked still reaches the folder from its copy; the words written down for it work.
    out.applied = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(made.phrase, vaultId);
    out.next = await message(actions.newRecoveryPhrase(made.phrase).then((m: any) => actions.confirmRecoverySaved(m.flow)));
    break;
  }
  case 'restore-after-thief-deletes':
  case 'restore-after-thief-deletes-clock': {
    // P3 and Q3: a thief past the lock deletes Bank and Mail, renames Shop, adds 55 junk accounts
    // (so those lines are older than the last 50), then renames Edit and deletes it. The owner
    // restores on a new phone. Every delete is offered back whatever its age, newest first by seq,
    // and Edit comes back as it was before the rename; the old rename of Shop is past the last 50
    // lines and is not offered. Bringing them back restores the accounts and their secrets.
    const made = await actions.createVault('Home');
    await actions.confirmRecoverySaved(made.flow);
    await actions.addAccounts([
      { ...ACCOUNT, issuer: 'Bank', label: 'owner' },
      { ...ACCOUNT, issuer: 'Mail', label: 'owner', secret: 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U' },
      { ...ACCOUNT, issuer: 'Shop', label: 'owner' },
      { ...ACCOUNT, issuer: 'Edit', label: 'owner' },
    ]);
    await syncNow(800);
    const before = view().accounts.map((a: any) => ({ issuer: a.issuer, label: a.label }));
    const byIssuer = (issuer: string) => view().accounts.find((a: any) => a.issuer === issuer);
    await actions.deleteAccount(byIssuer('Bank').id);
    await actions.deleteAccount(byIssuer('Mail').id);
    await actions.renameAccount(byIssuer('Shop').id, 'Shop', 'thief');
    // Q3: with `-clock`, the thief moves the phone's clock 31 days on first; nothing offered depends on it.
    const realNow = Date.now;
    if (name.endsWith('-clock')) Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000;
    await actions.addAccounts(Array.from({ length: 55 }, (_, i) => ({ ...ACCOUNT, issuer: `Junk ${i}`, label: 'thief' })));
    await actions.renameAccount(byIssuer('Edit').id, 'Edit', 'thief');
    await actions.deleteAccount(byIssuer('Edit').id);
    await syncNow(800);
    Date.now = realNow;
    stop();
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as any;
    for (const key of await AsyncStorage.getAllKeys()) await AsyncStorage.removeItem(key);
    (secureStub.__secure as Map<string, string>).clear();
    const B = await engineAs('B');
    const stopB = B.startVaultEngine();
    await sleep(300);
    out.restored = await message(B.engineActions.restoreWithPhrase(made.phrase));
    await syncNow(1000);
    const offered = view().caughtChanges;
    out.offered = offered.map((c: any) => `${c.origin}:${c.text}`);
    out.accountsBefore = view().accounts.length;
    out.bringBack = await message(B.engineActions.reapplyCaughtChanges(offered.map((c: any) => c.id)));
    await syncNow(1000);
    out.after = view().accounts.filter((a: any) => !a.issuer.startsWith('Junk')).map((a: any) => ({ issuer: a.issuer, label: a.label })).sort((x: any, y: any) => (x.issuer < y.issuer ? -1 : 1));
    out.before = before.sort((x: any, y: any) => (x.issuer < y.issuer ? -1 : 1));
    const opened = core.open.openVault(pc.stateOf(pc.store.list()[0].vaultId), core.recovery.recoveryKeysFromPhrase(made.phrase.join(' '), pc.store.list()[0].vaultId));
    out.mailSecretBack = Object.values(opened.accounts).some((a: any) => a.record.issuer === 'Mail' && a.record.secret === 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U');
    out.offeredAfter = view().caughtChanges.length;
    stopB();
    break;
  }
  case 'restore-flip-before-ack':
  case 'restore-flip-after-ack': {
    // P1b: the computer keeps refused restore attempts and writes the lowest-hashing one in, with a
    // proof, before or after the adopted restore's ack (a line past its hello) lands. Before: the
    // engine sees its restore lost and signs it again on top of the winner. After: the kept attempt
    // loses (rule A1.2 3).
    const { randomBytes } = await import('node:crypto');
    const random = (n: number) => new Uint8Array(randomBytes(n));
    const { serializeEntry, entryHash } = core.entry;
    const P = helpers.device(random);
    const v = helpers.MemoryVault.found(P, random, 'solo');
    const phrase: string = core.recovery.generateRecoveryPhrase(random);
    const set = core.recovery.buildRecoverySetFromPhrase(v.state(), P, { phrase, currentKey: v.key, random, time: Date.now() - 60_000 });
    v.write(set.entry);
    v.write(core.build.buildAccountPut(v.state(), P, { account: core.build.newAccountId(random), record: helpers.totpRecord(), currentKey: set.newKey, random, time: Date.now() - 50_000 }));
    pc.store.append(v.vaultId, v.logs[P.deviceId].map((l: string) => JSON.parse(l)), false);
    const vaultId: string = v.vaultId;
    const R = recoveryIdOf(phrase.split(' '), vaultId);
    // Kept attempts until one hashes below anything B can sign is likely; the lowest is used.
    const kept = Array.from({ length: 16 }, () => {
      const A = helpers.device(random);
      return { A, lines: helpers.soloRestoreLines(vaultId, pc.logsOf(vaultId), phrase, A, random, Date.now() - 40_000) };
    }).sort((x, y) => (entryHash(x.lines[0]) < entryHash(y.lines[0]) ? -1 : 1));
    let flipped = false;
    let bAdd: any = null;
    const flip = () => {
      bAdd = JSON.parse(pc.logsOf(vaultId)[R][0]);
      // The lowest kept attempt (it hashes below B's add 16 times in 17; either way B must keep the vault).
      const best = kept[0]!;
      const [addA, helloA, rotateA] = best.lines;
      pc.writeLog(vaultId, R, [serializeEntry(addA), serializeEntry(rotateA)]);
      pc.writeLog(vaultId, best.A.deviceId, [serializeEntry(helloA)]);
      pc.writeForkFile(vaultId, { deviceId: R, seq: addA.seq, lines: [serializeEntry(addA), serializeEntry(bAdd)] });
      out.flipAgainst = best.A.deviceId;
      return (flipped = true);
    };
    const before = name === 'restore-flip-before-ack';
    // Before: the flip lands just as B's first line past its hello arrives, and that line is dropped.
    if (before) pc.hooks.beforeAppend = (entries: any[]) => (!flipped && entries.some((e: any) => e.kind === 'device.rename') && flip() ? 'drop' : 'pass');
    out.restored = await message(actions.restoreWithPhrase(phrase.split(' ')));
    pc.hooks.beforeAppend = undefined;
    await syncNow(800);
    if (!before) {
      out.ackInFolder = Object.entries(pc.logsOf(vaultId)).some(([id, lines]) => id !== R && (lines as string[]).some((l) => JSON.parse(l).kind === 'device.rename'));
      flip();
      await syncNow(1200);
    }
    out.flipped = flipped;
    const st = pc.stateOf(vaultId);
    const live = Object.values(st.members).filter((m: any) => !m.removed).map((m: any) => m.deviceId);
    out.keptAttemptIn = live.includes(out.flipAgainst);
    out.thisDeviceIn = view().status === 'open' && live.length === 1 && !out.keptAttemptIn;
    out.add = await message(actions.addAccounts([{ ...ACCOUNT, label: 'after' }]).then(() => 'ok'));
    await syncNow(800);
    out.accounts = view().accounts.length;
    delete out.flipAgainst;
    break;
  }
  case 'phrase-change-rewound': {
    // Q1: R never signs on a rewound copy. The folder is put back to before this phone's last change,
    // then "make a new phrase" is asked for: refused with the older-copy message, nothing signed. Once
    // the computer serves the whole folder again, the same request works.
    const { words, vaultId } = await setUp();
    const R = recoveryIdOf(words, vaultId);
    const snaps = folderSnapshots(vaultId);
    snaps.take('before');
    await actions.addAccounts([{ ...ACCOUNT, issuer: 'Later' }]);
    await syncNow(800);
    snaps.take('after');
    snaps.put('before');
    const rLines = (pc.logsOf(vaultId)[R] ?? []).length;
    out.refused = await message(actions.newRecoveryPhrase(words).then(() => 'made'));
    out.rSigned = (pc.logsOf(vaultId)[R] ?? []).length !== rLines;
    snaps.put('after');
    await syncNow(800);
    const next = await message(actions.newRecoveryPhrase(words));
    out.afterCatchUp = typeof next === 'string' ? next : 'made';
    snaps.cleanup();
    break;
  }
  case 'old-phrase-plus-phone-key': {
    // Q4: someone with the old phrase and the phone's signing key signs a competing phrase change
    // at the owner's phrase change's seq (ground below its hash) and has the phone's key name it,
    // all through the honest agent. Only the phone's earliest line naming a version at that seq
    // counts (its ack of the owner's change), so the owner's phrase stays and restores.
    const { randomBytes } = await import('node:crypto');
    const random = (n: number) => new Uint8Array(randomBytes(n));
    const { serializeEntry, entryHash } = core.entry;
    const secrets = await import(new URL('../../src/auth/engine/secrets.ts', import.meta.url).href);
    const { words, vaultId } = await setUp();
    const R1 = core.recovery.recoveryKeysFromPhrase(words.join(' '), vaultId);
    const beforeChange = pc.logsOf(vaultId);
    const changed = await actions.newRecoveryPhrase(words);
    await actions.confirmRecoverySaved(changed.flow);
    await syncNow(1200);
    const R2 = recoveryIdOf(changed.phrase, vaultId);
    const ownerSet = JSON.parse(pc.logsOf(vaultId)[R1.deviceId].at(-1));
    const P = await secrets.loadDeviceKeys();
    stop();
    const thiefPhrase: string = core.recovery.generateRecoveryPhrase(random);
    const before = core.replay.replayVault(vaultId, beforeChange);
    const opened = core.open.openVault(before, R1);
    let mine: any = null;
    let key: Uint8Array | null = null;
    for (let tries = 0; tries < 64 && !mine; tries++) {
      const built = core.recovery.buildRecoverySetFromPhrase(before, R1, { phrase: thiefPhrase, currentKey: opened.currentKey, random, time: Date.now() + tries });
      if (entryHash(built.entry) < entryHash(ownerSet)) {
        mine = built.entry;
        key = built.newKey;
      }
    }
    out.ground = mine !== null;
    const folder = pc.logsOf(vaultId);
    const thiefReading = core.replay.replayVault(vaultId, { ...folder, [R1.deviceId]: [...folder[R1.deviceId].slice(0, ownerSet.seq), serializeEntry(mine)] });
    const naming = core.build.buildDeviceRename(thiefReading, P, { device: P.deviceId, name: 'Phone', currentKey: key!, random, time: Date.now() });
    pc.store.append(vaultId, [naming], false);
    const forkProof = { deviceId: R1.deviceId, seq: ownerSet.seq, lines: [serializeEntry(ownerSet), serializeEntry(mine)] };
    // N1: the honest agent refuses it (the owner's ack built on that line); written in anyway, the ack still wins (Q4).
    out.honestRefused = await message(Promise.resolve().then(() => pc.store.writeFork(vaultId, forkProof)).then(() => 'taken'));
    pc.writeForkFile(vaultId, forkProof);
    out.ownerPhraseStands = pc.stateOf(vaultId).recovery?.deviceId === R2;
    const B = await newPhone('B');
    const restored = await message(B.actions.restoreWithPhrase(changed.phrase));
    out.ownerRestores = typeof restored === 'object' && restored.warning === null;
    B.stop();
    break;
  }
  case 'old-phrase-forks-restore-add': {
    // N1: after a restore onto P and an acked phrase change, someone with the OLD phrase signs a
    // phrase change at the restore's seq. The honest agent refuses the proof (P built on that line).
    // A hostile computer that writes it anyway takes the vault (the accepted limit); P then says a
    // phrase change from another copy of the phrase won, also while locked and on unlock (L2, L3).
    const { randomBytes } = await import('node:crypto');
    const random = (n: number) => new Uint8Array(randomBytes(n));
    const { serializeEntry } = core.entry;
    const { words, vaultId } = await setUp();
    const R0 = core.recovery.recoveryKeysFromPhrase(words.join(' '), vaultId);
    const beforeRestore = pc.logsOf(vaultId);
    stop();
    const P = await newPhone('P');
    await message(P.actions.restoreWithPhrase(words));
    await syncNow(800);
    const changed = await P.actions.newRecoveryPhrase(words);
    await P.actions.confirmRecoverySaved(changed.flow);
    await syncNow(1200);
    const pre = core.replay.replayVault(vaultId, beforeRestore);
    const opened = core.open.openVault(pre, R0);
    const thiefSet = core.recovery.buildRecoverySetFromPhrase(pre, R0, { phrase: core.recovery.generateRecoveryPhrase(random), currentKey: opened.currentKey, random, time: Date.now() }).entry;
    const proof = { deviceId: R0.deviceId, seq: 0, lines: [pc.logsOf(vaultId)[R0.deviceId][0], serializeEntry(thiefSet)] };
    out.honestRefused = await message(Promise.resolve().then(() => pc.store.writeFork(vaultId, proof)).then(() => 'taken'));
    out.honestKeepsOwner = pc.stateOf(vaultId).recovery?.deviceId === recoveryIdOf(changed.phrase, vaultId);
    // A hostile computer writes it in anyway.
    pc.writeForkFile(vaultId, proof);
    await syncNow(1500);
    await syncNow(1500);
    const said = (w: any) => w.kind === 'lost-own-line' && w.text.startsWith('Your recovery phrase was changed from another copy of your phrase');
    out.toldOpen = view().warnings.some(said);
    P.actions.lock();
    await sleep(50);
    out.toldLocked = view().warnings.some(said);
    out.unlock = await message(P.actions.unlock().then(() => 'opened'));
    P.stop();
    break;
  }
  case 'restore-among-vaults': {
    // Several vaults on the computer, three of them decoys with phrases of their own: the restore
    // finds the one this phrase restores without replaying the others, and again after a phrase change.
    const { randomBytes } = await import('node:crypto');
    const random = (n: number) => new Uint8Array(randomBytes(n));
    const { words, vaultId } = await setUp();
    for (let i = 0; i < 3; i++) {
      const F = helpers.device(random);
      const d = helpers.MemoryVault.found(F, random, 'solo');
      const set = core.recovery.buildRecoverySetFromPhrase(d.state(), F, { phrase: core.recovery.generateRecoveryPhrase(random), currentKey: d.key, random, time: Date.now() });
      d.write(set.entry);
      pc.store.append(d.vaultId, d.logs[F.deviceId].map((l: string) => JSON.parse(l)), false);
    }
    out.vaults = pc.store.list().length;
    const changed = await actions.newRecoveryPhrase(words);
    await actions.confirmRecoverySaved(changed.flow);
    await syncNow(1200);
    stop();
    const B = await newPhone('B');
    out.oldPhrase = await message(B.actions.restoreWithPhrase(words).then(() => 'restored'));
    out.newPhrase = await message(B.actions.restoreWithPhrase(changed.phrase).then(() => 'restored'));
    out.rightVault = Object.values(pc.stateOf(vaultId).members).filter((m: any) => !m.removed).length === 1 && view().accounts.length === 1;
    B.stop();
    break;
  }
  case 'restore-rewound': {
    // Q2: the computer rolls the folder back just as the restore's ack arrives, so a fresh read lacks
    // the restore. The phone never signs a second restore: it warns, keeps the vault here, and every
    // sync sends the same bytes again. Once the computer serves the folder honestly, the restore lands
    // (one add at R's seq) and the phone uses the vault.
    const { words, vaultId } = await setUp();
    const R = recoveryIdOf(words, vaultId);
    const snaps = folderSnapshots(vaultId);
    snaps.take('before');
    stop();
    const B = await newPhone('B');
    let rolled = false;
    pc.hooks.beforeAppend = (entries: any[]) => {
      if (rolled || !entries.some((e: any) => e.kind === 'device.rename')) return 'pass';
      snaps.put('before');
      rolled = true;
      return 'drop';
    };
    out.restored = await message(B.actions.restoreWithPhrase(words));
    out.warned = typeof (out.restored as any).warning === 'string' && (out.restored as any).warning.startsWith('This computer is showing an older copy of your vault');
    // While the computer keeps serving the older copy, the phone says so after a sync.
    pc.hooks.beforeAppend = () => 'drop';
    snaps.put('before');
    await syncNow(800);
    out.rollbackShown = typeof view().rollbackWarning === 'string';
    pc.hooks.beforeAppend = undefined;
    for (let i = 0; i < 3; i++) await syncNow(800);
    const R0 = (pc.logsOf(vaultId)[R] ?? []).filter((l: string) => JSON.parse(l).kind === 'device.add');
    out.addsAtR = R0.length;
    out.add = await message(B.actions.addAccounts([{ ...ACCOUNT, label: 'after' }]).then(() => 'ok'));
    await syncNow(800);
    const live = Object.values(pc.stateOf(vaultId).members).filter((m: any) => !m.removed);
    out.liveMembers = live.length;
    out.accounts = view().accounts.length;
    // L1: once the folder shows the restore and a line past the hello, its records are settled.
    await syncNow(800);
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as any;
    out.recordsLeft = (await AsyncStorage.getAllKeys()).filter((k: string) => /restore-v1|restore-attempts-v1/.test(k)).length;
    out.attemptKeysLeft = [...(secureStub.__secure as Map<string, string>).keys()].filter((k) => k.includes('restore_keys')).length;
    B.stop();
    snaps.cleanup();
    break;
  }
  case 'restore-adopts-earlier': {
    // Q2: the computer counts another device's restore against the first attempt (the phone signs
    // again on top of it), then serves the folder with the first attempt counting and without the
    // second. The phone adopts the first attempt with its kept keys; it never signs a third.
    const { randomBytes } = await import('node:crypto');
    const random = (n: number) => new Uint8Array(randomBytes(n));
    const { serializeEntry, entryHash } = core.entry;
    const { words, vaultId } = await setUp();
    const phrase = words.join(' ');
    const R = recoveryIdOf(words, vaultId);
    stop();
    const kept = Array.from({ length: 16 }, () => {
      const X = helpers.device(random);
      return { X, lines: helpers.soloRestoreLines(vaultId, pc.logsOf(vaultId), phrase, X, random, Date.now() - 40_000) };
    }).sort((x, y) => (entryHash(x.lines[0]) < entryHash(y.lines[0]) ? -1 : 1));
    const B = await newPhone('B');
    let renames = 0;
    let first: { R: string[]; device: string; log: string[] } | null = null;
    pc.hooks.beforeAppend = (entries: any[]) => {
      const rename = entries.find((e: any) => e.kind === 'device.rename');
      if (!rename) return 'pass';
      renames++;
      const logs = pc.logsOf(vaultId);
      if (renames === 1) {
        first = { R: logs[R]!, device: rename.author, log: logs[rename.author]! };
        const best = kept.find((k) => entryHash(k.lines[0]) < entryHash(JSON.parse(first!.R[0]!))) ?? kept[0]!;
        const [addX, helloX, rotateX] = best.lines;
        pc.writeLog(vaultId, R, [serializeEntry(addX), serializeEntry(rotateX)]);
        pc.writeLog(vaultId, best.X.deviceId, [serializeEntry(helloX)]);
        pc.writeForkFile(vaultId, { deviceId: R, seq: addX.seq, lines: [serializeEntry(addX), first.R[0]] });
        out.xDevice = best.X.deviceId;
        return 'drop';
      }
      if (renames === 2) {
        // The first attempt counts again; the second (on top of X) is gone.
        for (const id of Object.keys(logs)) if (id !== R && id !== first!.device && logs[id]!.length > 0 && JSON.parse(logs[id]![0]!).kind === 'device.hello' && id !== Object.keys(pc.stateOf(vaultId).members)[0]) fsMod.rmSync(pathMod.join(pc.home, 'vault', vaultId, 'log', `${id}.jsonl`), { force: true });
        pc.writeLog(vaultId, R, first!.R);
        pc.writeLog(vaultId, first!.device, first!.log);
        fsMod.rmSync(pathMod.join(pc.home, 'vault', vaultId, 'forks', `${R}.json`), { force: true });
        return 'drop';
      }
      return 'pass';
    };
    out.restored = await message(B.actions.restoreWithPhrase(words));
    pc.hooks.beforeAppend = undefined;
    await syncNow(1000);
    const st = pc.stateOf(vaultId);
    const live = Object.values(st.members).filter((m: any) => !m.removed).map((m: any) => m.deviceId);
    out.renames = renames;
    out.firstAttemptIn = live.length === 1 && live[0] === (first as any)?.device;
    out.thisDeviceIsFirst = view().devices?.find((d: any) => d.thisDevice)?.id === (first as any)?.device;
    out.add = await message(B.actions.addAccounts([{ ...ACCOUNT, label: 'after' }]).then(() => 'ok'));
    await syncNow(800);
    out.accounts = view().accounts.length;
    delete out.xDevice;
    B.stop();
    break;
  }
  case 'restore-lost-to-earlier': {
    // Q7 (the accepted limit, phone behaviour): B restored on an honest computer; C restores on a
    // folder rolled back past B's restore; the computer then serves B's restore with a proof. C says
    // so plainly, and deleting and restoring again on C signs on top of B's restore and takes B out.
    const { words, vaultId } = await setUp();
    const R = recoveryIdOf(words, vaultId);
    const snaps = folderSnapshots(vaultId);
    snaps.take('beforeB');
    stop();
    const B = await newPhone('B');
    await message(B.actions.restoreWithPhrase(words));
    for (const issuer of ['Mail', 'Shop', 'Chat']) await B.actions.addAccounts([{ ...ACCOUNT, issuer, label: 'B' }]);
    await syncNow(800);
    const real = pc.logsOf(vaultId);
    const Bid = (Object.values(pc.stateOf(vaultId).members).find((m: any) => !m.removed) as any).deviceId as string;
    B.stop();
    snaps.put('beforeB');
    const C = await newPhone('C');
    out.restoredC = await message(C.actions.restoreWithPhrase(words));
    await syncNow(800);
    const rolled = pc.logsOf(vaultId);
    for (const [id, lines] of Object.entries(real)) pc.writeLog(vaultId, id, lines as string[]);
    const Cid = Object.keys(rolled).find((id) => !real[id] && id !== R)!;
    pc.writeLog(vaultId, Cid, rolled[Cid]!);
    pc.writeForkFile(vaultId, { deviceId: R, seq: 0, lines: [real[R]![0], rolled[R]![0]] });
    await syncNow(1500);
    await syncNow(1000);
    const warning = view().warnings.find((w: any) => w.kind === 'lost-own-line');
    out.toldPlainly = !!warning && warning.text.startsWith('This computer now shows an earlier restore with your recovery phrase');
    out.deleted = await message(C.actions.deleteRemovedVault().then(() => 'ok'));
    out.restoredAgain = await message(C.actions.restoreWithPhrase(words));
    await syncNow(1000);
    const st = pc.stateOf(vaultId);
    const live = Object.values(st.members).filter((m: any) => !m.removed).map((m: any) => m.deviceId);
    out.bOut = !live.includes(Bid);
    out.cIn = live.length === 1 && view().devices?.find((d: any) => d.thisDevice)?.id === live[0];
    out.add = await message(C.actions.addAccounts([{ ...ACCOUNT, label: 'after' }]).then(() => 'ok'));
    C.stop();
    snaps.cleanup();
    break;
  }
  default:
    throw new Error(`unknown scenario ${name}`);
}
console.log(`RESULT ${JSON.stringify(out)}`);
stop();
pc.cleanup();
process.exit(0);
