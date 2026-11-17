import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Objectives} from '../src/objectives.mjs';
import {Schedules} from '../src/schedules.mjs';
import {Controls} from '../src/controls.mjs';
import {Proactivity} from '../src/proactivity.mjs';
import {ChatService} from '../src/chat-service.mjs';
const encrypt=s=>Buffer.from(s).map(b=>b^42),decrypt=b=>Buffer.from(b).map(b=>b^42).toString();
export async function stack(t){
 const directory=await mkdtemp(join(tmpdir(),'gratis-hire-'));let now=new Date(2026,10,11,10,0,0).getTime();
 const service=new ChatService({dataDir:directory,backend:async function*(){yield 'ok';}});await service.init();
 const base={directory,encrypt,decrypt,service,now:()=>now};
 const schedules=await new Schedules(base).init();
 const objectives=await new Objectives({...base,schedules}).init();
 const controls=await new Controls(base).init();service.controls=controls;
 const proactivity=await new Proactivity({...base,controls,objectives,busy:c=>schedules.busy(c)}).init();service.proactivity=proactivity;
 t.after(async()=>{await proactivity.close();await controls.close();await objectives.close();await schedules.close();await service.close();await rm(directory,{recursive:true,force:true});});
 return{directory,service,schedules,objectives,controls,proactivity,bot:service.state.bots[0].id,chat:service.state.activeConversationId,setNow:v=>now=v};
}
