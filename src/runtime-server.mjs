import {createServer} from 'node:http';
import {randomBytes,createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

export const PROTOCOL=1,SCOPES=['read','run','admin'];
const RANK={read:1,run:2,admin:3};
const hash=s=>createHash('sha256').update(s).digest();

// Tokens are "id.secret"; only a hash of the secret is stored, and revoking removes it at once.
export class RuntimeTokens{
 constructor(directory){this.file=join(directory,'runtime-tokens.json');this.directory=directory;this.items=[];}
 async init(){try{this.items=JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
 async _save(){await mkdir(this.directory,{recursive:true,mode:0o700});const tmp=this.file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(this.items),{mode:0o600});await rename(tmp,this.file);}
 async create(scope,label=''){
  if(!SCOPES.includes(scope))throw new Error('Choose a token scope: read, run or admin.');
  const id=randomUUID(),secret=randomBytes(32).toString('base64url');
  this.items.push({id,scope,label:String(label).slice(0,60),hash:hash(secret).toString('hex'),createdAt:Date.now()});await this._save();
  return{id,scope,token:id+'.'+secret};
 }
 async revoke(id){const n=this.items.length;this.items=this.items.filter(t=>t.id!==id);if(this.items.length===n)throw new Error('No such token.');await this._save();}
 list(){return this.items.map(({hash,...t})=>t);}
 check(header,needed){
  const [id,secret]=String(header||'').replace(/^Bearer /,'').split('.');
  const item=this.items.find(t=>t.id===id);
  if(!item||!secret||!timingSafeEqual(hash(secret),Buffer.from(item.hash,'hex')))return null;
  return RANK[item.scope]>=RANK[needed]?item:false;
 }
}

const readBody=req=>new Promise((resolve,reject)=>{let n=0;const parts=[];req.on('data',c=>{n+=c.length;if(n>100000){reject(new Error('Request too large.'));req.destroy();}else parts.push(c);});req.on('end',()=>{try{resolve(parts.length?JSON.parse(Buffer.concat(parts)):{});}catch{reject(new Error('Invalid JSON.'));}});});

// Loopback only. Expose it beyond this machine with a TLS reverse proxy you control.
export async function startRuntimeServer({runtime,tokens,port=0,host='127.0.0.1'}){
 const routes={
  'GET /status':['read',()=>({protocol:PROTOCOL,uptimeMs:Date.now()-runtime.startedAt,bots:runtime.service.state.bots.length,schedules:runtime.schedules.items.length,enabledSchedules:runtime.schedules.items.filter(i=>i.enabled).length})],
  'GET /state':['read',()=>runtime.service.snapshot()],
  'POST /send':['run',b=>runtime.service.send({conversationId:b.conversationId,text:b.text})],
  'POST /approval':['run',b=>runtime.service.respondApproval({id:b.id,allow:b.allow})],
  'GET /tokens':['admin',()=>tokens.list()],
  'POST /tokens':['admin',b=>tokens.create(b.scope,b.label)],
  'POST /tokens/revoke':['admin',async b=>{await tokens.revoke(b.id);return{ok:true};}],
 };
 const server=createServer(async(req,res)=>{
  const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  try{
   const route=routes[req.method+' '+new URL(req.url,'http://x').pathname];
   if(!route)return send(404,{error:'Not found.'});
   if(req.headers['x-gratis-protocol']&&req.headers['x-gratis-protocol']!==String(PROTOCOL))return send(426,{error:'Upgrade required: this runtime speaks protocol '+PROTOCOL+'.'});
   const auth=tokens.check(req.headers.authorization,route[0]);
   if(auth===null)return send(401,{error:'Unauthorized.'});
   if(auth===false)return send(403,{error:'This token cannot do that.'});
   send(200,await route[1](req.method==='POST'?await readBody(req):{}));
  }catch(error){send(400,{error:error.message});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 return{server,port:server.address().port,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})};
}
