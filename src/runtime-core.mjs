import {acquireDataLock,prepareStorage} from './storage-safety.mjs';
import {ChatService} from './chat-service.mjs';
import {Schedules} from './schedules.mjs';
import {Objectives} from './objectives.mjs';
import {Controls} from './controls.mjs';
import {Proactivity} from './proactivity.mjs';
import {Knowledge} from './knowledge.mjs';

// The Electron-free core: chats, schedules, objectives, controls, proactivity and knowledge.
// Desktop-only services (computer, Gmail, T3, phone, memory) are not started in a headless runtime yet.
export async function createRuntime({dataDir,encrypt,decrypt,serviceOptions={}}){
 const release=await acquireDataLock(dataDir);
 try{
  await prepareStorage(dataDir);
  const service=new ChatService({dataDir,...serviceOptions});await service.init();
  const base={directory:dataDir,encrypt,decrypt,service};
  const schedules=await new Schedules(base).init();
  const objectives=await new Objectives({...base,schedules}).init();service.objectives=objectives;
  const controls=await new Controls(base).init();service.controls=controls;
  const proactivity=await new Proactivity({...base,controls,objectives,busy:c=>schedules.busy(c)}).init();service.proactivity=proactivity;
  const knowledge=await new Knowledge(base).init();service.knowledge=knowledge;
  proactivity.start();schedules.start();
  let closed=false;
  return{service,schedules,objectives,controls,proactivity,knowledge,startedAt:Date.now(),
   async close(){if(closed)return;closed=true;try{await schedules.close();await objectives.close();await controls.close();await proactivity.close();await knowledge.close();await service.close();}finally{await release();}}};
 }catch(error){await release();throw error;}
}
