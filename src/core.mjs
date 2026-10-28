// Original adapter, no candidate implementation imported.
import {openSync,writeSync,fsyncSync,closeSync,readFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inboundAllowed} from './policy.mjs';
import {validGrant} from './authority.mjs';
export function opaque(v){if(typeof v!=='string'||!v||v.trim()!==v||/[\x00-\x1f]/.test(v))throw Error('invalid ID');return v;}
export class Journal{
 constructor(dir){mkdirSync(dir,{recursive:true,mode:0o700});this.rows=[];this.path=dir+'/custody.jsonl';try{const s=readFileSync(this.path,'utf8');if(s&&!s.endsWith('\n'))throw Error('torn journal');this.rows=s.trim()?s.trim().split('\n').map(JSON.parse):[];}catch(e){if(e.code!=='ENOENT')throw e;}this.fd=openSync(this.path,'a',0o600);const d=openSync(dir,'r');fsyncSync(d);closeSync(d);}
 append(r){writeSync(this.fd,JSON.stringify(r)+'\n');fsyncSync(this.fd);this.rows.push(r);}
 close(){closeSync(this.fd);}
}
export class Adapter{
 constructor(c,j){['accountId','daemonAccountId','selfId'].forEach(k=>opaque(c[k]));if(!Array.isArray(c.allowFrom))throw Error('allowlist required');c.allowFrom.forEach(opaque);this.c=structuredClone(c);this.j=j;this.busy=false;}
 scope(){return JSON.stringify([this.c.accountId,this.c.daemonAccountId]);}
 cursor(){return this.j.rows.filter(r=>r.scope===this.scope()&&r.type==='cursor').at(-1)?.cursor;}
 // Completed burst markers make a crash between per-source custody rows replay-safe.
 sourceKey(e){return JSON.stringify([this.scope(),e.peerId,e.messageId]);}
 hasCustody(e){const key=this.sourceKey(e);return this.j.rows.some(r=>r.scope===this.scope()&&(r.type==='custody'&&r.key===key||r.type==='burst-custody'&&r.keys.includes(key)));}
 uncertainSource(e){const key=this.sourceKey(e);return this.j.rows.some(r=>r.scope===this.scope()&&(r.type==='intent'&&r.key===key||r.type==='burst-intent'&&r.keys.includes(key)));}
 async receiveBatch(events,takeCustody){
  if(events.length===1)return this.receive(events[0],takeCustody);
  if(!events.length)throw Error('empty burst');if(this.busy)throw Error('serialized consumer required');this.busy=true;
  try{const first=events[0];for(const e of events){[e.accountId,e.peerId,e.senderId,e.messageId,e.cursor].forEach(opaque);if(e.accountId!==this.c.daemonAccountId||e.peerId!==first.peerId||e.senderId!==first.senderId)throw Error('burst scope mismatch');}
   const fresh=events.filter(e=>!this.hasCustody(e)),keys=fresh.map(e=>this.sourceKey(e));
   if(new Set(events.map(e=>this.sourceKey(e))).size!==events.length)throw Error('duplicate burst source');
   if(fresh.some(e=>!inboundAllowed(this.c,e)||typeof e.text!=='string'||!e.text.length))throw Error('burst admission denied');
   if(fresh.some(e=>this.uncertainSource(e)))throw Error('uncertain host custody; reconcile');
   if(fresh.length){this.j.append({type:'burst-intent',scope:this.scope(),keys});await takeCustody(fresh);this.j.append({type:'burst-custody',scope:this.scope(),keys});}
   for(const e of events){const key=this.sourceKey(e);if(!this.j.rows.some(r=>r.type==='custody'&&r.scope===this.scope()&&r.key===key))this.j.append({type:'custody',scope:this.scope(),key});}
   const cursor=events.at(-1).cursor;this.j.append({type:'cursor',scope:this.scope(),cursor});return cursor;
  }finally{this.busy=false;}
 }
 async receive(e,takeCustody){if(this.busy)throw Error('serialized consumer required');this.busy=true;try{const {accountId,peerId,senderId,messageId,cursor,text,kind,outgoing}=e;[accountId,peerId,senderId,messageId,cursor].forEach(opaque);if(accountId!==this.c.daemonAccountId)throw Error('account mismatch');const key=JSON.stringify([this.scope(),peerId,messageId]);if(!this.hasCustody(e)){if(typeof text==='string'&&text.length&&inboundAllowed(this.c,e)){if(this.uncertainSource(e))throw Error('uncertain host custody; reconcile');this.j.append({type:'intent',scope:this.scope(),key});await takeCustody(e);}this.j.append({type:'custody',scope:this.scope(),key});}if(!this.j.rows.some(r=>r.type==='custody'&&r.scope===this.scope()&&r.key===key))this.j.append({type:'custody',scope:this.scope(),key});this.j.append({type:'cursor',scope:this.scope(),cursor});return cursor;}finally{this.busy=false;}}
 async send({peerId,text,logicalId,authorization},t){opaque(peerId);opaque(logicalId);if((!this.c.allowFrom.includes(peerId)&&!validGrant(this.c,{peerId,text,logicalId},authorization))||peerId===this.c.selfId||typeof text!=='string'||!text.length)throw Error('send denied');const key=createHash('sha256').update(JSON.stringify([this.scope(),peerId,logicalId])).digest('hex');const digest=createHash('sha256').update(text).digest('hex');const prior=this.j.rows.find(r=>r.type==='send-intent'&&r.key===key);if(prior){if(prior.digest!==digest)throw Error('payload conflict');return {state:'reconciliation-required',key};}this.j.append({type:'send-intent',scope:this.scope(),key,digest});try{const receipt=await t.postSend(this.c.daemonAccountId,{threadId:peerId,text},key);this.j.append({type:'send-observation',scope:this.scope(),key,receipt});return receipt;}catch{return {state:'reconciliation-required',key};}}
 async reconcileSend({peerId,text,logicalId},t){opaque(peerId);opaque(logicalId);if(peerId===this.c.selfId||typeof text!=='string'||!text.length)throw Error('send denied');const key=createHash('sha256').update(JSON.stringify([this.scope(),peerId,logicalId])).digest('hex');const digest=createHash('sha256').update(text).digest('hex');const prior=this.j.rows.find(r=>r.type==='send-intent'&&r.scope===this.scope()&&r.key===key);if(!prior||prior.digest!==digest)throw Error('reconciliation intent mismatch');return this.reconcile(key,t);}
 async reconcile(key,t){if(!this.j.rows.some(r=>r.type==='send-intent'&&r.scope===this.scope()&&r.key===key))throw Error('unknown key');const receipt=await t.findSend(this.c.daemonAccountId,key);this.j.append({type:'send-observation',scope:this.scope(),key,receipt});return receipt;}
}
export function loopbackClient(base,token,fetcher){const u=new URL(base);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('literal loopback required');if(typeof token!=='string'||!token||/[\r\n]/.test(token))throw Error('bearer required');async function req(a,p,init={}){opaque(a);const r=await fetcher(new URL('/v1/accounts/'+encodeURIComponent(a)+p,u),{...init,redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...init.headers}});if(!r.ok)throw Error('request failed');return r.json();}return {postSend:(a,b,k)=>req(a,'/sends',{method:'POST',headers:{'Idempotency-Key':k},body:JSON.stringify(b)}),findSend:(a,k)=>req(a,'/sends/by-idempotency-key?key='+encodeURIComponent(k))};}
