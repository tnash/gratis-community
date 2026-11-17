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
 const tokens=await new RuntimeTokens(dir).init(),server=await startRuntimeServer({runtime,tokens});
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
