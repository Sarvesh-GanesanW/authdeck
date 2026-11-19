// S5: the owner's phrase change R1#0 lost to another version signed with the old phrase (a recovery.set), even after the owner's phone synced and could repair its ack
import { ModelContext } from '../../../model/context';
import { checkSolo, runSolo } from '../../../model/solo';
import { vaultFeatures } from '../../../../src/vault/features';
vaultFeatures.multiDevice = false;
const fixture = {"seed":"solo-random","bounds":{"maxSteps":10,"maxPuts":2,"maxRestores":2,"maxPhraseChanges":1,"maxThief":3,"maxPhraseThief":2,"maxComputer":2,"maxRFork":1,"thief":true,"phraseThief":true,"computer":true,"thiefKinds":["put","delete","rename","add","rotate","recoverySet","remove","garbage","badSeal","fork","forkProof","truncate"]},"ops":[{"t":"phrase"},{"t":"rFork","kind":"phrase","delivery":"proof","grind":true,"chain":true},{"t":"restore"},{"t":"steal"},{"t":"thief","kind":"fork","basis":"folder","delivery":"direct"}]};
const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);
if (!world) throw new Error('the scenario no longer builds');
const hit = checkSolo(world).filter((v) => v.invariant === "S5");
console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');
