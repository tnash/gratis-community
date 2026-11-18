const $=id=>document.getElementById(id);
const STATUS={open:'To do',in_progress:'In progress',blocked:'Blocked',done:'Done'};
const STATE={unchanged:'Exists, unchanged',changed_since_recorded:'Exists, changed since recorded',missing:'Missing',recorded:'Written summary'};
export function setupTeamBoardUI({api}){
 let data={tasks:[],team:[]},pendingDelete=null;const checks=new Map(),reads=new Map();
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const fail=e=>{$('teamboard-error').textContent=e.message;$('teamboard-error').hidden=false;};
 const name=id=>data.team.find(b=>b.id===id)?.name||'Deleted teammate';
 const button=(label,action)=>{const b=el('button','quiet-button',label);b.type='button';b.onclick=async()=>{b.disabled=true;$('teamboard-error').hidden=true;try{await action();await refresh();}catch(e){fail(e);}finally{b.disabled=false;}};return b;};
 const when=t=>new Date(t).toLocaleString();
 function teammate(b){
  const c=el('article','schedule-card'),h=el('h3',null,b.name);if(b.chief)h.append(' ',el('span','objective-status','Chief'));
  const t=b.tasks;c.append(h,el('p','schedule-meta',`${t.open} to do · ${t.inProgress} in progress · ${t.blocked} blocked · ${t.done} done · ${b.fileCount} file${b.fileCount===1?'':'s'}${b.lastFileAt?' · last file '+when(b.lastFileAt):''}`));
  if(b.about)c.append(el('p','schedule-prompt',b.about));return c;
 }
 function output(task,o){
  const row=el('div'),check=checks.get(task.id)?.outputs.find(x=>x.id===o.id);
  row.append(el('p','schedule-meta',`${o.kind==='file'?o.path+' · '+o.bytes+' bytes':'Summary'} · ${when(o.at)}${o.summary?' · '+o.summary:''}`));
  if(check)row.append(el('p','schedule-meta '+(check.exists&&check.state!=='changed_since_recorded'?'teamboard-ok':'teamboard-bad'),'Verified now: '+STATE[check.state]));
  const shown=reads.get(o.id);if(shown)row.append(el('pre',null,shown));
  const a=el('div','schedule-actions');a.append(button(shown?'Hide':'Read',async()=>{if(shown)reads.delete(o.id);else{const r=await api.teamboardRead({id:task.id,outputId:o.id});reads.set(o.id,r.kind==='note'?r.summary:r.nonText&&!r.text?'(Not a text file.)':r.text+(r.truncated?'\n…':''));}}));row.append(a);return row;
 }
 function taskCard(task){
  const c=el('article','schedule-card');c.append(el('h3',null,task.title),el('p','schedule-meta',`${name(task.assigneeId)} · created by ${task.createdBy===data.chiefId?'chief':name(task.createdBy)} · ${when(task.updatedAt)}`));
  if(task.description)c.append(el('p','schedule-prompt',task.description));
  const select=el('select');select.setAttribute('aria-label','Status of '+task.title);for(const [v,l] of Object.entries(STATUS))select.append(new Option(l,v));select.value=task.status;
  select.onchange=async()=>{$('teamboard-error').hidden=true;try{await api.teamboardUpdate({id:task.id,status:select.value});await refresh();}catch(e){fail(e);}};c.append(select);
  const v=checks.get(task.id);
  if(task.status==='done'&&!task.outputs.length)c.append(el('p','schedule-meta teamboard-bad','Marked done, but no output was recorded.'));
  if(v)c.append(el('p','schedule-meta '+(v.confirmed?'teamboard-ok':'teamboard-bad'),v.confirmed?'Outputs confirmed on disk.':'Outputs not confirmed.'));
  for(const o of task.outputs)c.append(output(task,o));
  if(task.notes.length){const d=el('details');d.append(el('summary',null,'Notes ('+task.notes.length+')'));for(const n of task.notes.slice().reverse())d.append(el('p','schedule-meta',`${when(n.at)} · ${name(n.by)} · ${n.text}`));c.append(d);}
  const a=el('div','schedule-actions');
  if(task.outputs.length)a.append(button('Verify outputs',async()=>{checks.set(task.id,await api.teamboardVerify({id:task.id}));}));
  a.append(button(pendingDelete===task.id?'Confirm delete':'Delete',async()=>{if(pendingDelete===task.id){await api.teamboardRemove({id:task.id});pendingDelete=null;}else pendingDelete=task.id;}));c.append(a);return c;
 }
 function render(){
  $('teamboard-team').replaceChildren(...data.team.map(teammate));
  const keep=$('teamboard-assignee').value;$('teamboard-assignee').replaceChildren(...data.team.map(b=>new Option(b.name+(b.chief?' (chief)':''),b.id)));if(keep)$('teamboard-assignee').value=keep;
  const order=Object.keys(STATUS),tasks=data.tasks.slice().sort((a,b)=>order.indexOf(a.status)-order.indexOf(b.status)||b.updatedAt-a.updatedAt);
  $('teamboard-list').replaceChildren(...tasks.map(taskCard));$('teamboard-empty').hidden=tasks.length>0;
 }
 async function refresh(){data=await api.teamboardView();render();}
 $('teamboard-form').onsubmit=async e=>{
  e.preventDefault();$('teamboard-save').disabled=true;$('teamboard-error').hidden=true;
  try{await api.teamboardCreate({title:$('teamboard-title').value,description:$('teamboard-description').value,assigneeId:$('teamboard-assignee').value});$('teamboard-title').value='';$('teamboard-description').value='';await refresh();}
  catch(error){fail(error);}finally{$('teamboard-save').disabled=false;}
 };
 api.onTeamboardChanged?.(()=>{if(!$('workspace-teamboard').hidden)void refresh().catch(fail);});
 return{refresh};
}
