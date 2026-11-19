// S7r: the restore was built on a folder rolled back or withheld by the computer: it lacks F#3
import { ModelContext } from '../../../model/context';
import { checkSolo, runSolo } from '../../../model/solo';
import { vaultFeatures } from '../../../../src/vault/features';
vaultFeatures.multiDevice = false;
const fixture = {"seed":"solo-fixture","bounds":{"maxSteps":6,"maxPuts":2,"maxRestores":1,"maxPhraseChanges":1,"maxThief":1,"maxPhraseThief":1,"maxComputer":1,"thief":true,"phraseThief":true,"computer":true,"thiefKinds":["put","delete","rename","add","rotate","recoverySet","remove","garbage","badSeal","fork","forkProof","truncate"]},"ops":[{"t":"put"},{"t":"withhold"},{"t":"put"},{"t":"restore"}]};
const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);
if (!world) throw new Error('the scenario no longer builds');
const hit = checkSolo(world).filter((v) => v.invariant === "S7r");
console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');
