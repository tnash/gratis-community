import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';

// gmail.modify can read, label and trash mail. It cannot send mail or delete permanently.
const SCOPE='https://www.googleapis.com/auth/gmail.modify';
const API='https://gmail.googleapis.com/gmail/v1/users/me';
const SYSTEM_LABELS=new Set(['INBOX','UNREAD','STARRED','IMPORTANT']);
const BLOCKED_LABELS=new Set(['TRASH','SPAM','SENT','DRAFT']);
const b64=buffer=>buffer.toString('base64url');
const header=(message,name)=>message.payload?.headers?.find(h=>h.name.toLowerCase()===name)?.value||'';
const summary=message=>({id:message.id,threadId:message.threadId,from:header(message,'from'),subject:header(message,'subject'),date:header(message,'date'),labels:message.labelIds||[],snippet:message.snippet});
const find=(part,type)=>{if(!part)return;if(part.mimeType===type&&part.body?.data)return Buffer.from(part.body.data,'base64url').toString('utf8');for(const child of part.parts||[]){const found=find(child,type);if(found)return found;}};
const bodyText=payload=>find(payload,'text/plain')??(find(payload,'text/html')||'').replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
// Gmail allows about 250 quota units per second and a metadata read costs 5, so read in small batches.
const inBatches=async(items,work)=>{const results=[];for(let i=0;i<items.length;i+=10)results.push(...await Promise.all(items.slice(i,i+10).map(work)));return results;};

// The user's own Google OAuth "Desktop app" client; credentials never enter workspace snapshots or the renderer.
export class Gmail {
  constructor({directory,encrypt,decrypt,openExternal,request=fetch}){Object.assign(this,{directory,encrypt,decrypt,openExternal,request});this.value={};this.access=null;this.pending=null;}
  get file(){return join(this.directory,'gmail.secure');}
  async init(){await mkdir(this.directory,{recursive:true,mode:0o700});try{this.value=JSON.parse(await this.decrypt(await readFile(this.file)));}catch(error){if(error.code!=='ENOENT')throw new Error('Could not unlock saved Gmail connection.');}return this;}
  async save(){const temporary=this.file+'.tmp';await writeFile(temporary,await this.encrypt(JSON.stringify(this.value)),{mode:0o600});await rename(temporary,this.file);}
  status(){return {configured:!!this.value.clientId,connected:!!this.value.refreshToken,email:this.value.email||'',clientId:this.value.clientId||''};}

  async connect({clientId,clientSecret}={}){
    clientId=String(clientId||this.value.clientId||'').trim();clientSecret=String(clientSecret||this.value.clientSecret||'').trim();
    if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)||clientSecret.length<8||clientSecret.length>200)throw new Error('Enter the Client ID and Client secret of your Google “Desktop app” OAuth client.');
    this.pending?.(new Error('Replaced by a newer Google sign-in.'));
    const verifier=b64(randomBytes(32)),state=b64(randomBytes(16));let redirectUri;
    const code=await new Promise((resolve,reject)=>{
      let server;const cancel=error=>finish(error);
      const finish=(error,value)=>{clearTimeout(timer);if(this.pending===cancel)this.pending=null;server.close();server.closeAllConnections();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(new Error('Google sign-in timed out. Try again.')),600000);
      this.pending=cancel;
      server=createServer((req,res)=>{
        const url=new URL(req.url,'http://127.0.0.1');if(url.pathname!=='/callback'){res.writeHead(404).end();return;}
        const ok=url.searchParams.get('state')===state&&!!url.searchParams.get('code');
        res.writeHead(ok?200:400,{'Content-Type':'text/plain; charset=utf-8'}).end(ok?'Gmail connected. You can close this tab and return to Gratis.':'Google sign-in failed. Return to Gratis and try again.');
        finish(ok?null:new Error(url.searchParams.get('error')||'Google sign-in failed.'),url.searchParams.get('code'));
      });
      server.once('error',finish);
      server.listen(0,'127.0.0.1',()=>{
        redirectUri=`http://127.0.0.1:${server.address().port}/callback`;
        const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for(const [k,v] of Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:b64(createHash('sha256').update(verifier).digest()),code_challenge_method:'S256'}))url.searchParams.set(k,v);
        Promise.resolve(this.openExternal(url.href)).catch(error=>finish(error));
      });
    });
    const tokens=await this._oauth({client_id:clientId,client_secret:clientSecret,code,code_verifier:verifier,redirect_uri:redirectUri,grant_type:'authorization_code'});
    if(!tokens.refresh_token)throw new Error('Google did not return a refresh token. Remove Gratis in your Google account’s third-party access settings, then connect again.');
    const previous=this.value,previousAccess=this.access;
    this.value={clientId,clientSecret,refreshToken:tokens.refresh_token};this.access={token:tokens.access_token,expires:Date.now()+tokens.expires_in*1000-60000};
    try{this.value.email=(await this._api('/profile')).emailAddress||'';await this.save();}catch(error){this.value=previous;this.access=previousAccess;throw error;}
    return this.status();
  }
  async disconnect(){
    const token=this.value.refreshToken;this.value={clientId:this.value.clientId,clientSecret:this.value.clientSecret};this.access=null;await this.save();
    if(token)await this.request('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),redirect:'error',signal:AbortSignal.timeout(15000)}).catch(()=>{});
    return this.status();
  }

  async _oauth(form){
    const response=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),redirect:'error',signal:AbortSignal.timeout(30000)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`Google sign-in failed: ${body.error_description||body.error||response.status}`);
    return body;
  }
  async _accessToken(force=false){
    if(!this.value.refreshToken)throw new Error('Connect Gmail in Settings → Connections first.');
    if(!force&&this.access&&this.access.expires>Date.now())return this.access.token;
    try{const tokens=await this._oauth({client_id:this.value.clientId,client_secret:this.value.clientSecret,refresh_token:this.value.refreshToken,grant_type:'refresh_token'});this.access={token:tokens.access_token,expires:Date.now()+tokens.expires_in*1000-60000};}
    catch(error){throw new Error(error.message+' Reconnect Gmail in Settings → Connections.');}
    return this.access.token;
  }
  async _api(path,{method='GET',query,body,retried=false}={}){
    const url=new URL(API+path);for(const [k,v] of Object.entries(query||{}))for(const x of [].concat(v))url.searchParams.append(k,x);
    const response=await this.request(url,{method,headers:{Authorization:'Bearer '+await this._accessToken(retried),...(body?{'Content-Type':'application/json'}:{})},body:body&&JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(response.status===401&&!retried)return this._api(path,{method,query,body,retried:true});
    if(response.status===204)return {};
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`Gmail returned ${response.status}: ${data.error?.message||'request failed'}`);
    return data;
  }

  async search({query='',max=20}={}){
    const list=await this._api('/messages',{query:{q:query,maxResults:Math.min(Math.max(Math.trunc(max)||20,1),50)}});
    const messages=await inBatches(list.messages||[],m=>this._api('/messages/'+m.id,{query:{format:'metadata',metadataHeaders:['From','Subject','Date']}}).then(summary));
    return {messages,more:!!list.nextPageToken};
  }
  async read({id}){
    const message=await this._api('/messages/'+id,{query:{format:'full'}});
    return {...summary(message),body:bodyText(message.payload).slice(0,20000),untrusted:true};
  }
  async labels(){return ((await this._api('/labels')).labels||[]).map(l=>({name:l.name,type:l.type}));}
  async _labelId(name,create){
    const wanted=String(name).trim(),upper=wanted.toUpperCase();
    if(BLOCKED_LABELS.has(upper))throw new Error(`The ${upper} label cannot be changed here. Use gmail_trash to move mail to Trash.`);
    if(SYSTEM_LABELS.has(upper))return upper;
    const hit=((await this._api('/labels')).labels||[]).find(l=>l.name.toLowerCase()===wanted.toLowerCase());
    if(hit)return hit.id;
    if(!create)throw new Error(`There is no label named “${wanted}”.`);
    return (await this._api('/labels',{method:'POST',body:{name:wanted,labelListVisibility:'labelShow',messageListVisibility:'show'}})).id;
  }
  async label({ids,add=[],remove=[]}){
    const addLabelIds=[],removeLabelIds=[];
    for(const name of add)addLabelIds.push(await this._labelId(name,true));
    for(const name of remove)removeLabelIds.push(await this._labelId(name,false));
    await this._api('/messages/batchModify',{method:'POST',body:{ids,addLabelIds,removeLabelIds}});
    return {changed:ids.length};
  }
  // Trash is recoverable in Gmail for 30 days; this class never deletes permanently.
  async trash({ids}){await inBatches(ids,id=>this._api(`/messages/${id}/trash`,{method:'POST'}));return {trashed:ids.length};}
}
