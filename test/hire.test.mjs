import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDraft,parseDraftResponse,draftHire,applyHire} from '../src/hire.mjs';
import {stack} from './proactivity-fixture.mjs';

const good={name:'Hunter',role:'Growth',personality:'Warm',instructions:'Find new clinics and keep every lead answered within a day.',objectives:[{title:'20 new clinics a quarter',metric:{name:'Clinics',start:0,target:20},cadence:{kind:'weekly',dayOfWeek:5,time:'09:00'}}],suggestedApps:['HubSpot'],routines:[{title:'Pipeline report',prompt:'Summarize the pipeline.',days:[1],time:'09:00'}],budget:{unit:'runs',period:'day',limit:10},policies:[{tool:'*send*',action:'require_approval',note:'Check sends'}]};

test('drafts keep only known fields and tolerate a code fence',()=>{
 const r=parseDraftResponse('Here:\n```json\n'+JSON.stringify({...good,extra:'x',objectives:[{...good.objectives[0],hack:1}]})+'\n```');
 assert.equal(r.draft.name,'Hunter');assert.equal(r.draft.extra,undefined);assert.equal(r.draft.objectives[0].hack,undefined);assert.equal(r.draft.objectives[0].cadence.kind,'weekly');
});
test('clarifying questions are capped at two',()=>{assert.deepEqual(parseDraftResponse('{"questions":["a?","b?","c?"]}'),{questions:['a?','b?']});});
test('malformed or unsafe drafts are rejected',()=>{
 assert.throws(()=>parseDraftResponse('no json here'),/did not return/);
 assert.throws(()=>parseDraftResponse('{"name": }'),/unreadable/);
 assert.throws(()=>validateDraft({...good,instructions:'Use api_key=abcdefgh12345678 for everything'}),/credential/);
 assert.throws(()=>validateDraft({...good,budget:{unit:'dollars',period:'day',limit:1}}),/budget/);
 assert.throws(()=>validateDraft({...good,objectives:[good.objectives[0],good.objectives[0],good.objectives[0],good.objectives[0]]}),/too many/);
 assert.throws(()=>validateDraft({...good,routines:[{title:'x',prompt:'y',time:'25:00'}]}));
 assert.throws(()=>validateDraft({...good,suggestedApps:['<script>']}),/app name/);
 assert.throws(()=>validateDraft({...good,name:''}),/name/);
});
test('a draft needs a Claude or Codex login, otherwise a plain fallback is used',async()=>{
 const r=await draftHire({sentence:'I need someone to find customers',settings:{provider:'demo'}});assert.equal(r.fallback,true);assert.equal(r.draft.objectives.length,0);
});
test('the model call is passed the sentence and answers as data, and a second round of questions is refused',async()=>{
 let seen;const settings={provider:'claude'};
 const ok=await draftHire({sentence:'Find customers',answers:['Dental clinics'],settings,generate:async function*({input}){seen=input;yield JSON.stringify(good);}});
 assert.equal(seen.request,'Find customers');assert.deepEqual(seen.answers,['Dental clinics']);assert.equal(ok.draft.name,'Hunter');
 const again=await draftHire({sentence:'Find customers',answers:['x'],settings,generate:async function*(){yield '{"questions":["more?"]}';}});assert.match(again.error,/more questions/);
 const asked=await draftHire({sentence:'Find customers',settings,generate:async function*(){yield '{"questions":["Who?"]}';}});assert.deepEqual(asked.questions,['Who?']);
});
test('hiring creates exactly what the draft shows',async t=>{
 const f=await stack(t);const before=f.service.state.bots.length;
 const r=await applyHire({draft:good,avatarShape:'flower',avatarColor:'orange',...f});
 assert.equal(f.service.state.bots.length,before+1);
 const bot=f.service.state.bots.find(b=>b.id===r.botId);assert.match(bot.instructions,/Role: Growth/);assert.match(bot.instructions,/Personality: Warm/);assert.equal(bot.promptMode,'manual');
 assert.equal(f.objectives.items.filter(o=>o.ownerBotId===r.botId).length,1);
 assert.equal(f.schedules.items.filter(i=>i.botId===r.botId).length,2);// routine + objective check-in
 assert.equal(f.controls.data.budgets.filter(b=>b.botId===r.botId).length,1);assert.equal(f.controls.data.policies.filter(p=>p.botId===r.botId).length,1);
 assert.equal(f.proactivity.level(r.botId),'low');assert.deepEqual(r.suggestedApps,['HubSpot']);
});
test('a failure part-way removes the new bot and everything made for it',async t=>{
 const f=await stack(t);const bots=f.service.state.bots.length;
 const bad={...good,policies:[{tool:'x',action:'deny',note:'n',condition:{field:'a',op:'>',value:'abc'}}]};
 await assert.rejects(applyHire({draft:bad,avatarShape:'flower',avatarColor:'orange',...f}),/number/);
 assert.equal(f.service.state.bots.length,bots);assert.equal(f.objectives.items.length,0);assert.equal(f.schedules.items.length,0);assert.equal(f.controls.data.budgets.length,0);
});
