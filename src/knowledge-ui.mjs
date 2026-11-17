const $=id=>document.getElementById(id);
const VIS={owner_only:'Only you',selected_bots:'Selected bots',space:'All your bots'};
const KIND={search:'searched',get:'read',context:'was given an excerpt of'};
export function setupKnowledgeUI({api,getState}){
 let data={items:[],log:[]},pendingDelete=null,editId=null;
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const fail=e=>{$('knowledge-error').textContent=e.message;$('knowledge-error').hidden=false;};
 const bots=()=>getState()?.bots||[];
 const botName=id=>bots().find(b=>b.id===id)?.name||'Deleted bot';
 const button=(label,action)=>{const b=el('button','quiet-button',label);b.type='button';b.onclick=async()=>{b.disabled=true;$('knowledge-error').hidden=true;try{await action();await refresh();}catch(e){fail(e);}finally{b.disabled=false;}};return b;};
 const readers=(vis,ids)=>vis==='owner_only'?'Nobody but you':vis==='space'?'Every bot ('+bots().map(b=>b.name).join(', ')+')':ids.length?ids.map(botName).join(', '):'No bots chosen';
 // Checkboxes for the bots allowed to read; reports the choice so the card can state it plainly.
 function picker(initial,onChange){
  const box=el('div','knowledge-bots');
  for(const b of bots()){const l=el('label','hire-item'),c=el('input');c.type='checkbox';c.value=b.id;c.checked=initial.includes(b.id);c.onchange=onChange;l.append(c,el('span',null,b.name));box.append(l);}
  return{box,value:()=>[...box.querySelectorAll('input:checked')].map(c=>c.value)};
 }
 function proposalCard(item){
  const c=el('article','schedule-card'),head=el('h3',null,item.title);
  const who=item.source.botId?botName(item.source.botId):'A bot';
  c.append(head,el('p','schedule-meta',`Suggested by ${who}${item.source.fromExternalContent?' · based on outside content':''}`),el('p','schedule-prompt',item.body.slice(0,600)+(item.body.length>600?'…':'')));
  const select=el('select');select.setAttribute('aria-label','Who can read it');for(const [v,l] of [['selected_bots','Selected bots'],['space','All your bots']])select.append(new Option(l,v));
  const pick=picker(item.source.botId?[item.source.botId]:[],()=>sync());
  const summary=el('p','schedule-meta'),approve=button('Approve',()=>api.knowledgeUpdate({id:item.id,status:'approved',visibility:select.value,allowedBotIds:pick.value()}));
  function sync(){pick.box.hidden=select.value!=='selected_bots';summary.textContent='If approved, readable by: '+readers(select.value,pick.value());}
  select.onchange=sync;sync();
  c.append(select,pick.box,summary);const a=el('div','schedule-actions');a.append(approve,button('Reject',()=>api.knowledgeRemove({id:item.id})));c.append(a);return c;
 }
 function noteCard(item){
  const c=el('article','schedule-card'),head=el('h3',null,item.title);
  head.append(' ',el('span','objective-status',item.status==='retired'?'Retired':VIS[item.visibility]),' ',el('span','schedule-meta','v'+item.version));
  c.append(head,el('p','schedule-meta',`Readable by: ${item.status==='retired'?'nobody (retired)':readers(item.visibility,item.allowedBotIds)}${item.tags.length?' · '+item.tags.join(', '):''}`),el('p','schedule-prompt',item.body.slice(0,300)+(item.body.length>300?'…':'')));
  if(item.history.length){const d=el('details');d.append(el('summary',null,'History ('+item.history.length+')'));for(const h of item.history.slice().reverse())d.append(el('p','schedule-meta',`v${h.version} · ${new Date(h.at).toLocaleDateString()} · ${h.title}`));c.append(d);}
  const a=el('div','schedule-actions');
  a.append(button('Edit',async()=>edit(item)),button(item.status==='retired'?'Restore':'Retire',()=>api.knowledgeUpdate({id:item.id,status:item.status==='retired'?'approved':'retired'})),button(pendingDelete===item.id?'Confirm delete':'Delete',async()=>{if(pendingDelete===item.id){await api.knowledgeRemove({id:item.id});pendingDelete=null;}else pendingDelete=item.id;}));
  c.append(a);return c;
 }
 function render(){
  const proposed=data.items.filter(i=>i.status==='proposed'),notes=data.items.filter(i=>i.status!=='proposed');
  $('knowledge-proposals').replaceChildren(...proposed.map(proposalCard));$('knowledge-proposals-section').hidden=!proposed.length;
  $('knowledge-list').replaceChildren(...notes.map(noteCard));$('knowledge-empty').hidden=notes.length>0;
  $('knowledge-log').replaceChildren(...data.log.slice(0,30).map(l=>el('p','schedule-meta',`${new Date(l.at).toLocaleString()} · ${botName(l.botId)} ${KIND[l.kind]} "${l.title}" (v${l.version})`)));$('knowledge-log-empty').hidden=data.log.length>0;
  renderPicker();
 }
 let formPick=null;
 function renderPicker(keep){
  const ids=keep??(formPick?formPick.value():[]);formPick=picker(ids,()=>{});$('knowledge-form-bots').replaceChildren(formPick.box);syncForm();
 }
 function syncForm(){$('knowledge-form-bots').hidden=$('knowledge-visibility').value!=='selected_bots';}
 function reset(){editId=null;$('knowledge-form').reset();$('knowledge-editor').querySelector('summary').textContent='New note';$('knowledge-save').textContent='Save note';renderPicker([]);}
 function edit(item){
  editId=item.id;$('knowledge-editor').open=true;$('knowledge-editor').querySelector('summary').textContent='Edit note';$('knowledge-save').textContent='Save changes';
  $('knowledge-title').value=item.title;$('knowledge-body').value=item.body;$('knowledge-tags').value=item.tags.join(', ');$('knowledge-visibility').value=item.visibility;renderPicker(item.allowedBotIds);
 }
 async function refresh(){data=await api.knowledgeView();render();}
 $('knowledge-visibility').onchange=syncForm;$('knowledge-cancel').onclick=reset;
 $('knowledge-form').onsubmit=async e=>{
  e.preventDefault();$('knowledge-save').disabled=true;$('knowledge-error').hidden=true;
  try{
   const visibility=$('knowledge-visibility').value;
   const input={title:$('knowledge-title').value,body:$('knowledge-body').value,tags:$('knowledge-tags').value.split(',').map(t=>t.trim()).filter(Boolean),visibility,allowedBotIds:visibility==='selected_bots'?formPick.value():[]};
   if(editId)await api.knowledgeUpdate({...input,id:editId});else await api.knowledgeCreate(input);
   reset();$('knowledge-editor').open=false;await refresh();
  }catch(error){fail(error);}finally{$('knowledge-save').disabled=false;}
 };
 api.onKnowledgeChanged?.(()=>{if(!$('workspace-knowledge').hidden)void refresh().catch(fail);});
 return{refresh};
}
