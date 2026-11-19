/**
 * What this release turns on. 0.3.0 ships solo vaults only: one device and the recovery phrase,
 * with the vault on the computer as its encrypted backup. Multi-device and team vaults (adding and
 * approving devices, joins, members, roles, team folders) come in 0.4; their code stays in place
 * behind this flag, which the agent and the app both read.
 */
export const MULTI_DEVICE_VAULTS = false;

/**
 * The switch the code reads. It starts at MULTI_DEVICE_VAULTS; only the tests of the 0.4 code
 * turn it on (test/setup/multiDevice.ts), and the solo tests turn it back off.
 */
export const vaultFeatures: { multiDevice: boolean } = { multiDevice: MULTI_DEVICE_VAULTS };
