import {requireVersion,assertStorageCompatible} from './storage-safety.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const LEVELS=['off','low','medium','high'];
const RISKS=['low','medium','high'];
// Highest model-declared risk that may start without waiting for the user.
const AUTO_RISK={medium:['low'],high:['low','medium']};
const COOLDOWN_MS=14*86400000,DAY_MS=86400000,MAX_PENDING=10,MAX_KEPT=200,RAISE_AFTER=5;
const norm=s=>String(s).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const str=(v,label,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(`Enter ${label} under ${max} characters.`);return v.trim();};
const minutes=t=>{const [h,m]=t.split(':').map(Number);return h*60+m;};

export class Proactivity{
 constructor({directory,encrypt,decrypt,service,controls,objectives,busy=()=>false,onChange=()=>{},now=Date.now}){Object.assign(this,{directory,encrypt,decrypt,service,controls,objectives,busy,onChange,now});this.data={levels:{},quiet:null,proposals:[],stats:{},autoAt:{}};this.persist=Promise.resolve();this.opened=false;this.ticking=false;this.closed=false;}
 async init(){
  try{
   const data=JSON.parse(await this.decrypt(await readFile(join(this.directory,'proactivity.secure'))));
   requireVersion(data,'Proactivity');
   if(!data.levels||!Array.isArray(data.proposals)||!data.stats||!data.autoAt)throw new Error('Invalid saved records.');
   this.data={levels:data.levels,quiet:data.quiet??null,proposals:data.proposals,stats:data.stats,autoAt:data.autoAt};
  }catch(e){if(e.code!=='ENOENT')throw new Error('Could not unlock saved proactivity settings.');}
  this.opened=true;return this;
 }
 async save(){
  if(!this.opened)throw new Error('Storage did not open safely. Existing files were preserved.');
  const body=JSON.stringify({version:1,...this.data});
  const write=async()=>{await assertStorageCompatible(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});const tmp=join(this.directory,'.proactivity-'+randomUUID());await writeFile(tmp,await this.encrypt(body),{mode:0o600});await rename(tmp,join(this.directory,'proactivity.secure'));};
  this.persist=this.persist.then(write,write);await this.persist;this.onChange();
 }
 level(botId){return this.data.levels[botId]??'low';}
 async setLevel(botId,level){
  if(!this.service.state.bots?.some?.(b=>b.id===botId))throw new Error('Choose a bot that exists.');
  if(!LEVELS.includes(level))throw new Error('Choose off, low, medium or high.');
  this.data.levels[botId]=level;this.data.stats[botId]={approved:0,rejected:0};
  this.controls?.log('policy',botId,'Proactivity set to '+level);await this.save();
 }
 async setQuietHours(quiet){
  if(quiet!==null&&(typeof quiet!=='object'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end||'')))throw new Error('Choose quiet hours as HH:mm to HH:mm.');
  this.data.quiet=quiet?{start:quiet.start,end:quiet.end}:null;await this.save();
 }
 _quiet(){
  const q=this.data.quiet;if(!q||q.start===q.end)return false;
  const d=new Date(this.now()),m=d.getHours()*60+d.getMinutes(),s=minutes(q.start),e=minutes(q.end);
  return s<e?m>=s&&m<e:m>=s||m<e;
 }
 _autoUsed(botId){return (this.data.autoAt[botId]||[]).filter(t=>this.now()-t<DAY_MS).length;}

 // Called by a bot. Never executes anything itself: it queues, or marks a low-risk step ready to start.
 async propose({botId,conversationId,action,rationale,expectedImpact,riskLevel,objectiveId,fromExternalContent=false}){
  if(!this.service.state.bots?.some?.(b=>b.id===botId))throw new Error('Unknown bot.');
  const level=this.level(botId);if(level==='off')throw new Error('The user has turned proactive suggestions off for this bot.');
  action=str(action,'an action',300);rationale=str(rationale,'a rationale',600);expectedImpact=str(expectedImpact,'an expected impact',300);
  if(!RISKS.includes(riskLevel))throw new Error('Choose low, medium or high risk.');
  if(objectiveId){const o=this.objectives?.items.find(i=>i.id===objectiveId);if(!o||o.ownerBotId!==botId)throw new Error('That objective does not belong to this bot.');}
  const key=norm(action);
  if(this.data.proposals.some(p=>p.botId===botId&&p.key===key&&['pending','approved'].includes(p.status)))throw new Error('This step is already waiting.');
  const rejected=this.data.proposals.find(p=>p.botId===botId&&p.key===key&&p.status==='rejected'&&this.now()-p.resolvedAt<COOLDOWN_MS);
  if(rejected)throw new Error('The user rejected this step recently. Do not suggest it again for two weeks.');
  if(this.data.proposals.filter(p=>p.botId===botId&&p.status==='pending').length>=MAX_PENDING)throw new Error('Too many suggestions are waiting for review.');
  const auto=!fromExternalContent&&(AUTO_RISK[level]||[]).includes(riskLevel)&&this._autoUsed(botId)<1;
  const p={id:randomUUID(),botId,conversationId,objectiveId:objectiveId||null,action,key,rationale,expectedImpact,riskLevel,fromExternalContent:!!fromExternalContent,status:auto?'approved':'pending',auto,createdAt:this.now()};
  this.data.proposals.push(p);this._trim();
  this.controls?.log('policy',botId,(auto?'Queued to start: ':'Suggested: ')+action.slice(0,120),auto?'auto':'pending');
  await this.save();
  return{id:p.id,status:p.status,message:auto?'Approved to start automatically; it will run when this chat is free.':'Waiting for the user to review it.'};
 }
 _trim(){if(this.data.proposals.length>MAX_KEPT){const done=this.data.proposals.filter(p=>!['pending','approved'].includes(p.status));const drop=new Set(done.slice(0,this.data.proposals.length-MAX_KEPT).map(p=>p.id));this.data.proposals=this.data.proposals.filter(p=>!drop.has(p.id));}}
 async resolve({id,approve}){
  const p=this.data.proposals.find(p=>p.id===id);if(!p||p.status!=='pending')throw new Error('This suggestion is no longer waiting.');
  const stats=this.data.stats[p.botId]??={approved:0,rejected:0};
  p.resolvedAt=this.now();p.status=approve?'approved':'rejected';p.auto=false;approve?stats.approved++:stats.rejected++;
  this.controls?.log('approval',p.botId,(approve?'Approved suggestion: ':'Rejected suggestion: ')+p.action.slice(0,120),approve?'approved':'declined');
  await this.save();return structuredClone(p);
 }
 async remove({id}){const n=this.data.proposals.length;this.data.proposals=this.data.proposals.filter(p=>p.id!==id);if(n===this.data.proposals.length)throw new Error('This suggestion does not exist.');await this.save();}

 _text(p){
  const o=p.objectiveId&&this.objectives?.items.find(i=>i.id===p.objectiveId);
  return `Approved next step${o?` for the objective "${o.title}"`:''}: ${p.action}\nWhy: ${p.rationale}\nExpected impact: ${p.expectedImpact}\nCarry it out now with your tools and report what you did. Ask for the usual approval before sending, purchasing, publishing or deleting anything.`;
 }
 // Start approved steps once their chat is idle. Auto-approved ones also wait out quiet hours.
 async tick(){
  if(this.ticking||this.closed)return;this.ticking=true;
  try{
   for(const p of this.data.proposals.filter(p=>p.status==='approved')){
    const c=this.service.state.conversations.find(c=>c.id===p.conversationId);
    if(!c){p.status='failed';p.error='The chat was deleted.';await this.save();continue;}
    if(this.service.closing||this.busy(c)||this.controls?.isPaused(p.botId)||this.level(p.botId)==='off')continue;
    if(p.auto&&this._quiet())continue;
    try{
     await this.service._deliver(c,this._text(p),[],{scheduled:{id:p.id,runId:randomUUID(),title:'Next step: '+p.action.slice(0,60),scheduledFor:this.now()}});
     p.status='started';p.executedAt=this.now();
     if(p.auto)(this.data.autoAt[p.botId]??=[]).push(this.now());
    }catch(e){p.status='failed';p.error=e.message;}
    await this.save();
   }
  }finally{this.ticking=false;}
 }
 start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),5000);this.timer.unref?.();}
 async close(){this.closed=true;clearInterval(this.timer);await this.persist;}

 snapshot(){
  const suggestRaise={};
  for(const [botId,s] of Object.entries(this.data.stats)){const l=this.level(botId);if(s.approved>=RAISE_AFTER&&s.rejected===0&&(l==='low'||l==='medium'))suggestRaise[botId]=LEVELS[LEVELS.indexOf(l)+1];}
  return structuredClone({levels:this.data.levels,quiet:this.data.quiet,suggestRaise,proposals:this.data.proposals.slice(-50).reverse().map(({key,...p})=>p)});
 }
}
