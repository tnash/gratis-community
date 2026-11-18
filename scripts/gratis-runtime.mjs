#!/usr/bin/env node
// Headless Gratis runtime. Usage: gratis-runtime init|run|token <scope>|status [--data DIR] [--port N]
// status shows Claude and Codex logins on this machine; with GRATIS_RUNTIME_TOKEN set it also asks the running runtime.
// Set GRATIS_RUNTIME_PASSPHRASE (12+ characters). The data directory is separate from the desktop app's.
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {openKeystore} from '../src/runtime-crypto.mjs';
import {createRuntime} from '../src/runtime-core.mjs';
import {RuntimeTokens,startRuntimeServer} from '../src/runtime-server.mjs';
import {getClaudeStatus} from '../src/claude-backend.mjs';
import {getCodexStatus} from '../src/codex-client.mjs';

const [command,...rest]=process.argv.slice(2);
const flag=(n,d)=>{const i=rest.indexOf('--'+n);return i>=0?rest[i+1]:d;};
const dataDir=resolve(flag('data',process.env.GRATIS_RUNTIME_DATA||'./gratis-runtime-data'));
const passphrase=process.env.GRATIS_RUNTIME_PASSPHRASE;
const fail=m=>{console.error(m);process.exit(1);};
const show=(name,s)=>console.log(name+': '+(s.signedIn?'signed in':s.installed?'installed, not signed in':'not installed')+(s.signedIn?'':' - '+(s.message||'')));
if(command==='status'){
 show('Claude',await getClaudeStatus());show('Codex',await getCodexStatus());
 if(process.env.GRATIS_RUNTIME_TOKEN){
  try{const r=await fetch('http://127.0.0.1:'+flag('port',7421)+'/settings',{headers:{authorization:'Bearer '+process.env.GRATIS_RUNTIME_TOKEN}}),b=await r.json();
   console.log(r.ok?`Runtime provider: ${b.provider}${b.model?' ('+b.model+')':''}`:'Runtime: '+b.error);}
  catch{console.log('Runtime: not running on port '+flag('port',7421));}
 }
 process.exit(0);
}
try{
 if(!['init','run','token'].includes(command))fail('Usage: gratis-runtime init|run|status|token <read|run|admin> [--data DIR] [--port N]');
 await mkdir(dataDir,{recursive:true,mode:0o700});
 const keys=await openKeystore(dataDir,passphrase,{create:command==='init'});
 const tokens=await new RuntimeTokens(dataDir).init();
 if(command==='init'){const t=await tokens.create('admin','first admin');console.log('Runtime created in '+dataDir+'\nAdmin token (shown once): '+t.token);}
 else if(command==='token'){const t=await tokens.create(rest[0],flag('label',''));console.log(t.token);}
 else{
  const runtime=await createRuntime({dataDir,...keys});
  const server=await startRuntimeServer({runtime,tokens,port:Number(flag('port',7421))});
  console.log('Gratis runtime listening on 127.0.0.1:'+server.port);
  const stop=async()=>{await server.close();await runtime.close();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
 }
}catch(error){fail(error.message);}
