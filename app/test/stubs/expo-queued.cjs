// Stand-in for 'expo' under expo-screen-capture: its native functions run one at a time in call
// order (both platforms run them on the main queue) after a random delay, and can be made to fail.
const state = { blocked: false, snapshotHidden: false, failNext: 0, log: [], pendingHide: 0, pendingShow: 0 };
globalThis.__capture = state;
let queue = Promise.resolve();
const onMain = (fn) => {
  const run = queue.then(() => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6)))).then(fn);
  queue = run.catch(() => undefined);
  return run;
};
const native = {
  preventScreenCapture: () => onMain(() => { if (state.failNext > 0) { state.failNext--; throw new Error('no key window'); } state.blocked = true; }),
  allowScreenCapture: () => onMain(() => { state.blocked = false; }),
  enableAppSwitcherProtection: () => { state.pendingHide++; return onMain(() => { state.snapshotHidden = true; state.pendingHide--; }); },
  disableAppSwitcherProtection: () => { state.pendingShow++; return onMain(() => { state.snapshotHidden = false; state.pendingShow--; }); },
};
module.exports = { requireNativeModule: () => native, UnavailabilityError: class extends Error {}, PermissionStatus: {}, createPermissionHook: () => () => null };
