const $=id=>document.getElementById(id);
const UNIT={runs:'runs',toolCalls:'tool calls',minutes:'minutes'};
export function setupControlsUI({api,getState}){
 let data={paused:{},budgets:[],policies:[],events:[]},pendingDelete=null;
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const fail=e=>{$('controls-error').textContent=e.message;$('controls-error').hidden=false;};
 const botName=id=>id?getState()?.bots?.find(b=>b.id===id)?.name||'Deleted bot':'All bots';
 const button=(label,action)=>{const b=el('button','quiet-button',label);b.type='button';b.onclick=async()=>{b.disabled=true;$('controls-error').hidden=true;try{await action();await refresh();}catch(e){fail(e);}finally{b.disabled=false;}};return b;};
 const row=(title,meta,...actions)=>{const c=el('article','schedule-card');c.append(el('h3',null,title),el('p','schedule-meta',meta));if(actions.length){const a=el('div','schedule-actions');a.append(...actions);c.append(a);}return c;};
 const describe=p=>`${p.action==='deny'?'Deny':'Ask me first'}: ${p.tool}${p.condition?` when ${p.condition.field} ${p.condition.op} ${p.condition.value}`:''}`;
 function options(select,all){select.replaceChildren(...(all?[new Option('All bots','')]:[]),...(getState()?.bots||[]).map(b=>new Option(b.name,b.id)));}
 function render(){
  $('controls-bots').replaceChildren(...(getState()?.bots||[]).map(b=>{const paused=!!data.paused[b.id];return row(b.name,paused?'Paused. No new responses or scheduled tasks run.':'Active',button(paused?'Resume':'Pause',()=>api.controlsSetPaused({botId:b.id,paused:!paused})));}));
  $('controls-budgets').replaceChildren(...data.budgets.map(b=>row(`${botName(b.botId)}: ${b.limit} ${UNIT[b.unit]} per ${b.period==='total'?'lifetime':b.period}`,`Used ${b.spent} of ${b.limit}${b.resetsAt?' · resets '+new Date(b.resetsAt).toLocaleString():''}`,button(pendingDelete===b.id?'Confirm delete':'Delete',async()=>{if(pendingDelete===b.id){await api.controlsRemoveBudget({id:b.id});pendingDelete=null;}else pendingDelete=b.id;}))));
  $('controls-policies').replaceChildren(...data.policies.map(p=>row(describe(p),`${botName(p.botId)} · ${p.note}`,button(pendingDelete===p.id?'Confirm delete':'Delete',async()=>{if(pendingDelete===p.id){await api.controlsRemovePolicy({id:p.id});pendingDelete=null;}else pendingDelete=p.id;}))));
  $('controls-events').replaceChildren(...data.events.slice(0,50).map(e=>el('p','schedule-meta',`${new Date(e.at).toLocaleString()} · ${botName(e.botId)} · ${e.summary}`)));
  $('controls-budgets-empty').hidden=data.budgets.length>0;$('controls-policies-empty').hidden=data.policies.length>0;$('controls-events-empty').hidden=data.events.length>0;
 }
 async function refresh(){data=await api.controlsView();options($('budget-bot'),true);options($('policy-bot'),true);render();}
 const submit=(form,button,make,call)=>{$(form).onsubmit=async e=>{e.preventDefault();$(button).disabled=true;$('controls-error').hidden=true;try{await call(make());$(form).reset();await refresh();}catch(err){fail(err);}finally{$(button).disabled=false;}};};
 submit('budget-form','budget-save',()=>({botId:$('budget-bot').value||null,unit:$('budget-unit').value,period:$('budget-period').value,limit:Number($('budget-limit').value)}),v=>api.controlsSaveBudget(v));
 submit('policy-form','policy-save',()=>{const field=$('policy-field').value.trim();return{botId:$('policy-bot').value||null,tool:$('policy-tool').value,action:$('policy-action').value,note:$('policy-note').value,condition:field?{field,op:$('policy-op').value,value:isNaN(Number($('policy-value').value))||$('policy-value').value===''?$('policy-value').value:Number($('policy-value').value)}:null};},v=>api.controlsSavePolicy(v));
 api.onControlsChanged?.(()=>{if(!$('workspace-controls').hidden)void refresh().catch(fail);});
 return{refresh};
}
