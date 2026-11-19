// S5: the owner's phrase change R1#2 lost to a restore attempt the owner signed before the change, kept by the computer and written over it (a device.add), even after the owner's phone synced and could repair its ack
import { ModelContext } from '../../../model/context';
import { checkSolo, runSolo } from '../../../model/solo';
import { vaultFeatures } from '../../../../src/vault/features';
vaultFeatures.multiDevice = false;
const fixture = {"seed":"solo-random","bounds":{"maxSteps":8,"maxPuts":2,"maxRestores":2,"maxPhraseChanges":1,"maxThief":3,"maxPhraseThief":2,"maxComputer":4,"maxRFork":1,"thief":true,"phraseThief":true,"computer":true,"thiefKinds":["put","delete","rename","add","rotate","recoverySet","remove","garbage","badSeal","fork","forkProof","truncate"]},"ops":[{"t":"keepRestore"},{"t":"restore"},{"t":"rename"},{"t":"writeKept"},{"t":"keepRestore"},{"t":"phrase"},{"t":"writeKept","best":true}]};
const world = runSolo(new ModelContext(fixture.seed), fixture.bounds as never, fixture.ops as never);
if (!world) throw new Error('the scenario no longer builds');
const hit = checkSolo(world).filter((v) => v.invariant === "S5");
console.log(hit.length > 0 ? `FAIL ${hit.map((v) => v.summary).join('; ')}` : 'PASS (no longer violated)');
