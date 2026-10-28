// Offline end-to-end harness over the installed OpenClaw host. Fake daemon via injected fetch; no network, no WeChat.
// Path: fake SSE inbound -> plugin startAccount -> real runtime.channel.inbound.dispatch -> durable final -> plugin sendText.
// Media (p3): the fake daemon serves scripted assets/jobs/content per message; every model-turn ctx is kept in `turns`.
// The reply resolver stands in for the model: it applies the host's own reply-threading policy and tags the final with
// pendingFinalDeliveryCompletion + session pendingFinalDelivery exactly as agent-runner does.
import {mkdtempSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';
const D=(process.env.OPENCLAW_DIST??new URL('../node_modules/openclaw/dist/',import.meta.url).pathname)+'';
export const CHANNEL='wechat-native-isolated';
export async function startHarness({root=process.env.PLUGIN_ROOT??new URL('..',import.meta.url).pathname.replace(/\/$/,''),account:accountOptions={},config:configOptions={},contacts=[],groups=[],members=[],onReply,replyText,replyExtra}={}){
 const state=mkdtempSync(tmpdir()+'/wechat-e2e-');process.env.OPENCLAW_STATE_DIR=state;process.env.OPENCLAW_CONFIG_PATH=state+'/absent.json';process.env.OPENCLAW_BUNDLED_PLUGINS_DIR=state+'/none';
 globalThis.fetch=async()=>{throw Error('real network forbidden in tests')};
 const {t:acquire}=await import(D+'loader-runtime-load-DCwhg2IV.mjs');const {u:scope}=await import(D+'gateway-request-scope-Da9jAC9_.mjs');
 const {w:setActive}=await import(D+'runtime-BnZb2P5v.mjs');const {T:setMeta}=await import(D+'reply-payload-CZCVcyy_.mjs');
 const {t:createRuntime}=await import(D+'runtime-CmyuncsG.mjs');const {c:updateSessionEntry}=await import(D+'session-accessor.reset-xoze7eVv.mjs');
 const {c:loadEntry}=await import(D+'session-accessor.sqlite-entry-C87Sde4p.mjs');
 const {o:resolveReplyToMode,i:implicitAllowed,n:replyToModeFilter}=await import(D+'reply-threading-ChpQAasn.mjs');
 const built=(await import(root+'/build/plugin.js')).default;
 const cfg={...configOptions,plugins:{enabled:true,allow:[CHANNEL],load:{paths:[root]},entries:{[CHANNEL]:{enabled:true}}},channels:{[CHANNEL]:{accounts:{local:{enabled:true,mediaCaptionWindowMs:0,textMediaWindowMs:0,startAfter:'0',daemonAccountId:'daemon',selfId:'Self',allowFrom:['PeerX'],verifiedPeer:'PeerX',baseUrl:'http://127.0.0.1:6174/',token:'synthetic',journalDir:state+'/journal',...accountOptions}}}}};
 const {buildJsonChannelConfigSchema}=await import('openclaw/plugin-sdk/channel-config-schema');
 const validated=buildJsonChannelConfigSchema(built.makePlugin({}).configSchema.schema).runtime.safeParse(cfg.channels[CHANNEL]);
 if(!validated.success)throw Error('Invalid synthetic channel config');cfg.channels[CHANNEL]=validated.data;
 const lease=await acquire({config:cfg,workspaceDir:state,env:{...process.env},onlyPluginIds:[CHANNEL],allowProcessHomeSessionCatalogs:false,logger:{info(){},warn(){},error(){},debug(){}}});
 // Fake daemon: replayable SSE log (resumes after ?after=), sends report queued then accepted on GET-only lookup.
 const enc=new TextEncoder(),log=[];let wakers=[];const wakeAll=()=>{const w=wakers;wakers=[];w.forEach(f=>f());};
 const stream=(after,signal)=>(async function*(){let i=after;for(;;){if(signal?.aborted)return;while(i<log.length)yield enc.encode(log[i++]);await new Promise(r=>{wakers.push(r);signal?.addEventListener?.('abort',r,{once:true});});}})();
 const calls=[],posts=[],sendBodies=[],receipts=new Map(),errors=[],uploads=[],mediaSends=[],ackCursors=[],messages=new Map(),media=new Map(),assets=new Map(),jobs=new Map(),content=new Map();
 const json=v=>({ok:true,status:200,json:async()=>structuredClone(v)});
 const fetcher=async(url,init)=>{const p=url.pathname.replace('/v1/accounts/daemon','');calls.push((init?.method??'GET')+' '+p);
  if(p==='/events/stream')return {ok:true,body:stream(Number((url.searchParams.get('after')??'0').replace(/^c/,''))||0,init?.signal)};
  let m=p.match(/^\/messages\/(M\d+)$/);if(m)return json(messages.get(m[1])??{id:m[1],accountId:'daemon',threadId:'PeerX',senderId:'PeerX',direction:'incoming',type:1,media:[],body:'ping '+m[1]});
  if((m=p.match(/^\/messages\/(M\d+)\/media$/)))return json({items:(media.get(m[1])??[]).map(id=>assets.get(id))});
  if((m=p.match(/^\/messages\/(M\d+)\/media-transfers$/))&&init?.method==='POST'){const b=JSON.parse(init.body);const a=assets.get(b.assetId);const j=a.script.shift();jobs.set(j.id,j);a.jobId=j.id;return json(j.states[0]);}
  if((m=p.match(/^\/jobs\/(\w+)\/retry$/))&&init?.method==='POST'){const j=jobs.get(m[1]);j.states=j.retryStates??j.states;return json(j.states[0]);}
  if((m=p.match(/^\/jobs\/(\w+)$/))){const j=jobs.get(m[1]);const st=j.states.length>1?j.states.shift():j.states[0];if(st.state==='available')Object.assign(assets.get(st.assetId),j.onAvailable);return json(st);}
  if((m=p.match(/^\/media\/(\w+)$/)))return json(assets.get(m[1]));
  if((m=p.match(/^\/media\/(\w+)\/content$/))){const c=content.get(m[1]);return {ok:true,status:200,headers:new Headers(c.headers),body:(async function*(){yield c.bytes;})()};}
  if(p==='/contacts')return {ok:true,json:async()=>({items:contacts,nextCursor:null,sourceGeneration:'g'})};
  if(p==='/groups')return {ok:true,json:async()=>({items:groups,nextCursor:null,sourceGeneration:'g'})};
  if(p.startsWith('/contacts/')){const id=decodeURIComponent(p.slice(10));return {ok:true,json:async()=>contacts.find(r=>r.id===id)??{id,username:id,displayName:id}};}
  if(p.endsWith('/members'))return {ok:true,json:async()=>({items:members,nextCursor:null,sourceGeneration:'g'})};
  if(p.startsWith('/groups/')){const id=decodeURIComponent(p.slice(8));return {ok:true,json:async()=>groups.find(r=>r.id===id)??{id,roomId:id,displayName:id}};}
  if(p.endsWith('/ack')){ackCursors.push(JSON.parse(init.body).cursor);return {ok:true,json:async()=>({})};}
  // p4 outbound media: multipart staging + media send jobs (accepted with a correlated native receipt on GET).
  if(p==='/uploads'&&init?.method==='POST'){const body=Buffer.from(init.body),boundary=/boundary=(.+)$/.exec(init.headers['Content-Type'])[1],start=body.indexOf('\r\n\r\n')+4,end=body.lastIndexOf('\r\n--'+boundary+'--');const bytes=body.subarray(start,end);
   uploads.push({size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),header:body.subarray(0,start).toString()});return {ok:true,status:201,json:async()=>({id:'U'+uploads.length,name:'x',mediaType:'x',byteLength:bytes.length,sha256:uploads.at(-1).sha256,createdAt:'t'})};}
  if(p==='/sends'&&JSON.parse(init.body).kind){const b=JSON.parse(init.body);mediaSends.push({b,key:init.headers['Idempotency-Key']});const job={id:'J'+mediaSends.length,accountId:'daemon',kind:'send',state:'queued',phase:'queued',sourceId:b.sourceId,threadId:b.threadId,serverMessageId:null,result:null};
   receipts.set(init.headers['Idempotency-Key'],{...job,state:'accepted',phase:'completed',serverMessageId:'NM'+mediaSends.length,result:b.kind==='voice'?{chunks:[{index:0,state:'accepted',durationMs:1000,serverMessageId:'NM'+mediaSends.length}]}:{nativeReceipt:{status:'server_accepted',serviceCode:0,serverMessageId:'NM'+mediaSends.length,clientIdMatches:true}}});return json(job);}
  if(p==='/sends'){const b=JSON.parse(init.body);posts.push(b.text);sendBodies.push(b);const receipt={id:'S'+posts.length,accountId:'daemon',destination:b.threadId,state:'accepted'};receipts.set(init.headers['Idempotency-Key'],receipt);return {ok:true,json:async()=>({...receipt,state:'queued'})};}
  if(p==='/sends/by-idempotency-key')return {ok:true,json:async()=>receipts.get(url.searchParams.get('key'))};
  throw Error('unexpected '+p);};
 const rt=createRuntime();const storePath=rt.channel.session.resolveStorePath(undefined,{agentId:'main'});
 let lastSessionKey;const turns=[];
 const replyResolver=async(ctx)=>{turns.push(ctx);await onReply?.({ctx,cfg,scope:run=>scope(lease.registry,run)});const sessionKey=lastSessionKey=ctx.SessionKey,entry=loadEntry({agentId:'main',storePath,sessionKey});
  // Host threading policy (plugin threading adapter, else default "all") decides the implicit replyToId.
  const mode=resolveReplyToMode(cfg,CHANNEL,ctx.AccountId,ctx.ChatType);const current=ctx.MessageSidFull??ctx.MessageSid;
  const payload=replyToModeFilter(mode,CHANNEL)({text:replyText??('pong '+current),...(replyExtra?.(ctx,state)??{}),...(current&&implicitAllowed(mode)?{replyToId:current}:{})});
  const deliveryId=crypto.randomUUID(),intentId=crypto.randomUUID();
  setMeta(payload,{pendingFinalDeliveryCompletion:{commandOwnerReference:undefined,agentId:'main',deliveryId,intentId,sessionId:entry?.sessionId,sessionKey,storePath}});
  await updateSessionEntry({agentId:'main',storePath,sessionKey},e=>e.sessionId===entry?.sessionId?{pendingFinalDelivery:{...(payload.text?{kind:'replayable',text:payload.text}:{kind:'transport-only'}),intentId,deliveries:[{id:deliveryId,state:'prepared'}],context:{channel:CHANNEL,to:ctx.To,accountId:'local'},createdAt:Date.now()},updatedAt:Date.now()}:null,{skipMaintenance:true,takeCacheOwnership:true});
  return payload;};
 const dispatch=rt.channel.inbound.dispatch;rt.channel.inbound.dispatch=p=>dispatch({...p,delivery:{...p.delivery,onError:(err,info)=>{errors.push(err);p.delivery.onError?.(err,info)}},replyResolver});
 const plugin=built.makePlugin(rt,fetcher);lease.registry.channels[0].plugin=plugin;setActive(lease.registry);
 let abort,life;const startAccount=()=>{abort=new AbortController();life=scope(lease.registry,()=>plugin.gateway.startAccount({cfg,accountId:'local',abortSignal:abort.signal,setStatus(){}}));life.catch(()=>{});};startAccount();
 const acks=()=>calls.filter(c=>c.endsWith('/ack')).length;
 const waitFor=async(pred,ms=15000)=>{for(let i=0;i<ms/50&&!pred();i++)await new Promise(r=>setTimeout(r,50));return pred();};
 const diag=()=>{try{return readFileSync(state+'/journal/diag.log','utf8').trim().split('\n').map(l=>JSON.parse(l));}catch{return [];}};
 let n=0;
 return {state,cfg,calls,posts,sendBodies,errors,uploads,mediaSends,ackCursors,plugin,contexts:turns,diag,storePath,turns,acks,waitFor,assets,jobs,
  get sessionKey(){return lastSessionKey;},
  session:key=>loadEntry({agentId:'main',storePath,sessionKey:key}),
  patchSession:(key,fn)=>updateSessionEntry({agentId:'main',storePath,sessionKey:key},fn,{skipMaintenance:true,takeCacheOwnership:true}),
  /** Script one media message: native fields + assets [{id,kind,variant,state,bytes,contentType,filename,script:[{id,states:[job...]}]}]. */
  mediaMessage(n,{type,appMessageType=null,body=null,quote=null,assets:list=[],...overrides}){const id='M'+n;
   messages.set(id,{id,accountId:'daemon',threadId:'PeerX',senderId:'PeerX',direction:'incoming',type,appMessageType,quote,body,media:[],...overrides});
   media.set(id,list.map(a=>a.id));
   for(const a of list){const sha=createHash('sha256').update(a.bytes).digest('hex');const ready={state:'available',contentType:a.contentType,byteLength:a.bytes.length,sha256:sha,contentUrl:`/v1/accounts/daemon/media/${a.id}/content`};
    assets.set(a.id,{id:a.id,accountId:'daemon',messageId:id,kind:a.kind,variant:a.variant,actualVariant:null,state:a.state??'available',filename:a.filename??null,expiresAt:null,reason:null,retryable:true,jobId:null,contentUrl:null,animationFrames:null,officialWriteback:'complete',contentType:null,byteLength:null,sha256:null,...(a.state&&a.state!=='available'?{}:ready),script:a.script??[]});
    for(const s of a.script??[])s.onAvailable=ready;
    content.set(a.id,{bytes:a.bytes,headers:{'content-type':a.contentType,'content-length':String(a.bytes.length),etag:`"${sha}"`}});}},
  push(){n++;log.push(`id: c${n}\ndata: ${JSON.stringify({cursor:'c'+n,kind:'message.committed',data:{origin:'live',direction:'incoming',threadId:messages.get('M'+n)?.threadId??'PeerX',messageId:'M'+n}})}\n\n`);wakeAll();return n;},
  get next(){return n+1;},
  textMessage(n,overrides={}){messages.set('M'+n,{id:'M'+n,accountId:'daemon',threadId:'PeerX',senderId:'PeerX',direction:'incoming',type:1,media:[],body:'synthetic caption',...overrides});},
  async inbound(overrides={}){if(Object.keys(overrides).length)messages.set('M'+(n+1),{id:'M'+(n+1),accountId:'daemon',threadId:'PeerX',senderId:'PeerX',direction:'incoming',type:1,media:[],body:'ping M'+(n+1),...overrides});const before=acks();this.push();await waitFor(()=>acks()>before);return diag().filter(e=>e.event==='dispatch.result').at(-1);},
  /** Simulated process restart of the account consumer (same journal dir, replay from journaled cursor). */
  async restart(){abort.abort();wakeAll();await life.catch(()=>{});startAccount();},
  async close(){abort.abort();wakeAll();await life.catch(()=>{});await lease.release();}};
}
// Current plugin logs only the final counts; older builds logged a truncated host blob (parse by regex).
export const finalCounts=r=>r.final??JSON.parse(r.delivery.match(/"final":(\{"delivered"[^}]*\})/)[1]);
