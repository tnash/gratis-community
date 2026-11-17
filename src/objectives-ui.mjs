const $=id=>document.getElementById(id);
const STATUS={proposed:'Proposed',active:'On track',at_risk:'At risk',paused:'Paused',done:'Done',dropped:'Dropped'};
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export function setupObjectivesUI({api,getState}){
 let rows=[],pendingDelete=null,editId=null;
 const fail=e=>{$('objectives-error').textContent=e.message;$('objectives-error').hidden=false;};
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const botName=id=>getState()?.bots?.find(b=>b.id===id)?.name||'Deleted bot';
 const button=(label,action)=>{const b=el('button','quiet-button',label);b.type='button';b.onclick=async()=>{b.disabled=true;$('objectives-error').hidden=true;try{await action();await refresh();}catch(e){fail(e);}finally{b.disabled=false;}};return b;};
 const percent=m=>m?Math.max(0,Math.min(100,Math.round((m.current-m.start)/(m.target-m.start)*100))):null;
 const cadenceText=c=>c.kind==='none'?'No check-ins':c.kind==='daily'?'Daily at '+c.time:'Weekly, '+DAYS[c.dayOfWeek]+' at '+c.time;
 function log(item){
  const form=el('form','objective-log'),value=el('input'),note=el('input');
  value.type='number';value.step='any';value.placeholder=item.metric?item.metric.name:'No metric';value.disabled=!item.metric;value.setAttribute('aria-label','New value');
  note.maxLength=1000;note.placeholder='Note';note.setAttribute('aria-label','Progress note');
  const save=el('button','quiet-button','Log progress');save.type='submit';
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;$('objectives-error').hidden=true;try{await api.objectivesReport({id:item.id,value:value.value===''?undefined:Number(value.value),note:note.value});await refresh();}catch(err){fail(err);}finally{save.disabled=false;}};
  form.append(value,note,save);return form;
 }
 function card(item){
  const c=el('article','schedule-card objective-card');
  const head=el('h3',null,item.title);const chip=el('span','objective-status objective-'+item.status,item.overdue?'Overdue':STATUS[item.status]);head.append(' ',chip);
  const meta=el('p','schedule-meta',botName(item.ownerBotId)+(item.orphaned?' (deleted, reassign)':'')+' · '+cadenceText(item.cadence)+(item.deadline?' · due '+item.deadline:''));
  c.append(head,meta);
  if(item.description)c.append(el('p','schedule-prompt',item.description));
  if(item.metric){const pct=percent(item.metric),bar=el('progress');bar.max=100;bar.value=pct;bar.setAttribute('aria-label',item.metric.name+' progress');c.append(bar,el('p','schedule-meta',`${item.metric.name}: ${item.metric.current}${item.metric.unit?' '+item.metric.unit:''} of ${item.metric.target}${item.metric.unit?' '+item.metric.unit:''} (${pct}%)`));}
  const live=['active','at_risk'].includes(item.status);
  if(live)c.append(log(item));
  if(item.entries.length){const d=el('details');d.append(el('summary',null,'History ('+item.entries.length+')'));for(const e of item.entries.slice().reverse())d.append(el('p','schedule-meta',new Date(e.at).toLocaleDateString()+' · '+(e.author==='user'?'You':botName(e.author))+(e.kind==='risk'?' flagged risk':'')+(e.value!==null?' · '+e.value:'')+(e.note?' · '+e.note:'')));c.append(d);}
  const act=el('div','schedule-actions'),set=(label,status)=>button(label,()=>api.objectivesUpdate({id:item.id,status}));
  if(item.status==='proposed')act.append(set('Approve','active'),button('Dismiss',()=>api.objectivesRemove({id:item.id})));
  else{
   if(live)act.append(set('Pause','paused'),set('Mark done','done'));
   if(item.status==='paused')act.append(set('Resume','active'));
   if(item.status==='at_risk')act.append(set('Back on track','active'));
   act.append(button('Edit',async()=>edit(item)),button(pendingDelete===item.id?'Confirm delete':'Delete',async()=>{if(pendingDelete===item.id){await api.objectivesRemove({id:item.id});pendingDelete=null;}else pendingDelete=item.id;}));
  }
  c.append(act);return c;
 }
 function render(){$('objectives-empty').hidden=rows.length>0;$('objectives-list').replaceChildren(...rows.map(card));}
 function controls(){$('objective-day-row').hidden=$('objective-cadence').value!=='weekly';$('objective-time-row').hidden=$('objective-cadence').value==='none';}
 function reset(){editId=null;$('objective-form').reset();$('objective-editor').querySelector('summary').textContent='New objective';$('objective-save').textContent='Create objective';$('objective-day').value='5';controls();}
 function edit(item){
  editId=item.id;$('objective-editor').open=true;$('objective-editor').querySelector('summary').textContent='Edit objective';$('objective-save').textContent='Save objective';
  $('objective-title').value=item.title;$('objective-description').value=item.description;$('objective-deadline').value=item.deadline||'';
  $('objective-metric-name').value=item.metric?.name||'';$('objective-metric-unit').value=item.metric?.unit||'';$('objective-metric-start').value=item.metric?item.metric.start:'';$('objective-metric-target').value=item.metric?item.metric.target:'';
  $('objective-cadence').value=item.cadence.kind;$('objective-day').value=String(item.cadence.dayOfWeek??5);$('objective-time').value=item.cadence.time||'09:00';controls();
 }
 function input(){
  const name=$('objective-metric-name').value.trim(),target=$('objective-metric-target').value,start=$('objective-metric-start').value;
  const metric=name||target?{name,unit:$('objective-metric-unit').value,start:start===''?0:Number(start),target:target===''?NaN:Number(target)}:null;
  const kind=$('objective-cadence').value;
  return{title:$('objective-title').value,description:$('objective-description').value,deadline:$('objective-deadline').value||null,metric,cadence:kind==='none'?{kind}:{kind,time:$('objective-time').value,dayOfWeek:Number($('objective-day').value)}};
 }
 async function refresh(){rows=await api.objectivesView();render();}
 $('objective-cadence').onchange=controls;$('objective-cancel').onclick=reset;
 $('objective-form').onsubmit=async e=>{
  e.preventDefault();$('objective-save').disabled=true;$('objectives-error').hidden=true;
  try{const value=input();if(editId)await api.objectivesUpdate({...value,id:editId});else await api.objectivesCreate({...value,ownerBotId:getState()?.activeBotId});reset();$('objective-editor').open=false;await refresh();}
  catch(error){fail(error);}finally{$('objective-save').disabled=false;}
 };
 api.onObjectivesChanged?.(()=>{if(!$('workspace-objectives').hidden)void refresh().catch(fail);});reset();
 return{refresh};
}
