import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Objectives} from '../src/objectives.mjs';
import {Schedules} from '../src/schedules.mjs';
import {ChatService} from '../src/chat-service.mjs';

const encrypt=s=>Buffer.from(s).map(b=>b^42),decrypt=b=>Buffer.from(b).map(b=>b^42).toString();
async function setup(t){
 const directory=await mkdtemp(join(tmpdir(),'gratis-objectives-'));let now=Date.parse('2026-11-08T12:00:00Z');
 const service=new ChatService({dataDir:directory,backend:async function*(){yield 'ok';}});await service.init();
 const schedules=await new Schedules({directory,encrypt,decrypt,service,now:()=>now}).init();
 const options={directory,encrypt,decrypt,service,schedules,now:()=>now},o=await new Objectives(options).init();
 t.after(async()=>{await o.close();await schedules.close();await service.close();await rm(directory,{recursive:true,force:true});});
 return{o,schedules,service,options,bot:service.state.bots[0].id,setNow:v=>now=v};
}
const metric={name:'Followers',unit:'',start:0,target:10000};
const weekly={kind:'weekly',dayOfWeek:5,time:'09:00',timezone:'America/Toronto'};

test('objectives persist encrypted across restart',async t=>{
 const f=await setup(t);const item=await f.o.create({title:'Grow LinkedIn',ownerBotId:f.bot,metric,deadline:'2027-03-31'});
 assert.doesNotMatch((await readFile(join(f.options.directory,'objectives.secure'))).toString('latin1'),/Grow LinkedIn/);
 const again=await new Objectives(f.options).init();assert.equal(again.items[0].id,item.id);assert.equal(again.items[0].metric.target,10000);
});
test('bad input is rejected',async t=>{
 const f=await setup(t);
 await assert.rejects(f.o.create({title:'',ownerBotId:f.bot}),/title/);
 await assert.rejects(f.o.create({title:'x',ownerBotId:'nope'}),/exists/);
 await assert.rejects(f.o.create({title:'x',ownerBotId:f.bot,metric:{name:'a',start:1,target:1}}),/differ/);
 await assert.rejects(f.o.create({title:'x',ownerBotId:f.bot,deadline:'tomorrow'}),/YYYY-MM-DD/);
 await assert.rejects(f.o.create({title:'x',ownerBotId:f.bot,cadence:{kind:'hourly'}}),/check-ins/);
});
test('a bot reports only on its own live objectives and cannot finish or drop them',async t=>{
 const f=await setup(t);const item=await f.o.create({title:'Grow',ownerBotId:f.bot,metric});
 const view=await f.o.report({id:item.id,author:f.bot,value:250,note:'Five posts live'});assert.equal(view.metric.current,250);assert.equal(view.entries.length,1);
 await assert.rejects(f.o.report({id:item.id,author:'other-bot',value:1}),/another bot/);
 await assert.rejects(f.o.report({id:item.id,author:f.bot}),/value or a note/);
 await assert.rejects(f.o.report({id:item.id,author:f.bot,value:'many'}),/number/);
 const risk=await f.o.flagRisk({id:item.id,botId:f.bot,note:'Engagement stalled'});assert.equal(risk.status,'at_risk');
 assert.equal(f.o.items[0].status,'at_risk');assert.equal(typeof f.o.report,'function');
 await f.o.update({id:item.id,status:'done'});await assert.rejects(f.o.report({id:item.id,author:f.bot,value:5}),/not active/);
});
test('proposals are inert until the user approves, and are capped',async t=>{
 const f=await setup(t);const p=await f.o.propose({title:'Win clients',ownerBotId:f.bot});
 assert.equal(p.status,'proposed');assert.equal(f.o.context(f.bot),'');
 await assert.rejects(f.o.update({id:p.id,status:'proposed'}),/valid status/);
 await f.o.update({id:p.id,status:'active'});assert.match(f.o.context(f.bot),/Win clients/);
 for(let i=0;i<5;i++)await f.o.propose({title:'p'+i,ownerBotId:f.bot});
 await assert.rejects(f.o.propose({title:'one more',ownerBotId:f.bot}),/review/);
});
test('prompt context lists only live objectives owned by the bot',async t=>{
 const f=await setup(t);await f.o.create({title:'Live goal',ownerBotId:f.bot,metric,deadline:'2027-03-31'});
 const done=await f.o.create({title:'Finished goal',ownerBotId:f.bot});await f.o.update({id:done.id,status:'done'});
 const ctx=f.o.context(f.bot);assert.match(ctx,/Live goal/);assert.match(ctx,/0 of 10000/);assert.doesNotMatch(ctx,/Finished goal/);assert.equal(f.o.context('someone-else'),'');
});
test('cadence keeps exactly one managed schedule in step with the objective',async t=>{
 const f=await setup(t);const item=await f.o.create({title:'Grow',ownerBotId:f.bot,cadence:weekly});
 let managed=f.schedules.items.filter(i=>i.objectiveId===item.id);assert.equal(managed.length,1);assert.deepEqual(managed[0].timing.days,[5]);assert.match(managed[0].prompt,/report_objective_progress/);
 await f.o.update({id:item.id,title:'Grow more',cadence:{...weekly,kind:'daily'}});
 managed=f.schedules.items.filter(i=>i.objectiveId===item.id);assert.equal(managed.length,1);assert.equal(managed[0].title,'Check-in: Grow more');assert.equal(managed[0].timing.days.length,7);
 await f.o.update({id:item.id,status:'paused'});assert.equal(f.schedules.items.find(i=>i.objectiveId===item.id).enabled,false);
 await f.o.update({id:item.id,status:'active'});assert.equal(f.schedules.items.find(i=>i.objectiveId===item.id).enabled,true);
 await f.o.update({id:item.id,cadence:{kind:'none'}});assert.equal(f.schedules.items.some(i=>i.objectiveId===item.id),false);
 await f.o.update({id:item.id,cadence:weekly});await f.o.remove({id:item.id});
 assert.equal(f.schedules.items.length,0);assert.equal(f.o.items.length,0);assert.equal(f.o.entries.length,0);
});
test('a failed schedule sync leaves nothing half-created',async t=>{
 const f=await setup(t);f.service.state.conversations=[];
 await assert.rejects(f.o.create({title:'Grow',ownerBotId:f.bot,cadence:weekly}),/Open a chat/);assert.equal(f.o.items.length,0);
});
test('objectives of a deleted bot are paused and listed as orphaned',async t=>{
 const f=await setup(t);const item=await f.o.create({title:'Grow',ownerBotId:f.bot,cadence:weekly});
 f.service.state.bots=[];f.service.state.conversations=[];await f.o.reconcile();
 assert.equal(f.o.items[0].status,'paused');assert.equal(f.o.snapshot()[0].orphaned,true);assert.equal(f.o.context(f.bot),'');assert.ok(item);
});
test('overdue live objectives are flagged without changing stored status',async t=>{
 const f=await setup(t);await f.o.create({title:'Late',ownerBotId:f.bot,deadline:'2026-11-01'});
 const [view]=f.o.snapshot();assert.equal(view.overdue,true);assert.equal(view.status,'active');
});
