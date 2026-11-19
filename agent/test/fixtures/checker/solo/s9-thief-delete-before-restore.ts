// S9: account a1, deleted by the stolen phone (F#3, applied) before the restore onto D1, is gone and its delete is not offered for review
import { ModelContext } from '../../../model/context';
import { checkSolo, runSolo } from '../../../model/solo';
import { vaultFeatures } from '../../../../src/vault/features';
vaultFeatures.multiDevice = false;
const fixture = {"seed":"solo-fast","bounds":{"maxSteps":6,"maxPuts":1,"maxRestores":1,"maxPhraseChanges":1,"maxThief":1,"maxPhraseThief":1,"maxComputer":1,"maxRFork":1,"thief":true,"phraseThief":true,"computer":true,"thiefKinds":["put","delete","rename","add","rotate","recoverySet","remove","garbage","badSeal","fork","forkProof","truncate"]},"ops":[{"t":"put"},{"t":"steal"},{"t":"thief","kind":"delete","basis":"stale","delivery":"agent"},{"t":"restore"}]};
const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);
if (!world) throw new Error('the scenario no longer builds');
const hit = checkSolo(world).filter((v) => v.invariant === "S9");
console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');
