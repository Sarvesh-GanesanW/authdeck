// The agent tests cover the 0.4 multi-device code too, so they run with it on; the solo tests
// (vaultSoloAgent.test.ts) turn it off to check what 0.3.0 ships.
import { vaultFeatures } from '../../src/vault/features';

vaultFeatures.multiDevice = true;
