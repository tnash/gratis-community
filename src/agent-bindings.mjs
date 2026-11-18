// Per-run tool bindings for the stores that exist in both the desktop app and the headless runtime.
// `stores` is read at call time because the desktop creates them one at a time during startup.
export function agentBindings(stores,args){
 const {service,schedules,objectives,proactivity,knowledge,teamBoard}=stores();
 const c=service._conversation(args.conversationId),botId=args.bot.id,root=c.parentThreadId?service._conversation(c.parentThreadId):c;
 const messaging=c.messaging,tools=!messaging||messaging.allowTools;
 const source=service.promptMessages(root).findLast(m=>m.role==='user');
 const schedule=!tools?undefined:{
  list:()=>schedules.snapshot(root.id),
  create:input=>{if(c.parentThreadId||source?.sourceScheduleRunId)throw new Error('Only a user request to the primary bot can create a schedule.');return schedules.create({...input,conversationId:root.id,sourceMessageId:source?.id});},
  update:input=>{if(c.parentThreadId||source?.sourceScheduleRunId)throw new Error('Schedules can only be changed by a user request to the primary bot.');return schedules.update({...input,conversationId:root.id});},
  remove:input=>{if(c.parentThreadId||source?.sourceScheduleRunId)throw new Error('Schedules can only be removed by a user request to the primary bot.');return schedules.remove({...input,conversationId:root.id});},
 };
 return{
  schedules:schedule,
  objectives:!tools?undefined:{list:()=>objectives.forBot(botId),report:input=>objectives.report({...input,author:botId}),flagRisk:input=>objectives.flagRisk({...input,botId}),propose:input=>objectives.propose({...input,ownerBotId:botId})},
  proactivity:messaging?undefined:{propose:input=>proactivity.propose({...input,botId,conversationId:root.id})},
  knowledge:messaging?undefined:{search:input=>knowledge.search({...input,botId}),get:input=>knowledge.get({...input,botId}),propose:input=>knowledge.propose({...input,botId})},
  team:messaging||!teamBoard?undefined:{chief:teamBoard.isChief(botId),list:input=>teamBoard.list(botId,input),update:input=>teamBoard.update(botId,input),attach:input=>teamBoard.attach(botId,input),create:input=>teamBoard.create(botId,input),directory:input=>teamBoard.directoryFor(botId,input?.teammateId),verify:input=>teamBoard.verify(botId,input.id),read:input=>teamBoard.read(botId,input)},
 };
}
