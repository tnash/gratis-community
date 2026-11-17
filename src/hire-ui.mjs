const $=id=>document.getElementById(id);
export function setupHire({api,onHired}){
 const dialog=$('hire-dialog');
 let step='sentence',questions=[],draft=null,pending=false,avatar={shape:'flower',color:'orange'};
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const fail=e=>{$('hire-error').textContent=e.message;$('hire-error').hidden=false;};
 const section=(title,items)=>{if(!items.length)return null;const s=el('section','hire-section');s.append(el('h3',null,title),...items);return s;};
 // Each item has a checkbox so the user decides what is created; text fields are editable.
 function item(text,{input=null}={}){const label=el('label','hire-item'),box=el('input');box.type='checkbox';box.checked=true;label.append(box);if(input){label.append(input);}else label.append(el('span',null,text));return{label,box};}
 const textInput=value=>{const i=el('input');i.value=value;i.maxLength=200;return i;};
 function renderDraft(){
  const d=draft,parts=[];
  const name=textInput(d.name);name.setAttribute('aria-label','Name');const instr=el('textarea');instr.value=d.instructions;instr.rows=5;instr.maxLength=4000;instr.setAttribute('aria-label','Instructions');
  const head=el('div','hire-section');head.append(el('h3',null,[d.role,d.personality].filter(Boolean).join(' · ')||'Teammate'),name,instr);parts.push(head);
  const objectives=d.objectives.map(o=>{const t=textInput(o.title);const it=item('',{input:t});it.label.title=(o.metric?`${o.metric.name}: ${o.metric.start} to ${o.metric.target}. `:'')+(o.cadence.kind==='none'?'No check-ins':'Check-ins '+o.cadence.kind);it.get=()=>it.box.checked?{...o,title:t.value}:null;return it;});
  const routines=d.routines.map(r=>{const it=item(`${r.title} · ${r.days.length===7?'daily':'weekly'} at ${r.time}`);it.get=()=>it.box.checked?r:null;return it;});
  const budget=d.budget?[(()=>{const it=item(`Limit: ${d.budget.limit} ${d.budget.unit==='toolCalls'?'tool calls':d.budget.unit} per ${d.budget.period}`);it.get=()=>it.box.checked?d.budget:null;return it;})()]:[];
  const policies=d.policies.map(p=>{const it=item(`${p.action==='deny'?'Block':'Ask me first'}: ${p.tool}. ${p.note}`);it.get=()=>it.box.checked?p:null;return it;});
  for(const [title,items] of [['Goals it will own',objectives],['Routines',routines],['Budget',budget],['Approval rules',policies]]){const s=section(title,items.map(i=>i.label));if(s)parts.push(s);}
  if(d.suggestedApps.length){const s=el('section','hire-section');s.append(el('h3',null,'Apps it would need'),el('p','schedule-note',d.suggestedApps.join(', ')+'. Connect them after hiring.'));parts.push(s);}
  $('hire-draft').replaceChildren(...parts);$('hire-draft').hidden=false;
  draft.collect=()=>({...d,name:name.value,instructions:instr.value,objectives:objectives.map(i=>i.get()).filter(Boolean),routines:routines.map(i=>i.get()).filter(Boolean),budget:budget[0]?.get()??null,policies:policies.map(i=>i.get()).filter(Boolean)});
 }
 function paint(){
  $('hire-sentence-row').hidden=step!=='sentence';$('hire-questions').hidden=step!=='questions';$('hire-draft').hidden=step!=='draft';
  $('hire-submit').textContent=pending?'Working…':step==='draft'?'Hire':step==='questions'?'Draft':'Draft';
  $('hire-submit').disabled=pending||(step==='sentence'&&!$('hire-sentence').value.trim());$('hire-cancel').disabled=pending;$('hire-sentence').disabled=pending;
 }
 function open(choice){if(choice)avatar=choice;step='sentence';questions=[];draft=null;pending=false;$('hire-sentence').value='';$('hire-error').hidden=true;$('hire-questions').replaceChildren();$('hire-draft').replaceChildren();paint();dialog.showModal();$('hire-sentence').focus();}
 $('hire-sentence').oninput=paint;
 const close=()=>{if(!pending)dialog.close();};
 $('hire-cancel').onclick=close;dialog.querySelector('.hire-close').onclick=close;dialog.addEventListener('cancel',e=>{if(pending)e.preventDefault();});
 $('hire-form').onsubmit=async e=>{
  e.preventDefault();if(pending)return;pending=true;$('hire-error').hidden=true;paint();
  try{
   if(step==='draft'){
    const state=await api.hireApply({draft:draft.collect(),avatarShape:avatar.shape,avatarColor:avatar.color});dialog.close();onHired(state);return;
   }
   const answers=[...$('hire-questions').querySelectorAll('input')].map(i=>i.value.trim()).filter(Boolean);
   const result=await api.hireDraft({sentence:$('hire-sentence').value,answers});
   if(result.error)throw new Error(result.error);
   if(result.questions){step='questions';$('hire-questions').replaceChildren(...result.questions.map(q=>{const l=el('label',null,q),i=el('input');i.maxLength=500;l.append(i);return l;}));}
   else{draft=result.draft;if(result.fallback){$('hire-error').textContent='No Claude or Codex login is connected, so this is a plain starting point.';$('hire-error').hidden=false;}step='draft';renderDraft();}
  }catch(error){fail(error);}finally{pending=false;paint();}
 };
 return{open};
}
