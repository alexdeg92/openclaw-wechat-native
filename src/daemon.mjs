import {multipartBody} from './outbound-media.mjs';
import {opaque} from './core.mjs';
import {inboundAllowed,isRoom,exactId} from './policy.mjs';
// NativeEvent / NativeMessage generated contracts; sync_projection.rs defines event data.
// "catchup" = messages the daemon synced after a reconnect/restart. Recent ones are answered like live messages, so
// nothing sent during a restart or reboot is lost; older history is never answered. 15 min covers a reboot.
export const CATCHUP_MS=15*60_000;
/** Live, or catch-up whose own timestamp is recent (and not in the future beyond clock skew). */
export function admitOrigin(d,message,now=Date.now()){
 if(d.origin==='live')return true;if(d.origin!=='catchup')return false;
 const t=Date.parse(message?.createdAt);return Number.isFinite(t)&&t>=now-CATCHUP_MS&&t<=now+60_000;
}
/** @param {any} [policy] */
export function decode(event,message,account,policy=undefined,now=Date.now()){
 opaque(event.cursor); if(event.kind!=='message.committed')return null;
 const d=event.data;if(!d||(d.origin!=='live'&&d.origin!=='catchup'))return null;
 opaque(d.messageId);opaque(d.threadId);
 if(message.id!==d.messageId||message.accountId!==account||message.threadId!==d.threadId)throw Error('daemon scope mismatch');
 if(!admitOrigin(d,message,now))return null;
 if(d.direction!=='incoming'||message.direction!=='incoming'||message.type!==1||message.recall||!Array.isArray(message.media)||message.media.length)return null;
 const group=isRoom(message.threadId);
 if(group&&(!policy||!exactId(message.senderId)||message.mentions?.state!=='known'||message.mentions.self!==true))return null;
 opaque(message.senderId);if(!group&&message.senderId!==message.threadId)throw Error('direct sender mismatch');
 if(typeof message.body!=='string'||!message.body)return null;
 const decoded={accountId:account,peerId:message.threadId,senderId:message.senderId,messageId:message.id,cursor:event.cursor,text:message.body,kind:group?'group-text':'direct-text',outgoing:false,...(group?{mentions:message.mentions}:{})};
 return policy&&!inboundAllowed(policy,decoded)?null:decoded;
}
export async function* sse(body){let buffer='',data=[],id='',event='';const decoder=new TextDecoder();for await(const bytes of body){buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>1048576)throw Error('SSE frame too large');let n;while((n=buffer.indexOf('\n'))>=0){let line=buffer.slice(0,n).replace(/\r$/,'');buffer=buffer.slice(n+1);if(!line){if(data.length){const value=JSON.parse(data.join('\n'));if(id&&value.cursor!==id)throw Error('SSE cursor mismatch');if(event&&event!==value.kind&&event!=='message')throw Error('SSE event mismatch');yield value;}data=[];id='';event='';}else if(!line.startsWith(':')){const k=line.indexOf(':');const key=k<0?line:line.slice(0,k);const value=k<0?'':line.slice(k+1).replace(/^ /,'');if(key==='data')data.push(value);if(key==='id')id=value;if(key==='event')event=value;}}}if(buffer||data.length)throw Error('truncated SSE');}
export function daemonClient(base,token,fetcher,signal){const u=new URL(base);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('literal loopback required');if(typeof token!=='string'||!token||/[\r\n]/.test(token))throw Error('bearer required');
 async function request(account,path,init={}){opaque(account);const r=await fetcher(new URL('/v1/accounts/'+encodeURIComponent(account)+path,u),{...init,signal,redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...init.headers}});if(!r.ok){const error=Object.assign(Error('daemon request failed'),{status:r.status});throw error;}return r;}
 return {contact:async(a,id)=>(await request(a,'/contacts/'+encodeURIComponent(opaque(id)))).json(),group:async(a,id)=>(await request(a,'/groups/'+encodeURIComponent(opaque(id)))).json(),directoryPage:async(a,kind,room,cursor)=>{if(!['contacts','groups','members'].includes(kind))throw Error('invalid directory kind');const path=kind==='members'?'/groups/'+encodeURIComponent(opaque(room))+'/members':'/'+kind;return (await request(a,path+'?limit=200'+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json();},postSend:async(a,b,k)=>(await request(a,'/sends',{method:'POST',headers:{'Idempotency-Key':k},body:JSON.stringify(b)})).json(),findSend:async(a,k)=>(await request(a,'/sends/by-idempotency-key?key='+encodeURIComponent(k))).json(),message:async(a,id)=>(await request(a,'/messages/'+encodeURIComponent(opaque(id)))).json(),mediaAssets:async(a,id)=>(await request(a,'/messages/'+encodeURIComponent(opaque(id))+'/media')).json(),mediaAsset:async(a,id)=>(await request(a,'/media/'+encodeURIComponent(opaque(id)))).json(),startMediaTransfer:async(a,id,b)=>(await request(a,'/messages/'+encodeURIComponent(opaque(id))+'/media-transfers',{method:'POST',body:JSON.stringify(b)})).json(),job:async(a,id)=>(await request(a,'/jobs/'+encodeURIComponent(opaque(id)))).json(),retryJob:async(a,id)=>(await request(a,'/jobs/'+encodeURIComponent(opaque(id))+'/retry',{method:'POST',body:'{}'})).json(),mediaContent:async(a,id)=>request(a,'/media/'+encodeURIComponent(opaque(id))+'/content'),
 upload:async(a,{bytes,fileName,contentType})=>{const {boundary,body}=multipartBody({bytes,fileName,contentType});return (await request(a,'/uploads',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary},body})).json();},
 ack:async(a,c)=>{await request(a,'/consumers/openclaw-native-isolated/ack',{method:'POST',body:JSON.stringify({cursor:c})});},events:async function*(a,after){const r=await request(a,'/events/stream'+(after?'?after='+encodeURIComponent(after):''));yield* sse(r.body);}};
}
