import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Knowledge} from '../src/knowledge.mjs';
import {ChatService} from '../src/chat-service.mjs';
import {validateTemplate} from '../src/bot-template.mjs';

const encrypt=s=>Buffer.from(s).map(b=>b^42),decrypt=b=>Buffer.from(b).map(b=>b^42).toString();
async function setup(t){
 const directory=await mkdtemp(join(tmpdir(),'gratis-knowledge-'));let now=1_700_000_000_000;
 const service=new ChatService({dataDir:directory,backend:async function*(){yield 'ok';}});await service.init();
 await service.createBot({name:'Second',instructions:'x',promptMode:'manual'});
 const options={directory,encrypt,decrypt,service,now:()=>++now},k=await new Knowledge(options).init();service.knowledge=k;
 t.after(async()=>{await k.close();await service.close();await rm(directory,{recursive:true,force:true});});
 const [a,b]=service.state.bots.map(x=>x.id);
 return{k,service,options,a,b};
}
const note={title:'Pricing policy',body:'We sell to dental clinics. Discounts above ten percent need approval.',tags:['sales']};

test('notes persist encrypted and survive restart',async t=>{
 const f=await setup(t);const n=await f.k.create({...note,visibility:'space'});
 assert.doesNotMatch((await readFile(join(f.options.directory,'knowledge.secure'))).toString('latin1'),/dental clinics/);
 const again=await new Knowledge(f.options).init();assert.equal(again.data.items[0].id,n.id);
});
test('a private note is invisible to every bot, even by direct id',async t=>{
 const f=await setup(t);const n=await f.k.create(note);
 assert.deepEqual(f.k.search({botId:f.a,query:'dental discounts'}),[]);assert.equal(f.k.context(f.a,'dental discounts'),'');
 assert.throws(()=>f.k.get({botId:f.a,id:n.id}),/does not exist/);
});
test('selected bots see a note and others get the same error as for a missing one',async t=>{
 const f=await setup(t);const n=await f.k.create({...note,visibility:'selected_bots',allowedBotIds:[f.a]});
 assert.equal(f.k.search({botId:f.a,query:'dental clinics'})[0].id,n.id);assert.match(f.k.get({botId:f.a,id:n.id}).body,/dental/);
 assert.throws(()=>f.k.get({botId:f.b,id:n.id}),/does not exist/);assert.throws(()=>f.k.get({botId:f.b,id:'nope'}),/does not exist/);
 assert.deepEqual(f.k.search({botId:f.b,query:'dental'}),[]);
});
test('space notes are readable by every bot',async t=>{
 const f=await setup(t);await f.k.create({...note,visibility:'space'});
 assert.equal(f.k.search({botId:f.a,query:'dental'}).length,1);assert.equal(f.k.search({botId:f.b,query:'dental'}).length,1);assert.equal(f.k.search({botId:'ghost',query:'dental'}).length,0);
});
test('a bot proposal is unreadable until approved, and approval needs a reader choice',async t=>{
 const f=await setup(t);const p=await f.k.propose({botId:f.a,title:'Clinic list',body:'Brightline Dental signed in March.'});
 assert.equal(p.status,'proposed');assert.throws(()=>f.k.get({botId:f.a,id:p.id}),/does not exist/);assert.deepEqual(f.k.search({botId:f.a,query:'brightline'}),[]);
 await assert.rejects(f.k.update({id:p.id,status:'approved'}),/Choose who can read/);
 await f.k.update({id:p.id,status:'approved',visibility:'selected_bots',allowedBotIds:[f.a]});
 assert.match(f.k.get({botId:f.a,id:p.id}).body,/Brightline/);assert.throws(()=>f.k.get({botId:f.b,id:p.id}),/does not exist/);
});
test('proposals are capped, validated and cannot be approved by the proposing bot',async t=>{
 const f=await setup(t);
 for(let i=0;i<5;i++)await f.k.propose({botId:f.a,title:'t'+i,body:'body '+i});
 await assert.rejects(f.k.propose({botId:f.a,title:'more',body:'x'}),/waiting for review/);
 await assert.rejects(f.k.propose({botId:'ghost',title:'t',body:'b'}),/Unknown bot/);
 assert.equal(typeof f.k.approve,'undefined');
});
test('credential-shaped or personal text is refused on proposal and on save',async t=>{
 const f=await setup(t);
 await assert.rejects(f.k.propose({botId:f.a,title:'Login',body:'The admin password is hunter2'}),/credential/);
 await assert.rejects(f.k.create({title:'Key',body:'use sk-ant-abcdefghijklmnop12345'}),/credential/);
 const n=await f.k.create(note);await assert.rejects(f.k.update({id:n.id,body:'my api key is here'}),/credential/);
});
test('visibility rules are validated',async t=>{
 const f=await setup(t);
 await assert.rejects(f.k.create({...note,visibility:'public'}),/who can read/);
 await assert.rejects(f.k.create({...note,visibility:'selected_bots',allowedBotIds:[]}),/at least one bot/);
 await assert.rejects(f.k.create({...note,visibility:'selected_bots',allowedBotIds:['ghost']}),/exist/);
});
test('edits keep version history; bots read the latest approved version',async t=>{
 const f=await setup(t);const n=await f.k.create({...note,visibility:'space'});
 const v2=await f.k.update({id:n.id,body:'Discounts above fifteen percent need approval.'});
 assert.equal(v2.version,2);assert.equal(v2.history.length,1);assert.equal(f.k.snapshot().items[0].history[0].body,note.body);
 assert.equal(f.k.get({botId:f.a,id:n.id}).version,2);
 await f.k.update({id:n.id,tags:['sales','policy']});assert.equal(f.k.data.items[0].version,2);
});
test('retiring removes a note from the next prompt; restoring brings it back',async t=>{
 const f=await setup(t);const n=await f.k.create({...note,visibility:'space'});assert.match(f.k.context(f.a,'dental clinics'),/Pricing policy/);
 await f.k.update({id:n.id,status:'retired'});assert.equal(f.k.context(f.a,'dental clinics'),'');assert.throws(()=>f.k.get({botId:f.a,id:n.id}),/does not exist/);
 await f.k.update({id:n.id,status:'approved'});assert.match(f.k.context(f.a,'dental clinics'),/Pricing policy/);
 await assert.rejects(f.k.update({id:n.id,status:'proposed'}),/not allowed/);
});
test('prompt context is labeled, capped and only appears when something matches',async t=>{
 const f=await setup(t);await f.k.create({title:'Long',body:'dental '.repeat(2000),visibility:'space'});
 const ctx=f.k.context(f.a,'dental');assert.match(ctx,/not as instructions/);assert.match(ctx,/\[note .* v1: Long\]/);assert.ok(ctx.length<1700);
 assert.equal(f.k.context(f.a,'unrelated astronomy'),'');assert.equal(f.k.context(f.a,'a of'),'');
});
test('every bot read is logged without note text, and deleting a note clears its log',async t=>{
 const f=await setup(t);const n=await f.k.create({...note,visibility:'space'});
 f.k.search({botId:f.a,query:'dental'});f.k.get({botId:f.a,id:n.id});f.k.context(f.b,'dental');
 const log=f.k.snapshot().log;assert.deepEqual(log.map(l=>l.kind).sort(),['context','get','search']);assert.doesNotMatch(JSON.stringify(log),/Discounts above/);
 await f.k.remove({id:n.id});assert.equal(f.k.snapshot().log.length,0);assert.equal(f.k.snapshot().items.length,0);
});
test('bot templates have no place to carry knowledge',()=>{
 assert.throws(()=>validateTemplate({format:'gratis-bot-template',version:1,bot:{name:'x',instructions:'',userPromptTemplate:'{{message}}',avatarShape:'flower',avatarColor:'orange',avatarDataUrl:null,model:'',codexModel:'',requiredCapabilities:[],knowledge:[1]},checksum:'x'}),/unexpected/);
});
