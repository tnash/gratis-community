import {requireVersion,assertStorageCompatible} from './storage-safety.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export const STATUSES=['open','in_progress','blocked','done'];
const MAX_TASKS=500,MAX_OUTPUTS=10,MAX_READ=20000;
const text=(v,label,max,optional=false)=>{
 if(optional&&(v===undefined||v===null||v===''))return '';
 if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`Enter ${label} under ${max} characters.`);return v.trim();
};
const sha=buf=>createHash('sha256').update(buf).digest('hex');

// Shared task board plus teammate directory. The chief teammate (the first bot) assigns work and checks
// outputs; other teammates only see and update their own tasks. Access is enforced here, not in prompts.
export class TeamBoard{
 constructor({directory,encrypt,decrypt,service,files,onChange=()=>{},now=Date.now}){Object.assign(this,{directory,encrypt,decrypt,service,files,onChange,now});this.data={tasks:[]};this.persist=Promise.resolve();this.opened=false;}
 async init(){
  try{
   const data=JSON.parse(await this.decrypt(await readFile(join(this.directory,'teamboard.secure'))));
   requireVersion(data,'Team board');if(!Array.isArray(data.tasks))throw new Error('Invalid saved records.');this.data={tasks:data.tasks};
  }catch(e){if(e.code!=='ENOENT')throw new Error('Could not unlock the saved team board.');}
  this.opened=true;return this;
 }
 async save(){
  if(!this.opened)throw new Error('Storage did not open safely. Existing files were preserved.');
  const body=JSON.stringify({version:1,...this.data});
  const write=async()=>{await assertStorageCompatible(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});const tmp=join(this.directory,'.teamboard-'+randomUUID());await writeFile(tmp,await this.encrypt(body),{mode:0o600});await rename(tmp,join(this.directory,'teamboard.secure'));};
  this.persist=this.persist.then(write,write);await this.persist;this.onChange();
 }
 async close(){await this.persist;}
 chiefId(){return this.service.state.bots[0]?.id;}
 isChief(botId){return botId===this.chiefId();}
 _bot(id){const b=this.service.state.bots.find(b=>b.id===id);if(!b)throw new Error('That teammate does not exist.');return b;}
 _task(id){const t=this.data.tasks.find(t=>t.id===id);if(!t)throw new Error('This task does not exist.');return t;}
 _chief(botId){if(!this.isChief(botId))throw new Error('Only the chief teammate can do this.');}
 _own(botId,t){if(t.assigneeId!==botId&&!this.isChief(botId))throw new Error('This task is not yours.');}
 _view(t){return structuredClone(t);}

 // Who is on the team, what they are working on, and what files exist in their workspace (names only).
 async directoryFor(botId,teammateId){
  this._chief(botId);
  const bots=teammateId?[this._bot(teammateId)]:this.service.state.bots;
  return Promise.all(bots.map(async b=>{
   const mine=this.data.tasks.filter(t=>t.assigneeId===b.id),list=await this.files.list(b.id).catch(()=>[]);
   const row={id:b.id,name:b.name,chief:this.isChief(b.id),about:String(b.instructions||'').slice(0,160),capabilities:b.capabilities||{},tasks:{open:mine.filter(t=>t.status==='open').length,inProgress:mine.filter(t=>t.status==='in_progress').length,blocked:mine.filter(t=>t.status==='blocked').length,done:mine.filter(t=>t.status==='done').length},fileCount:list.length,lastFileAt:list[0]?.modified??null};
   if(teammateId)row.files=list.slice(0,100).map(({path,bytes,modified})=>({path,bytes,modified}));
   return row;
  }));
 }

 list(botId,{assigneeId,status}={}){
  let rows=this.data.tasks.filter(t=>this.isChief(botId)||t.assigneeId===botId);
  if(assigneeId)rows=rows.filter(t=>t.assigneeId===assigneeId);if(status)rows=rows.filter(t=>t.status===status);
  return rows.map(t=>this._view(t));
 }
 async create(botId,{title,description,assigneeId}){
  const assignee=assigneeId||botId;this._bot(assignee);if(assignee!==botId)this._chief(botId);
  if(this.data.tasks.length>=MAX_TASKS)throw new Error(`The board already has ${MAX_TASKS} tasks.`);
  const t={id:randomUUID(),title:text(title,'a title',160),description:text(description,'a description',2000,true),assigneeId:assignee,createdBy:botId,status:'open',notes:[],outputs:[],createdAt:this.now(),updatedAt:this.now()};
  this.data.tasks.push(t);await this.save();return this._view(t);
 }
 async update(botId,{id,status,note}){
  const t=this._task(id);this._own(botId,t);
  if(status!==undefined){if(!STATUSES.includes(status))throw new Error('Choose a valid status.');t.status=status;}
  if(note!==undefined){t.notes.push({at:this.now(),by:botId,text:text(note,'a note',1000)});if(t.notes.length>50)t.notes.shift();}
  t.updatedAt=this.now();await this.save();return this._view(t);
 }
 // The assignee records a file it produced. Size and hash are taken by the store, not claimed by the model.
 async attach(botId,{id,path,summary}){
  const t=this._task(id);if(t.assigneeId!==botId)throw new Error('This task is not yours.');
  if(t.outputs.length>=MAX_OUTPUTS)throw new Error(`A task holds at most ${MAX_OUTPUTS} outputs.`);
  const out={id:randomUUID(),at:this.now(),summary:text(summary,'a summary',500,true)};
  if(path){const buf=await readFile(await this.files.target(botId,text(path,'a path',300)));Object.assign(out,{kind:'file',path,bytes:buf.length,sha256:sha(buf)});}
  else if(!out.summary)throw new Error('Give a file path or a written summary.');else out.kind='note';
  t.outputs.push(out);t.updatedAt=this.now();await this.save();return this._view(t);
 }
 // Checks what is actually on disk now against what was recorded.
 async verify(botId,id){
  this._chief(botId);const t=this._task(id);
  const outputs=await Promise.all(t.outputs.map(async o=>{
   if(o.kind!=='file')return{id:o.id,kind:'note',exists:true,state:'recorded'};
   try{const buf=await readFile(await this.files.target(t.assigneeId,o.path));return{id:o.id,kind:'file',path:o.path,exists:true,bytes:buf.length,state:sha(buf)===o.sha256?'unchanged':'changed_since_recorded'};}
   catch{return{id:o.id,kind:'file',path:o.path,exists:false,state:'missing'};}
  }));
  return{taskId:t.id,assignee:this._bot(t.assigneeId).name,status:t.status,claimedDone:t.status==='done',outputs,confirmed:t.outputs.length>0&&outputs.every(o=>o.exists)};
 }
 // Only files a teammate attached to a task are readable. The content is data, not instructions.
 async read(botId,{id,outputId}){
  this._chief(botId);const t=this._task(id),o=t.outputs.find(o=>o.id===outputId)||(!outputId&&t.outputs.length===1?t.outputs[0]:null);
  if(!o)throw new Error('Choose one of this task\'s outputs.');
  if(o.kind==='note')return{kind:'note',summary:o.summary,at:o.at};
  const result=await this.files.content(t.assigneeId,o.path),body=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  return{kind:'file',path:o.path,at:o.at,untrustedContent:true,text:body.slice(0,MAX_READ),truncated:body.length>MAX_READ,nonText:result.content.some(c=>c.type!=='text')};
 }
 snapshot(){return{tasks:this.data.tasks.map(t=>this._view(t)),chiefId:this.chiefId()};}
 // The user is above the chief: these calls act with the chief's authority and add deletion.
 async view(){return{...this.snapshot(),team:await this.directoryFor(this.chiefId())};}
 userCreate(input){return this.create(this.chiefId(),input);}
 userUpdate(input){return this.update(this.chiefId(),input);}
 userVerify({id}){return this.verify(this.chiefId(),id);}
 userRead(input){return this.read(this.chiefId(),input);}
 async remove({id}){const t=this._task(id);this.data.tasks=this.data.tasks.filter(x=>x!==t);await this.save();}
}
