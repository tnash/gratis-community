import {scryptSync,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// Headless hosts have no OS keychain, so stores are encrypted with a key derived from a passphrase.
// shortcut: passphrase comes from the caller (env var in the CLI); use a keystore or prompt when this ships remotely.
const VERIFY='gratis-runtime-v1';
const seal=(key,text)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),ct=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),ct]);};
const open=(key,bytes)=>{const b=Buffer.from(bytes),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');};

export async function openKeystore(directory,passphrase,{create=false}={}){
 if(typeof passphrase!=='string'||passphrase.length<12)throw new Error('Use a passphrase of at least 12 characters.');
 const file=join(directory,'runtime-key.json');let meta;
 try{meta=JSON.parse(await readFile(file,'utf8'));}
 catch(e){
  if(e.code!=='ENOENT')throw e;if(!create)throw new Error('This runtime is not initialized. Run init first.');
  const salt=randomBytes(16),key=scryptSync(passphrase,salt,32);
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(file,JSON.stringify({salt:salt.toString('base64'),check:seal(key,VERIFY).toString('base64')}),{mode:0o600,flag:'wx'});
  return{encrypt:async t=>seal(key,t),decrypt:async b=>open(key,b)};
 }
 const key=scryptSync(passphrase,Buffer.from(meta.salt,'base64'),32);
 try{if(open(key,Buffer.from(meta.check,'base64'))!==VERIFY)throw 0;}catch{throw new Error('Wrong passphrase.');}
 return{encrypt:async t=>seal(key,t),decrypt:async b=>open(key,b)};
}
