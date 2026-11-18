import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Controls,nextReset,holds} from '../src/controls.mjs';
import {Schedules} from '../src/schedules.mjs';
import {ChatService} from '../src/chat-service.mjs';

const encrypt=s=>Buffer.from(s).map(b=>b^42),decrypt=b=>Buffer.from(b).map(b=>b^42).toString();
async function setup(t,backend=async function*(){yield 'ok';}){
 const directory=await mkdtemp(join(tmpdir(),'gratis-controls-'));let now=new Date(2026,10,11,10,0,0).getTime();
 const service=new ChatService({dataDir:directory,backend});await service.init();
 const options={directory,encrypt,decrypt,service,now:()=>now},c=await new Controls(options).init();service.controls=c;
 t.after(async()=>{await c.close();await service.close();await rm(directory,{recursive:true,force:true});});
 return{c,service,options,bot:service.state.bots[0].id,chat:service.state.activeConversationId,setNow:v=>now=v};
}
const reply=async(f,text='hi')=>{await f.service.send({conversationId:f.chat,text});await f.service.whenIdle();return f.service.state.conversations.find(c=>c.id===f.chat).messages.at(-1);};

test('controls persist encrypted and survive restart',async t=>{
 const f=await setup(t);await f.c.saveBudget({botId:f.bot,unit:'runs',period:'day',limit:3});await f.c.savePolicy({botId:null,tool:'send_*',action:'deny',note:'No outbound mail'});await f.c.setPaused(f.bot,true);
 assert.doesNotMatch((await readFile(join(f.options.directory,'controls.secure'))).toString('latin1'),/No outbound mail/);
 const again=await new Controls(f.options).init();assert.equal(again.data.budgets[0].limit,3);assert.equal(again.data.policies.length,1);assert.equal(again.isPaused(f.bot),true);
});
test('budget and policy input is validated',async t=>{
 const f=await setup(t);
 await assert.rejects(f.c.saveBudget({botId:f.bot,unit:'dollars',period:'day',limit:1}),/runs/);
 await assert.rejects(f.c.saveBudget({botId:f.bot,unit:'runs',period:'day',limit:0}),/limit/);
 await assert.rejects(f.c.saveBudget({botId:'nope',unit:'runs',period:'day',limit:1}),/exists/);
 await assert.rejects(f.c.saveBudget({botId:f.bot,unit:'runs',period:'day',limit:1,warnAt:1}),/Warn/);
 await assert.rejects(f.c.savePolicy({tool:'x',action:'allow',note:'n'}),/approval or deny/);
 await assert.rejects(f.c.savePolicy({tool:'x',action:'deny',note:'n',condition:{field:'a b',op:'>',value:1}}),/field/);
 await assert.rejects(f.c.savePolicy({tool:'x',action:'deny',note:'n',condition:{field:'a',op:'>',value:'abc'}}),/number/);
});
test('one budget per bot, unit and period; periods reset at local boundaries',async t=>{
 const f=await setup(t);const a=await f.c.saveBudget({botId:f.bot,unit:'runs',period:'day',limit:2});const b=await f.c.saveBudget({botId:f.bot,unit:'runs',period:'day',limit:5});
 assert.equal(a.id,b.id);assert.equal(f.c.data.budgets.length,1);
 assert.equal(new Date(nextReset('day',new Date(2026,10,11,23,0).getTime())).getDate(),12);
 assert.equal(new Date(nextReset('week',new Date(2026,10,11).getTime())).getDay(),1);
 assert.equal(new Date(nextReset('month',new Date(2026,10,11).getTime())).getMonth(),11);
 assert.equal(nextReset('total',Date.now()),null);
});
test('a run budget blocks the next response, keeps partial-work wording, and resets next day',async t=>{
 const f=await setup(t);await f.c.saveBudget({botId:f.bot,unit:'runs',period:'day',limit:1});
 assert.equal((await reply(f)).status,'complete');
 const blocked=await reply(f,'again');assert.equal(blocked.status,'cancelled');assert.equal(blocked.limitReached,true);assert.match(blocked.error,/budget reached \(1 of 1\)/);
 f.setNow(new Date(2026,10,12,0,5).getTime());f.service.state.conversations.find(c=>c.id===f.chat).queuePaused=false;
 assert.equal((await reply(f,'next day')).status,'complete');
});
test('tool-call budgets stop a run mid-way and global budgets apply to every bot',async t=>{
 const f=await setup(t);await f.c.saveBudget({botId:null,unit:'toolCalls',period:'day',limit:2});
 assert.equal(f.c.recordTool(f.bot,'a'),null);assert.equal(f.c.recordTool(f.bot,'b'),null);assert.match(f.c.recordTool(f.bot,'c'),/Global day tool call budget reached/);
 assert.match(f.c.runStart(f.bot).limit,/tool call budget/);
});
test('warn threshold is logged once per period',async t=>{
 const f=await setup(t);await f.c.saveBudget({botId:f.bot,unit:'toolCalls',period:'day',limit:10,warnAt:0.5});
 for(let i=0;i<8;i++)f.c.recordTool(f.bot,'t');
 assert.equal(f.c.data.events.filter(e=>e.kind==='budget'&&e.outcome==='warning').length,1);
});
test('minutes are charged when a response ends',async t=>{
 const f=await setup(t);await f.c.saveBudget({botId:f.bot,unit:'minutes',period:'day',limit:5});f.c.runEnd(f.bot,'complete',3*60000);f.c.runEnd(f.bot,'complete',2.5*60000);
 assert.match(f.c.runStart(f.bot).limit,/minute budget/);
});
test('pause blocks responses, cancels the active one and resume restores them',async t=>{
 let release;const hold=new Promise(r=>release=r);
 const f=await setup(t,async function*({signal}){yield 'start';await Promise.race([hold,new Promise((_,rej)=>signal.addEventListener('abort',()=>rej(signal.reason),{once:true}))]);yield 'end';});
 await f.service.send({conversationId:f.chat,text:'go'});await new Promise(r=>setTimeout(r,20));
 await f.c.setPaused(f.bot,true);await f.service.whenIdle();release();
 assert.equal(f.service.state.conversations.find(c=>c.id===f.chat).messages.at(-1).status,'cancelled');
 const blocked=await reply(f,'more');assert.equal(blocked.status,'error');assert.match(blocked.error,/paused/);
 await f.c.setPaused(f.bot,false);f.service.state.conversations.find(c=>c.id===f.chat).queuePaused=false;
 assert.equal((await reply(f,'back')).status,'complete');
});
test('conditions compare numbers and text; missing fields never match',()=>{
 assert.equal(holds({field:'discountPercent',op:'>',value:10},{discountPercent:15}),true);
 assert.equal(holds({field:'discountPercent',op:'>',value:10},{discountPercent:5}),false);
 assert.equal(holds({field:'a.b',op:'contains',value:'GOLD'},{a:{b:'gold plan'}}),true);
 assert.equal(holds({field:'x',op:'==',value:'1'},{}),false);
 assert.equal(holds({field:'x',op:'>',value:1},{x:'abc'}),false);
 assert.equal(holds(null,{}),true);
});
test('deny beats require approval, a bot rule beats a global one, and globs ignore case',async t=>{
 const f=await setup(t);
 await f.c.savePolicy({botId:null,tool:'*SEND*',action:'require_approval',note:'Check sends'});
 assert.deepEqual(f.c.gate(f.bot,'GMAIL_send_email',{}),{action:'require_approval',note:'Check sends'});
 await f.c.savePolicy({botId:null,tool:'gmail_*',action:'deny',note:'Global deny'});
 await f.c.savePolicy({botId:f.bot,tool:'gmail_*',action:'deny',note:'Bot deny'});
 assert.equal(f.c.gate(f.bot,'gmail_send_email',{}).note,'Bot deny');
 assert.equal(f.c.gate(f.bot,'search_web',{}),null);
 assert.equal(f.c.gate('other-bot','gmail_send_email',{}).note,'Global deny');
});
test('a discount rule gates 15 but not 5, and activity logs hold no tool input',async t=>{
 const f=await setup(t);await f.c.savePolicy({botId:null,tool:'create_offer',action:'require_approval',note:'Your limit is 10%',condition:{field:'discountPercent',op:'>',value:10}});
 assert.equal(f.c.gate(f.bot,'create_offer',{discountPercent:15}).action,'require_approval');assert.equal(f.c.gate(f.bot,'create_offer',{discountPercent:5}),null);
 assert.doesNotMatch(f.c.data.events.map(e=>e.summary).join(' '),/discountPercent|\b15\b/);assert.doesNotMatch(JSON.stringify(f.c.data.events),/discountPercent/);
});
test('scheduled runs skip while a bot is paused and are recorded',async t=>{
 const f=await setup(t);const schedules=await new Schedules({...f.options}).init();t.after(()=>schedules.close());
 const item=await schedules.create({conversationId:f.chat,title:'Daily',prompt:'Check',timing:{kind:'weekly',time:'09:00',days:[0,1,2,3,4,5,6],timezone:'UTC'}});
 await f.c.setPaused(f.bot,true);f.setNow(item.nextRunAt+60000);await schedules.tick();
 const saved=schedules.get(item.id,f.chat);assert.equal(saved.runs.length,0);assert.ok(saved.nextRunAt>f.options.now());
 assert.ok(f.c.data.events.some(e=>e.kind==='pause'&&/Skipped scheduled task/.test(e.summary)));
});
