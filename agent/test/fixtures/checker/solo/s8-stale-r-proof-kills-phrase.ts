// S8: the agent refuses a restore with the current phrase R1: Entry 3 has seq 2, but the next entry of its device is 3. Read the vault again and retry.
import { ModelContext } from '../../../model/context';
import { checkSolo, runSolo } from '../../../model/solo';
import { vaultFeatures } from '../../../../src/vault/features';
vaultFeatures.multiDevice = false;
const fixture = {"seed":"solo-random","bounds":{"maxSteps":6,"maxPuts":2,"maxRestores":2,"maxPhraseChanges":1,"maxThief":3,"maxPhraseThief":2,"maxComputer":3,"maxRFork":1,"thief":true,"phraseThief":true,"computer":true,"thiefKinds":["put","delete","rename","add","rotate","recoverySet","remove","garbage","badSeal","fork","forkProof","truncate"]},"ops":[{"t":"keepRestore"},{"t":"restore"},{"t":"phrase"},{"t":"rFork","kind":"retry","delivery":"proof"},{"t":"writeKept","best":true}]};
const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);
if (!world) throw new Error('the scenario no longer builds');
const hit = checkSolo(world).filter((v) => v.invariant === "S8");
console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');
