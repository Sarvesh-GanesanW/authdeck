// S4: account a1, applied in what R1 saw when restoring onto D1, is gone
import { ModelContext } from '../../../model/context';
import { checkSolo, runSolo } from '../../../model/solo';
import { vaultFeatures } from '../../../../src/vault/features';
vaultFeatures.multiDevice = false;
const fixture = {"seed":"solo-random","bounds":{"maxSteps":10,"maxPuts":2,"maxRestores":2,"maxPhraseChanges":1,"maxThief":3,"maxPhraseThief":2,"maxComputer":2,"thief":true,"phraseThief":true,"computer":true,"thiefKinds":["put","delete","rename","add","rotate","recoverySet","remove","garbage","badSeal","fork","forkProof","truncate"]},"ops":[{"t":"junkProof"},{"t":"put"},{"t":"restore"},{"t":"steal"},{"t":"thief","kind":"fork","basis":"folder","delivery":"hold"},{"t":"thief","kind":"garbage","basis":"stale","delivery":"direct"}]};
const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);
if (!world) throw new Error('the scenario no longer builds');
const hit = checkSolo(world).filter((v) => v.invariant === "S4");
console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');
