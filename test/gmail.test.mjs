import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gmail} from '../src/gmail.mjs';
import {agentRuntime} from '../src/agent-tools.mjs';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
const encrypt=async text=>Buffer.from(text).map(b=>b^42),decrypt=async buffer=>Buffer.from(buffer).map(b=>b^42).toString();
const CLIENT={clientId:'fixture-123.apps.googleusercontent.com',clientSecret:'fixture-secret-value'};
const json=(body,status=200)=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

// request stub records every call; routes maps "METHOD /path" to a response or function.
async function fixture(t,routes={},{openExternal=async()=>{}}={}){
  const directory=await mkdtemp(join(tmpdir(),'gratis-gmail-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[];
  const request=async(url,options={})=>{url=new URL(url);const key=`${options.method||'GET'} ${url.hostname}${url.pathname.replace('/gmail/v1/users/me','')}`;calls.push({key,url,options});
    if(key==='POST oauth2.googleapis.com/token')return routes.token?routes.token(options):json({access_token:'access-1',refresh_token:'refresh-1',expires_in:3600});
    if(key==='POST oauth2.googleapis.com/revoke')return json({});
    const route=routes[key];if(!route)throw new Error('Unexpected request '+key);return typeof route==='function'?route(url,options):route;};
  const gmail=await new Gmail({directory,encrypt,decrypt,openExternal,request}).init();
  return {gmail,calls,directory};
}
// Connected fixture: skips OAuth by writing a refresh token into saved state.
async function connected(t,routes){const f=await fixture(t,routes);f.gmail.value={...CLIENT,refreshToken:'refresh-1',email:'me@example.com'};await f.gmail.save();return f;}

test('connect runs a PKCE loopback sign-in with the narrow scope and stores the token encrypted',async t=>{
  let authUrl;
  const {gmail,calls,directory}=await fixture(t,{'GET gmail.googleapis.com/profile':json({emailAddress:'me@example.com'})},{openExternal:async href=>{
    authUrl=new URL(href);const redirect=new URL(authUrl.searchParams.get('redirect_uri'));redirect.searchParams.set('code','auth-code');redirect.searchParams.set('state',authUrl.searchParams.get('state'));
    setImmediate(()=>fetch(redirect).catch(()=>{}));}});
  const status=await gmail.connect(CLIENT);
  assert.equal(authUrl.hostname,'accounts.google.com');assert.equal(authUrl.searchParams.get('scope'),'https://www.googleapis.com/auth/gmail.modify');
  assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');assert.match(authUrl.searchParams.get('redirect_uri'),/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const exchange=calls.find(c=>c.key==='POST oauth2.googleapis.com/token').options.body;
  assert.equal(exchange.get('code'),'auth-code');assert.ok(exchange.get('code_verifier').length>=43);
  assert.deepEqual(status,{configured:true,connected:true,email:'me@example.com',clientId:CLIENT.clientId});
  const saved=(await readFile(join(directory,'gmail.secure'))).toString();assert.equal(saved.includes('refresh-1'),false);assert.equal(saved.includes(CLIENT.clientSecret),false);
  assert.equal(JSON.stringify(gmail.status()).includes('secret'),false);
});

test('a sign-in callback with the wrong state is rejected and nothing is saved',async t=>{
  const {gmail}=await fixture(t,{},{openExternal:async href=>{const u=new URL(href),redirect=new URL(u.searchParams.get('redirect_uri'));redirect.searchParams.set('code','stolen');redirect.searchParams.set('state','wrong');setImmediate(()=>fetch(redirect).catch(()=>{}));}});
  await assert.rejects(gmail.connect(CLIENT),/sign-in failed/i);assert.equal(gmail.status().connected,false);
});

test('connect rejects a malformed client before opening a browser',async t=>{
  let opened=false;const {gmail}=await fixture(t,{},{openExternal:async()=>{opened=true;}});
  await assert.rejects(gmail.connect({clientId:'not-a-google-client',clientSecret:'x'.repeat(20)}),/Desktop app/);assert.equal(opened,false);
});

test('search builds the query, reads metadata and reports more results',async t=>{
  const {gmail,calls}=await connected(t,{
    'GET gmail.googleapis.com/messages':json({messages:[{id:'aaaa1111'}],nextPageToken:'next'}),
    'GET gmail.googleapis.com/messages/aaaa1111':json({id:'aaaa1111',threadId:'t1',labelIds:['INBOX','UNREAD'],snippet:'hello',payload:{headers:[{name:'From',value:'a@example.com'},{name:'Subject',value:'Hi'},{name:'Date',value:'Mon'}]}})});
  const result=await gmail.search({query:'is:unread',max:999});
  assert.deepEqual(result,{messages:[{id:'aaaa1111',threadId:'t1',from:'a@example.com',subject:'Hi',date:'Mon',labels:['INBOX','UNREAD'],snippet:'hello'}],more:true});
  const list=calls.find(c=>c.key==='GET gmail.googleapis.com/messages');assert.equal(list.url.searchParams.get('q'),'is:unread');assert.equal(list.url.searchParams.get('maxResults'),'50');
});

test('read returns plain text, falls back to stripped HTML, and flags the body untrusted',async t=>{
  const enc=s=>Buffer.from(s).toString('base64url');
  const {gmail}=await connected(t,{
    'GET gmail.googleapis.com/messages/plain0001':json({id:'plain0001',payload:{mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:enc('<b>html</b>')}},{mimeType:'text/plain',body:{data:enc('plain body')}}]}}),
    'GET gmail.googleapis.com/messages/html00001':json({id:'html00001',payload:{mimeType:'text/html',body:{data:enc('<style>x{}</style><p>Hello <b>there</b></p><script>bad()</script>')}}})});
  const plain=await gmail.read({id:'plain0001'});assert.equal(plain.body,'plain body');assert.equal(plain.untrusted,true);
  assert.equal((await gmail.read({id:'html00001'})).body,'Hello there');
});

test('label creates a missing label, archives with INBOX removal, and refuses Trash, Spam, Sent and Drafts',async t=>{
  let created;
  const {gmail,calls}=await connected(t,{
    'GET gmail.googleapis.com/labels':json({labels:[{id:'L1',name:'Other'}]}),
    'POST gmail.googleapis.com/labels':(url,options)=>{created=JSON.parse(options.body);return json({id:'L2',name:created.name});},
    'POST gmail.googleapis.com/messages/batchModify':json({},204)});
  assert.deepEqual(await gmail.label({ids:['aaaa1111','bbbb2222'],add:['Archive'],remove:['inbox']}),{changed:2});
  assert.equal(created.name,'Archive');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{ids:['aaaa1111','bbbb2222'],addLabelIds:['L2'],removeLabelIds:['INBOX']});
  for(const name of ['TRASH','spam','Sent','draft'])await assert.rejects(gmail.label({ids:['aaaa1111'],add:[name]}),/cannot be changed/);
  await assert.rejects(gmail.label({ids:['aaaa1111'],remove:['Nope']}),/no label named/i);
});

test('trash moves each message to Trash and never calls a delete endpoint',async t=>{
  const {gmail,calls}=await connected(t,{
    'POST gmail.googleapis.com/messages/aaaa1111/trash':json({id:'aaaa1111'}),
    'POST gmail.googleapis.com/messages/bbbb2222/trash':json({id:'bbbb2222'})});
  assert.deepEqual(await gmail.trash({ids:['aaaa1111','bbbb2222']}),{trashed:2});
  assert.equal(calls.some(c=>(c.options.method||'GET')==='DELETE'),false);
});

test('an expired access token is refreshed once and the request retried',async t=>{
  let tries=0;
  const {gmail,calls}=await connected(t,{'GET gmail.googleapis.com/labels':()=>++tries===1?json({error:{message:'expired'}},401):json({labels:[{id:'L1',name:'Work',type:'user'}]})});
  assert.deepEqual(await gmail.labels(),[{name:'Work',type:'user'}]);
  assert.equal(calls.filter(c=>c.key==='POST oauth2.googleapis.com/token').length,2);
});

test('a revoked refresh token asks the user to reconnect',async t=>{
  const {gmail}=await connected(t,{token:()=>json({error:'invalid_grant',error_description:'Token has been expired or revoked.'},400)});
  await assert.rejects(gmail.labels(),/Reconnect Gmail/);
});

test('API errors surface Gmail’s message and tools need a connection',async t=>{
  const {gmail}=await connected(t,{'GET gmail.googleapis.com/labels':json({error:{message:'Rate Limit Exceeded'}},429)});
  await assert.rejects(gmail.labels(),/429.*Rate Limit/);
  const {gmail:fresh}=await fixture(t);await assert.rejects(fresh.labels(),/Connect Gmail/);
});

test('disconnect revokes the token, keeps the client, and survives a restart',async t=>{
  const {gmail,calls,directory}=await connected(t);
  const status=await gmail.disconnect();assert.deepEqual(status,{configured:true,connected:false,email:'',clientId:CLIENT.clientId});
  assert.equal(calls.some(c=>c.key==='POST oauth2.googleapis.com/revoke'),true);
  const reopened=await new Gmail({directory,encrypt,decrypt,request:async()=>json({})}).init();assert.equal(reopened.status().connected,false);assert.equal(reopened.status().configured,true);
});

async function runtimeFor(t,{connections=true,connectedStatus=true,approve=async()=>true}={}){
  const dir=await mkdtemp(join(tmpdir(),'gratis-gmail-rt-'));t.after(()=>rm(dir,{recursive:true,force:true}));const calls=[];
  const gmail={status:()=>({connected:connectedStatus}),trash:async input=>{calls.push(input);return {trashed:input.ids.length};},search:async()=>({messages:[],more:false})};
  const runtime=await agentRuntime({bot:{id:'1cd03073-d571-46dd-b997-fcfb9d4b58b0',name:'T',instructions:'x',capabilities:{web:false,computer:false,files:false,connections}},conversationId:'1cd03073-d571-46dd-b997-fcfb9d4b58b0',files:new WorkspaceFiles(dir),connections:{status:()=>({})},gmail,onActivity:()=>{},approve,signal:new AbortController().signal});
  return {runtime,calls,tool:name=>runtime.definitions.find(d=>d.name===name)};
}
test('Gmail tools exist only when Gmail is connected and the bot has Connections on, and never include send or delete',async t=>{
  const on=await runtimeFor(t);assert.deepEqual(on.runtime.definitions.map(d=>d.name).filter(n=>n.startsWith('gmail_')).sort(),['gmail_label','gmail_labels','gmail_read','gmail_search','gmail_trash']);
  assert.equal((await runtimeFor(t,{connections:false})).runtime.definitions.some(d=>d.name.startsWith('gmail_')),false);
  assert.equal((await runtimeFor(t,{connectedStatus:false})).runtime.definitions.some(d=>d.name.startsWith('gmail_')),false);
});
test('gmail_trash needs approval, and message IDs are validated',async t=>{
  const declined=await runtimeFor(t,{approve:async()=>false});
  assert.match((await declined.tool('gmail_trash').handler({ids:['aaaa1111']})).content[0].text,/declined/);assert.equal(declined.calls.length,0);
  const approved=await runtimeFor(t);await approved.tool('gmail_trash').handler({ids:['aaaa1111']});assert.deepEqual(approved.calls,[{ids:['aaaa1111']}]);
  assert.equal(approved.tool('gmail_trash').schema.safeParse({ids:['../../etc']}).success,false);assert.equal(approved.tool('gmail_trash').schema.safeParse({ids:[]}).success,false);
});
