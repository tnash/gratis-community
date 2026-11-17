import {requireVersion,assertStorageCompatible} from './storage-safety.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const UNITS=['runs','toolCalls','minutes'];
export const PERIODS=['day','week','month','total'];
export const OPS=['>','>=','<','<=','==','!=','contains'];
export const ACTIONS=['require_approval','deny'];
const MAX_BUDGETS=50,MAX_POLICIES=100,MAX_EVENTS=500;
const str=(v,label,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`Enter ${label} under ${max} characters.`);return v.trim();};

// Boundaries use this computer's local time, like schedules.
export function nextReset(period,from){
 const d=new Date(from);
 if(period==='day')return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).getTime();
 if(period==='week')return new Date(d.getFullYear(),d.getMonth(),d.getDate()+((8-d.getDay())%7||7)).getTime();
 if(period==='month')return new Date(d.getFullYear(),d.getMonth()+1,1).getTime();
 return null;
}
const glob=(pattern,name)=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*')+'$','i').test(name);
const pick=(obj,path)=>path.split('.').reduce((v,k)=>v!==null&&typeof v==='object'?v[k]:undefined,obj);
export function holds(condition,input){
 if(!condition)return true;
 const actual=pick(input,condition.field);if(actual===undefined)return false;
 const {op,value}=condition;
 if(op==='contains')return String(actual).toLowerCase().includes(String(value).toLowerCase());
 const a=Number(actual),b=Number(value),numeric=Number.isFinite(a)&&Number.isFinite(b)&&actual!==''&&actual!==null;
 if(op==='=='||op==='!='){const same=numeric?a===b:String(actual)===String(value);return op==='=='?same:!same;}
 if(!numeric)return false;
 return op==='>'?a>b:op==='>='?a>=b:op==='<'?a<b:a<=b;
}

export class Controls{
 constructor({directory,encrypt,decrypt,service,onChange=()=>{},now=Date.now}){Object.assign(this,{directory,encrypt,decrypt,service,onChange,now});this.data={paused:{},budgets:[],policies:[],events:[]};this.persist=Promise.resolve();this.opened=false;this.dirty=false;}
 async init(){
  try{
   const data=JSON.parse(await this.decrypt(await readFile(join(this.directory,'controls.secure'))));
   requireVersion(data,'Controls');
   if(!data.paused||!Array.isArray(data.budgets)||!Array.isArray(data.policies)||!Array.isArray(data.events))throw new Error('Invalid saved records.');
   this.data={paused:data.paused,budgets:data.budgets,policies:data.policies,events:data.events};
  }catch(e){if(e.code!=='ENOENT')throw new Error('Could not unlock saved controls.');}
  this.opened=true;return this;
 }
 async save(){
  if(!this.opened)throw new Error('Storage did not open safely. Existing files were preserved.');
  clearTimeout(this.timer);this.dirty=false;
  const body=JSON.stringify({version:1,...this.data});
  const write=async()=>{await assertStorageCompatible(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});const tmp=join(this.directory,'.controls-'+randomUUID());await writeFile(tmp,await this.encrypt(body),{mode:0o600});await rename(tmp,join(this.directory,'controls.secure'));};
  this.persist=this.persist.then(write,write);await this.persist;this.onChange();
 }
 // Activity events are frequent, so they are written after a short pause instead of one file write each.
 _later(){this.dirty=true;clearTimeout(this.timer);this.timer=setTimeout(()=>void this.save().catch(()=>{}),750);this.timer.unref?.();}
 async close(){clearTimeout(this.timer);if(this.dirty)await this.save().catch(()=>{});await this.persist;}
 _bot(id){if(id===null||id===undefined)return null;if(!this.service.state.bots?.some?.(b=>b.id===id))throw new Error('Choose a bot that exists.');return id;}
 log(kind,botId,summary,outcome){
  this.data.events.push({id:randomUUID(),at:this.now(),botId:botId??null,kind,summary:String(summary).slice(0,300),...(outcome?{outcome}:{})});
  if(this.data.events.length>MAX_EVENTS)this.data.events.splice(0,this.data.events.length-MAX_EVENTS);
  this._later();
 }

 // Pause
 isPaused(botId){return !!this.data.paused[botId];}
 async setPaused(botId,paused){
  this._bot(botId);
  if(paused)this.data.paused[botId]=this.now();else delete this.data.paused[botId];
  this.log('pause',botId,paused?'Paused':'Resumed');await this.save();
  if(paused)for(const id of [...this.service.tasks?.keys?.()||[]]){const c=this.service.state.conversations.find(c=>c.id===id);if(c?.botId===botId)await this.service.stop({conversationId:id}).catch(()=>{});}
 }

 // Budgets
 _roll(b){
  if(b.resetsAt&&this.now()>=b.resetsAt){b.spent=0;b.warned=false;b.resetsAt=nextReset(b.period,this.now());this._later();}
 }
 async saveBudget(input){
  const botId=this._bot(input.botId??null);
  if(!UNITS.includes(input.unit))throw new Error('Choose runs, tool calls or minutes.');
  if(!PERIODS.includes(input.period))throw new Error('Choose day, week, month or total.');
  const limit=Number(input.limit);if(!Number.isFinite(limit)||limit<=0||limit>1e6)throw new Error('Enter a limit above zero.');
  const warnAt=input.warnAt===undefined?0.8:Number(input.warnAt);if(!(warnAt>=0.5&&warnAt<=0.99))throw new Error('Warn threshold must be from 50% to 99%.');
  let b=this.data.budgets.find(b=>input.id?b.id===input.id:b.botId===botId&&b.unit===input.unit&&b.period===input.period);
  if(input.id&&!b)throw new Error('This budget does not exist.');
  if(!b){if(this.data.budgets.length>=MAX_BUDGETS)throw new Error(`You already have ${MAX_BUDGETS} budgets.`);b={id:randomUUID(),spent:0,warned:false,createdAt:this.now()};this.data.budgets.push(b);}
  const periodChanged=b.period!==input.period;
  Object.assign(b,{botId,unit:input.unit,period:input.period,limit,warnAt});
  if(periodChanged||b.resetsAt===undefined){b.resetsAt=nextReset(b.period,this.now());if(periodChanged){b.spent=0;b.warned=false;}}
  b.warned=b.spent>=warnAt*limit;
  await this.save();return structuredClone(b);
 }
 async removeBudget({id}){const n=this.data.budgets.length;this.data.budgets=this.data.budgets.filter(b=>b.id!==id);if(this.data.budgets.length===n)throw new Error('This budget does not exist.');await this.save();}
 _applicable(botId,unit){return this.data.budgets.filter(b=>b.unit===unit&&(b.botId===null||b.botId===botId));}
 _label(b){return `${b.botId?'Bot':'Global'} ${b.period} ${{runs:'run',toolCalls:'tool call',minutes:'minute'}[b.unit]} budget`;}
 _spend(botId,unit,amount){
  let exceeded=null;
  for(const b of this._applicable(botId,unit)){
   this._roll(b);b.spent=Math.round((b.spent+amount)*100)/100;
   if(!b.warned&&b.spent>=b.warnAt*b.limit){b.warned=true;this.log('budget',botId,`${this._label(b)} is at ${b.spent} of ${b.limit}`,'warning');}
   if(b.spent>b.limit&&!exceeded)exceeded=this._blockMessage(b);
  }
  this._later();return exceeded;
 }
 _blockMessage(b){return `${this._label(b)} reached (${b.spent} of ${b.limit}). Raise it in Controls${b.resetsAt?' or wait until '+new Date(b.resetsAt).toLocaleString():''}.`;}
 // Called when a response is about to start. Returns {paused}|{limit}|null.
 runStart(botId){
  if(this.isPaused(botId)){this.log('pause',botId,'Blocked a run: bot is paused','blocked');return{paused:'This bot is paused. Resume it in Controls to continue.'};}
  for(const unit of ['runs','minutes','toolCalls'])for(const b of this._applicable(botId,unit)){this._roll(b);if(b.spent>=b.limit){this.log('budget',botId,this._label(b)+' blocked a run','blocked');return{limit:this._blockMessage(b)};}}
  this._spend(botId,'runs',1);this.log('run',botId,'Run started');return null;
 }
 recordTool(botId,name){this.log('tool',botId,'Tool: '+name);return this._spend(botId,'toolCalls',1);}
 runEnd(botId,status,ms){this._spend(botId,'minutes',ms/60000);this.log('run',botId,'Run '+status,status);}

 // Policies
 async savePolicy(input){
  const botId=this._bot(input.botId??null);
  if(!ACTIONS.includes(input.action))throw new Error('Choose require approval or deny.');
  const policy={botId,tool:str(input.tool,'a tool name',120),action:input.action,note:str(input.note,'a note',200),condition:null};
  if(input.condition){
   const c=input.condition;
   if(!OPS.includes(c.op)||typeof c.field!=='string'||!/^[\w.]{1,80}$/.test(c.field))throw new Error('Enter a field name and choose a comparison.');
   if(!['string','number'].includes(typeof c.value)||String(c.value).length>200||String(c.value)==='')throw new Error('Enter a value to compare with.');
   if(c.op!=='contains'&&c.op!=='=='&&c.op!=='!='&&!Number.isFinite(Number(c.value)))throw new Error('Enter a number to compare with.');
   policy.condition={field:c.field,op:c.op,value:c.value};
  }
  let p=input.id?this.data.policies.find(p=>p.id===input.id):null;
  if(input.id&&!p)throw new Error('This rule does not exist.');
  if(!p){if(this.data.policies.length>=MAX_POLICIES)throw new Error(`You already have ${MAX_POLICIES} rules.`);p={id:randomUUID(),createdAt:this.now()};this.data.policies.push(p);}
  Object.assign(p,policy);await this.save();return structuredClone(p);
 }
 async removePolicy({id}){const n=this.data.policies.length;this.data.policies=this.data.policies.filter(p=>p.id!==id);if(this.data.policies.length===n)throw new Error('This rule does not exist.');await this.save();}
 // deny beats require_approval; a rule for this bot is reported before a global one.
 gate(botId,tool,input){
  const hits=this.data.policies.filter(p=>(p.botId===null||p.botId===botId)&&glob(p.tool,tool)&&holds(p.condition,input||{}));
  const rank=p=>(p.action==='deny'?0:2)+(p.botId===botId?0:1);
  const hit=hits.sort((a,b)=>rank(a)-rank(b))[0];
  if(!hit)return null;
  this.log('policy',botId,`${hit.action==='deny'?'Denied':'Asked approval for'} ${tool}: ${hit.note}`,hit.action);
  return{action:hit.action,note:hit.note};
 }

 snapshot(){
  for(const b of this.data.budgets)this._roll(b);
  return structuredClone({paused:this.data.paused,budgets:this.data.budgets,policies:this.data.policies,events:this.data.events.slice(-150).reverse()});
 }
}
