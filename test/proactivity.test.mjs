import test from 'node:test';
import assert from 'node:assert/strict';
import {stack} from './proactivity-fixture.mjs';

const step=(over={})=>({action:'Draft three outreach emails',rationale:'Leads are going cold',expectedImpact:'More replies',riskLevel:'low',...over});
const prop=(f,over)=>f.proactivity.propose({botId:f.bot,conversationId:f.chat,...step(over)});
const chatOf=f=>f.service.state.conversations.find(c=>c.id===f.chat);

test('low level queues everything for the user, and approval starts one chat run',async t=>{
 const f=await stack(t);
 const r=await prop(f);assert.equal(r.status,'pending');
 await f.proactivity.tick();assert.equal(chatOf(f).messages.length,0);
 await f.proactivity.resolve({id:r.id,approve:true});await f.proactivity.tick();await f.service.whenIdle();
 const user=chatOf(f).messages.find(m=>m.role==='user');assert.match(user.content,/Approved next step: Draft three outreach emails/);assert.equal(user.kind,'scheduled-task');
 assert.equal(f.proactivity.data.proposals[0].status,'started');
});
test('medium starts a low-risk step by itself but only once a day; medium risk still waits',async t=>{
 const f=await stack(t);await f.proactivity.setLevel(f.bot,'medium');
 assert.equal((await prop(f)).status,'approved');
 f.proactivity.data.proposals[0].auto&&await f.proactivity.tick();await f.service.whenIdle();
 assert.equal((await prop(f,{action:'Another low-risk step'})).status,'pending');
 assert.equal((await prop(f,{action:'Riskier step',riskLevel:'medium'})).status,'pending');
});
test('high level allows medium risk but never high risk or externally derived steps',async t=>{
 const f=await stack(t);await f.proactivity.setLevel(f.bot,'high');
 assert.equal((await prop(f,{action:'a',riskLevel:'high'})).status,'pending');
 assert.equal((await prop(f,{action:'b',fromExternalContent:true})).status,'pending');
 assert.equal((await prop(f,{action:'c',riskLevel:'medium'})).status,'approved');
});
test('off refuses suggestions and holds approved steps',async t=>{
 const f=await stack(t);const r=await prop(f);await f.proactivity.resolve({id:r.id,approve:true});
 await f.proactivity.setLevel(f.bot,'off');await assert.rejects(prop(f,{action:'new'}),/turned/);
 await f.proactivity.tick();assert.equal(chatOf(f).messages.length,0);
});
test('a rejected step is not proposed again for two weeks, duplicates are blocked',async t=>{
 const f=await stack(t);const r=await prop(f);await assert.rejects(prop(f,{action:'  DRAFT three   outreach emails '}),/already waiting/);
 await f.proactivity.resolve({id:r.id,approve:false});await assert.rejects(prop(f),/rejected this step recently/);
 f.setNow(f.proactivity.now()+15*86400000);assert.equal((await prop(f)).status,'pending');
});
test('objective links must belong to the bot, and tampered input is rejected',async t=>{
 const f=await stack(t);
 await assert.rejects(prop(f,{objectiveId:'nope'}),/does not belong/);
 await assert.rejects(prop(f,{riskLevel:'extreme'}),/risk/);
 await assert.rejects(prop(f,{action:''}),/action/);
 await assert.rejects(f.proactivity.propose({botId:'ghost',...step()}),/Unknown bot/);
 const o=await f.objectives.create({title:'Grow',ownerBotId:f.bot});assert.equal((await prop(f,{objectiveId:o.id})).status,'pending');
});
test('quiet hours delay automatic starts but not ones the user approved',async t=>{
 const f=await stack(t);await f.proactivity.setLevel(f.bot,'medium');await f.proactivity.setQuietHours({start:'09:00',end:'11:00'});// clock is 10:00
 const auto=await prop(f);assert.equal(auto.status,'approved');await f.proactivity.tick();assert.equal(chatOf(f).messages.length,0);
 f.setNow(new Date(2026,10,11,12,0).getTime());await f.proactivity.tick();await f.service.whenIdle();assert.equal(chatOf(f).messages.filter(m=>m.role==='user').length,1);
 await assert.rejects(f.proactivity.setQuietHours({start:'9',end:'11'}),/HH:mm/);
});
test('a paused bot or busy chat holds an approved step until it can run',async t=>{
 const f=await stack(t);const r=await prop(f);await f.proactivity.resolve({id:r.id,approve:true});
 await f.controls.setPaused(f.bot,true);await f.proactivity.tick();assert.equal(chatOf(f).messages.length,0);
 await f.controls.setPaused(f.bot,false);await f.proactivity.tick();await f.service.whenIdle();assert.equal(f.proactivity.data.proposals[0].status,'started');
});
test('five approvals with no rejection suggest a higher level, which never applies itself',async t=>{
 const f=await stack(t);
 for(let i=0;i<5;i++){const r=await prop(f,{action:'step '+i});await f.proactivity.resolve({id:r.id,approve:true});}
 assert.equal(f.proactivity.snapshot().suggestRaise[f.bot],'medium');assert.equal(f.proactivity.level(f.bot),'low');
 await f.proactivity.setLevel(f.bot,'medium');assert.equal(f.proactivity.snapshot().suggestRaise[f.bot],undefined);
});
test('settings survive restart and snapshot hides internal keys',async t=>{
 const f=await stack(t);await f.proactivity.setLevel(f.bot,'high');await prop(f);
 const {Proactivity}=await import('../src/proactivity.mjs');const again=await new Proactivity({directory:f.directory,encrypt:x=>Buffer.from(x).map(b=>b^42),decrypt:b=>Buffer.from(b).map(b=>b^42).toString(),service:f.service}).init();
 assert.equal(again.level(f.bot),'high');assert.equal(again.snapshot().proposals[0].key,undefined);
});
