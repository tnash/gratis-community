import {requireVersion,assertStorageCompatible} from './storage-safety.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateTiming} from './schedules.mjs';

const STATUSES=['proposed','active','at_risk','paused','done','dropped'];
const LIVE=['active','at_risk'];
const MAX_OBJECTIVES=50,MAX_PROPOSED_PER_BOT=5,MAX_ENTRIES=200;
const text=(v,label,max,optional=false)=>{
 if(optional&&(v===undefined||v===null||v===''))return '';
 if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`Enter ${label} under ${max} characters.`);
 return v.trim();
};
const number=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v))throw new Error(`Enter a number for ${label}.`);return v;};

export function validateMetric(m){
 if(m===undefined||m===null)return null;
 if(typeof m!=='object')throw new Error('Choose a valid metric.');
 const metric={name:text(m.name,'a metric name',80),unit:text(m.unit,'a unit',24,true),start:number(m.start??0,'the starting value'),target:number(m.target,'the target')};
 metric.current=m.current===undefined?metric.start:number(m.current,'the current value');
 if(metric.start===metric.target)throw new Error('The target must differ from the starting value.');
 return metric;
}
export function validateDeadline(d){
 if(d===undefined||d===null||d==='')return null;
 if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d+'T00:00:00Z')))throw new Error('Choose a deadline as YYYY-MM-DD.');
 return d;
}
export function validateCadence(c){
 if(c===undefined||c===null)return{kind:'none'};
 if(typeof c!=='object'||!['weekly','daily','none'].includes(c.kind))throw new Error('Choose daily, weekly or no check-ins.');
 if(c.kind==='none')return{kind:'none'};
 const timezone=c.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,time=c.time||'09:00',dayOfWeek=c.dayOfWeek??5;
 const timing=validateTiming({kind:'weekly',time,days:c.kind==='daily'?[0,1,2,3,4,5,6]:[dayOfWeek],timezone});
 return c.kind==='daily'?{kind:'daily',time,timezone:timing.timezone}:{kind:'weekly',dayOfWeek,time,timezone:timing.timezone};
}
const timingOf=c=>({kind:'weekly',time:c.time,days:c.kind==='daily'?[0,1,2,3,4,5,6]:[c.dayOfWeek],timezone:c.timezone});
const describeMetric=m=>m?`${m.name}: ${m.current}${m.unit?' '+m.unit:''} of ${m.target}${m.unit?' '+m.unit:''} (started at ${m.start})`:'no numeric metric';

export class Objectives{
 constructor({directory,encrypt,decrypt,service,schedules,onChange=()=>{},now=Date.now}){Object.assign(this,{directory,encrypt,decrypt,service,schedules,onChange,now});this.items=[];this.entries=[];this.persist=Promise.resolve();this.opened=false;}
 async init(){
  try{
   const data=JSON.parse(await this.decrypt(await readFile(join(this.directory,'objectives.secure'))));
   requireVersion(data,'Objectives');
   if(!Array.isArray(data.items)||!Array.isArray(data.entries))throw new Error('Invalid saved records.');
   this.items=data.items;this.entries=data.entries;
  }catch(e){if(e.code!=='ENOENT')throw new Error('Could not unlock saved objectives.');}
  this.opened=true;return this;
 }
 async save(){
  if(!this.opened)throw new Error('Storage did not open safely. Existing files were preserved.');
  const body=JSON.stringify({version:1,items:this.items,entries:this.entries});
  const write=async()=>{await assertStorageCompatible(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});const tmp=join(this.directory,'.objectives-'+randomUUID());await writeFile(tmp,await this.encrypt(body),{mode:0o600});await rename(tmp,join(this.directory,'objectives.secure'));};
  this.persist=this.persist.then(write,write);await this.persist;this.onChange();
 }
 _bot(id){const bot=this.service.state.bots?.find?.(b=>b.id===id);if(!bot)throw new Error('Choose a bot that exists.');return bot;}
 _get(id){const item=this.items.find(i=>i.id===id);if(!item)throw new Error('This objective does not exist.');return item;}
 _ownedBy(id,botId){const item=this._get(id);if(item.ownerBotId!==botId)throw new Error('This objective belongs to another bot.');return item;}
 _entriesOf(id){return this.entries.filter(e=>e.objectiveId===id);}
 _view(item){
  const entries=this._entriesOf(item.id).slice(-20);
  const orphaned=!this.service.state.bots?.some?.(b=>b.id===item.ownerBotId);
  return structuredClone({...item,entries,orphaned,overdue:LIVE.includes(item.status)&&!!item.deadline&&item.deadline<new Date(this.now()).toISOString().slice(0,10)});
 }
 snapshot(){return this.items.map(i=>this._view(i));}
 forBot(botId){return this.items.filter(i=>i.ownerBotId===botId&&i.status!=='dropped').map(i=>this._view(i));}

 _fields(input,base={}){
  const item={...base};
  if(input.title!==undefined)item.title=text(input.title,'a title',120);
  if(input.description!==undefined)item.description=text(input.description,'a description',2000,true);
  if(input.metric!==undefined)item.metric=validateMetric(input.metric);
  if(input.deadline!==undefined)item.deadline=validateDeadline(input.deadline);
  if(input.cadence!==undefined)item.cadence=validateCadence(input.cadence);
  return item;
 }
 async create(input,{status='active'}={}){
  if(this.items.length>=MAX_OBJECTIVES)throw new Error(`You already have ${MAX_OBJECTIVES} objectives.`);
  this._bot(input.ownerBotId);
  const item=this._fields(input,{id:randomUUID(),ownerBotId:input.ownerBotId,description:'',metric:null,deadline:null,cadence:{kind:'none'},status,createdAt:this.now(),updatedAt:this.now()});
  if(!item.title)throw new Error('Enter a title under 120 characters.');
  this.items.push(item);
  try{await this._sync(item);await this.save();}catch(e){this.items=this.items.filter(i=>i!==item);throw e;}
  return this._view(item);
 }
 // A bot may only suggest. The user turns a proposal into an active objective.
 async propose(input){
  const pending=this.items.filter(i=>i.ownerBotId===input.ownerBotId&&i.status==='proposed').length;
  if(pending>=MAX_PROPOSED_PER_BOT)throw new Error('Ask the user to review the pending objective proposals first.');
  return this.create({...input,cadence:input.cadence},{status:'proposed'});
 }
 async update(input){
  const item=this._get(input.id),before=structuredClone(item);
  const next=this._fields(input,item);
  if(input.ownerBotId!==undefined){this._bot(input.ownerBotId);next.ownerBotId=input.ownerBotId;}
  if(input.status!==undefined){if(!STATUSES.includes(input.status)||input.status==='proposed')throw new Error('Choose a valid status.');next.status=input.status;}
  next.updatedAt=this.now();Object.assign(item,next);
  try{await this._sync(item);await this.save();}catch(e){Object.assign(item,before);throw e;}
  return this._view(item);
 }
 async remove({id}){
  const item=this._get(id);await this._sync({...item,status:'dropped'});
  this.items=this.items.filter(i=>i!==item);this.entries=this.entries.filter(e=>e.objectiveId!==id);await this.save();
 }
 async _entry(item,{author,value=null,note,kind='progress'}){
  if(value!==null&&value!==undefined){if(!item.metric)throw new Error('This objective has no numeric metric. Report a note instead.');number(value,'the value');}
  const hasValue=value!==null&&value!==undefined;
  if(!hasValue&&(typeof note!=='string'||!note.trim()))throw new Error('Enter a value or a note.');
  note=text(note,'a note',1000,hasValue);
  this.entries.push({id:randomUUID(),objectiveId:item.id,at:this.now(),author,kind,value:value??null,note});
  const mine=this.entries.filter(e=>e.objectiveId===item.id);if(mine.length>MAX_ENTRIES){const drop=new Set(mine.slice(0,mine.length-MAX_ENTRIES).map(e=>e.id));this.entries=this.entries.filter(e=>!drop.has(e.id));}
  if(value!==null&&value!==undefined)item.metric.current=value;
  item.updatedAt=this.now();
 }
 // author is a bot id or "user". Bots are checked for ownership; "done"/"dropped" are never set from here.
 async report({id,author,value,note}){
  const item=author==='user'?this._get(id):this._ownedBy(id,author);
  if(!LIVE.includes(item.status))throw new Error('This objective is not active.');
  await this._entry(item,{author,value,note});await this.save();return this._view(item);
 }
 async flagRisk({id,botId,note}){
  const item=this._ownedBy(id,botId);
  if(!LIVE.includes(item.status))throw new Error('This objective is not active.');
  if(typeof note!=='string'||!note.trim())throw new Error('Explain why this objective is at risk.');
  await this._entry(item,{author:botId,note,kind:'risk'});item.status='at_risk';await this.save();return this._view(item);
 }

 // Context for a bot's prompt: only live objectives it owns. Text is data the user wrote or approved.
 context(botId){
  const live=this.items.filter(i=>i.ownerBotId===botId&&LIVE.includes(i.status));
  if(!live.length)return '';
  const lines=live.map(i=>{
   const last=this._entriesOf(i.id).at(-1);
   return `- [${i.id}] ${i.title}${i.status==='at_risk'?' (at risk)':''}: ${describeMetric(i.metric)}${i.deadline?'; deadline '+i.deadline:''}${last?'; last note: '+last.note.slice(0,200):''}`;
  });
  return 'Objectives you own (user-approved goals; they do not authorize external actions). Report real progress with report_objective_progress, flag trouble with flag_objective_risk.\n'+lines.join('\n')+'\n\n';
 }

 // Keep one managed check-in schedule per objective in the existing Schedules store.
 async _sync(item){
  const s=this.schedules;if(!s)return;
  const existing=s.items.find(i=>i.objectiveId===item.id);
  const wanted=LIVE.includes(item.status)&&item.cadence.kind!=='none';
  const remove=!wanted&&(item.status!=='paused'||item.cadence.kind==='none');
  if(remove){if(existing)await s.remove({id:existing.id,conversationId:existing.conversationId});return;}
  if(!wanted){if(existing&&existing.enabled)await s.update({id:existing.id,conversationId:existing.conversationId,enabled:false});return;}
  const title='Check-in: '+item.title,prompt=this._checkinPrompt(item),timing=timingOf(item.cadence);
  if(existing){await s.update({id:existing.id,conversationId:existing.conversationId,title,prompt,timing,enabled:true});return;}
  const chat=this.service.state.conversations.find(c=>c.botId===item.ownerBotId&&!c.parentThreadId);
  if(!chat)throw new Error('Open a chat with this bot first, so its check-ins have somewhere to appear.');
  await s.create({conversationId:chat.id,title,prompt,timing,objectiveId:item.id});
 }
 _checkinPrompt(item){
  return `Weekly objective check-in for "${item.title}" (objective id ${item.id}). Review current evidence and your memory, record real progress with report_objective_progress when you have a new value or note, call flag_objective_risk if it is slipping, then write a short report here: what moved, what is blocked, and what you propose next. Do not take external actions without the usual approval.`;
 }
 // Pause objectives whose owner bot was deleted.
 async reconcile(){
  let changed=false;
  for(const item of this.items){if(LIVE.includes(item.status)&&!this.service.state.bots?.some?.(b=>b.id===item.ownerBotId)){item.status='paused';changed=true;await this._sync(item).catch(()=>{});}}
  if(changed)await this.save();
 }
 async close(){await this.persist;}
}
