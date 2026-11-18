import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openKeystore} from '../src/runtime-crypto.mjs';
import {createRuntime} from '../src/runtime-core.mjs';
import {RuntimeTokens,startRuntimeServer} from '../src/runtime-server.mjs';

const PASS='correct horse battery';
async function boot(t){
 const dir=await mkdtemp(join(tmpdir(),'gratis-runtime-'));
 const keys=await openKeystore(dir,PASS,{create:true});
 const runtime=await createRuntime({dataDir:dir,...keys,serviceOptions:{backend:async function*(){yield 'done';}}});
 const providers={claude:async()=>({installed:true,signedIn:true,message:''}),codex:async()=>({installed:false,signedIn:false,message:'Install Codex.'})};
 const tokens=await new RuntimeTokens(dir).init(),server=await startRuntimeServer({runtime,tokens,providers});
 t.after(async()=>{await server.close();await runtime.close();await rm(dir,{recursive:true,force:true});});
 const call=(token,method,path,body)=>fetch(`http://127.0.0.1:${server.port}${path}`,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}));
 return{dir,runtime,tokens,call};
}

test('keystore rejects a wrong passphrase and short passphrases, and data on disk is encrypted',async t=>{
 const f=await boot(t);
 await assert.rejects(openKeystore(f.dir,'wrong passphrase!!'),/Wrong passphrase/);
 await assert.rejects(openKeystore(f.dir,'short'),/12 characters/);
 await f.runtime.service.createBot({name:'Secretname',instructions:'x',promptMode:'manual'});
 await f.runtime.objectives.create({title:'Private goal here',ownerBotId:f.runtime.service.state.bots[0].id});
 assert.equal((await readFile(join(f.dir,'objectives.secure'))).includes(Buffer.from('Private goal here')),false);
});

test('a scheduled run fires in the headless runtime with no desktop',async t=>{
 const f=await boot(t),chat=f.runtime.service.state.activeConversationId;
 const item=await f.runtime.schedules.create({conversationId:chat,title:'Daily',prompt:'Check',timing:{kind:'weekly',time:'09:00',days:[0,1,2,3,4,5,6]}});
 f.runtime.schedules.get(item.id,chat).nextRunAt=Date.now()-1000;
 await f.runtime.schedules.tick();await f.runtime.service.whenIdle();await f.runtime.schedules.tick();
 assert.equal(f.runtime.schedules.get(item.id,chat).runs[0].status,'completed');
});

test('tokens are scoped, and revoking one stops it on the next request',async t=>{
 const f=await boot(t),admin=(await f.tokens.create('admin')).token,read=(await f.tokens.create('read')).token,run=(await f.tokens.create('run')).token;
 assert.equal((await f.call(null,'GET','/status')).status,401);
 assert.equal((await f.call(read,'GET','/status')).body.protocol,1);
 assert.equal((await f.call(read,'POST','/send',{})).status,403);
 assert.equal((await f.call(run,'GET','/tokens')).status,403);
 assert.equal((await f.call(run,'GET','/state')).status,200);
 const id=run.split('.')[0];
 assert.equal((await f.call(admin,'POST','/tokens/revoke',{id})).status,200);
 assert.equal((await f.call(run,'GET','/status')).status,401);
 assert.equal((await f.call(read.slice(0,-3)+'abc','GET','/status')).status,401);
});

test('a second runtime cannot open the same data directory',async t=>{
 const f=await boot(t),keys=await openKeystore(f.dir,PASS);
 await assert.rejects(createRuntime({dataDir:f.dir,...keys}));
});

test('headless bots get the team board tools, chief-only ones only for the chief',async t=>{
 const f=await boot(t),{service}=f.runtime;
 await service.createBot({name:'Writer',instructions:'x',promptMode:'manual'});
 const [chief,writer]=service.state.bots,names=async bot=>{
  const c=service.state.conversations.find(c=>c.botId===bot.id&&!c.parentThreadId);
  const rt=await service.runtimeFactory({bot,conversationId:c.id,signal:new AbortController().signal,onActivity(){},approve:async()=>true});
  return rt.definitions.map(d=>d.name);
 };
 const chiefTools=await names(chief),writerTools=await names(writer);
 for(const n of ['task_board_list','task_update','task_attach_output','list_objectives','knowledge_search','list_schedules','list_files'])assert.ok(chiefTools.includes(n)&&writerTools.includes(n),n);
 for(const n of ['team_directory','verify_task_output','read_teammate_output'])assert.ok(chiefTools.includes(n)&&!writerTools.includes(n),n);
 assert.equal(chiefTools.includes('computer'),false);
});

test('settings route reports logins, and only admins can switch to a provider that is signed in',async t=>{
 const f=await boot(t),admin=(await f.tokens.create('admin')).token,read=(await f.tokens.create('read')).token;
 const before=await f.call(read,'GET','/settings');
 assert.equal(before.body.provider,'demo');assert.equal(before.body.login.claude.signedIn,true);assert.equal(before.body.login.codex.signedIn,false);
 assert.equal((await f.call(read,'POST','/settings',{provider:'claude'})).status,403);
 assert.match((await f.call(admin,'POST','/settings',{provider:'codex'})).body.error,/Install Codex/);
 assert.match((await f.call(admin,'POST','/settings',{provider:'bogus'})).body.error,/Choose/);
 const ok=await f.call(admin,'POST','/settings',{provider:'claude',model:'sonnet'});
 assert.equal(ok.body.provider,'claude');assert.equal(f.runtime.service.state.settings.model,'sonnet');
});
