// Phase 2 wiring stays separate from media transport and host lifecycle code.
import {textParts,messageReceipt} from './multipart.mjs';
import {Directory} from './directory.mjs';
import {exactId,isRoom,groupAllowed} from './policy.mjs';
import {bindMultipartPlan,bindSendAuthority,prepareOwnerPayload,resolveOwnerPlan} from './authority.mjs';
import {settleQueued} from './settle.mjs';
import {payloadMediaUrls,planMediaPart,deliverMediaPart,reconcileMediaPart,mediaReceipt,releaseOwned,MediaSendError,accountMediaCaps} from './outbound-media.mjs';
import {bindMediaPlan,bindMediaAuthority,planText} from './authority.mjs';
import {createHash} from 'node:crypto';
// Host-authorized media loader (roots/readFile from the delivery ctx); loaded lazily so unit tests can inject one.
const loadOutbound=async(url,options)=>(await import('openclaw/plugin-sdk/outbound-media')).loadOutboundMediaFromUrl(url,options);
export function contactsFeatures(account,active,diag){
 function get(cfg,id){const a=account(cfg,id),owner=active.get(a.accountId);if(!owner)throw Error('Account consumer not active');return {a,owner,directory:owner.directory};}
 async function queryEntries(a,directory,kind,query,limit){if(query){const r=await directory.target(query);return r.kind===(kind==='groups'?'group':'user')?[r]:[];}return directory.entries(kind,query,limit);}
 function assertText(payload){if(!payload||typeof payload.text!=='string'||!payload.text.length||payload.mediaUrl||payload.mediaUrls?.length||payload.presentation||payload.interactive||payload.location)throw Error('Plain text only');}
 async function send(ctx,token,logicalIdOverride){
  const {a,owner,directory}=get(ctx.cfg,ctx.accountId);if(ctx.threadId!=null||ctx.replyToId!=null||ctx.silent||ctx.mediaUrl)throw Error('Unquoted conversation text only');
  const text=ctx.text;if(typeof text!=='string'||!text.length||text.length>4000)throw Error('Plain text only');
  const logicalId=logicalIdOverride??(ctx.deliveryQueueId?JSON.stringify([ctx.deliveryQueueId,ctx.deliveryPartIndex??0]):ctx.preparedMessageId);if(!logicalId)throw Error('host durable delivery identity required');
  if(!token&&a.legacyPolicy&&ctx.to!==a.verifiedPeer)throw Error('send denied: explicit owner contact plan required');
  let peerId;
  if(token){const plan=resolveOwnerPlan(a,owner.adapter.j,token);if(ctx.to!==plan.peerId&&ctx.to!==plan.routeTo)throw Error('Owner target mismatch');peerId=plan.peerId;}
  else peerId=(await directory.target(ctx.to)).id;
  const payload={peerId,text,logicalId,partIndex:ctx.deliveryPartIndex??0};const authorization=bindSendAuthority(a,owner.adapter.j,payload,token);
  try{await ctx.onPlatformSendDispatch?.();ctx.assertDirectAdapterHandoff?.();if(ctx.signal?.aborted)throw Error('Send aborted');
   let receipt=await owner.adapter.send({...payload,authorization},owner.client);
   if(receipt.state==='reconciliation-required')try{receipt=await owner.adapter.reconcileSend(payload,owner.client);}catch{}
   receipt=await settleQueued(receipt,()=>owner.adapter.reconcileSend(payload,owner.client),r=>!!r?.id&&r.accountId===a.daemonAccountId&&r.destination===peerId,{signal:ctx.signal});
   if(!receipt.id||receipt.accountId!==a.daemonAccountId||receipt.destination!==peerId||receipt.state!=='accepted')throw Error('send uncertain; reconcile only');
   diag(a.journalDir,'sendText.receipt',{accepted:1});return {channel:'wechat-native-isolated',messageId:receipt.id,chatId:peerId};
  }catch(error){diag(a.journalDir,'sendText.error',{errorClass:error instanceof Error?error.name:'UnknownError'});throw error;}
 }
 const mediaLoadOptions=ctx=>({...(ctx.mediaAccess!==undefined?{mediaAccess:ctx.mediaAccess}:{}),...(ctx.mediaLocalRoots?{mediaLocalRoots:ctx.mediaLocalRoots}:{}),...(ctx.mediaReadFile?{mediaReadFile:ctx.mediaReadFile}:{})});
 const partResult=(peerId,id,kind,index)=>({channel:'wechat-native-isolated',messageId:id,chatId:peerId,receipt:{primaryPlatformMessageId:id,platformMessageIds:[id],parts:[{platformMessageId:id,kind,index}],sentAt:Date.now()}});
 // Send already-planned media parts in order; report each accepted physical message (incl. partial voice chunks) first.
 async function deliverPlanned(ctx,owner,a,peerId,plans,collected){
  for(const plan of plans){
   try{const v=await deliverMediaPart({j:owner.adapter.j,client:owner.client,plan,signal:ctx.signal,...(owner.mediaPoll?{poll:owner.mediaPoll,sleep:async()=>{}}:{}),beforeSend:async()=>{await ctx.onPlatformSendDispatch?.();ctx.assertDirectAdapterHandoff?.();}});
    for(const id of v.ids){collected.push({id,kind:v.kind});await ctx.onDeliveryResult?.(partResult(peerId,id,v.kind,collected.length-1));}releaseOwned(plan);
   }catch(error){
    if(error instanceof MediaSendError)for(const id of error.ids??[]){collected.push({id,kind:'voice'});await ctx.onDeliveryResult?.(partResult(peerId,id,'voice',collected.length-1));}
    diag(a.journalDir,'sendMedia.error',{errorClass:error instanceof MediaSendError?error.code:error instanceof Error?error.name:'UnknownError',kind:plan.kind,accepted:error?.ids?.length??0,...(error?.status?{status:error.status}:{})});throw error;}
  }
 }
 // Plan every media part (load, verify, cap, authorize, owned copy) before any part is sent.
 async function planAll(ctx,owner,a,peerId,urls,first,voice,token,logicalIdFor,authorize){
  const plans=[];for(let i=0;i<urls.length;i++){const index=first+i,logicalId=logicalIdFor(index);
   plans.push(await planMediaPart({j:owner.adapter.j,scope:owner.adapter.scope(),account:a.daemonAccountId,peerId,logicalId,mediaUrl:urls[i],voice,forceDocument:ctx.forceDocument===true,load:owner.loadMedia??loadOutbound,loadOptions:mediaLoadOptions(ctx),authorize:plan=>authorize({peerId,logicalId,partIndex:index,sha256:plan.sha256}),journalDir:a.journalDir,token:token??null,caps:accountMediaCaps(a,owner.mediaCaps)}));}
  return plans;
 }
 /** Plan-token media payload: text parts first (indexes 0..t-1), then media parts (t..t+n-1), one host queue entry. */
 async function sendMediaPayload(ctx,token){
  const {a,owner}=get(ctx.cfg,ctx.accountId);if(ctx.threadId!=null||ctx.replyToId!=null||ctx.silent)throw Error('Unquoted conversation media only');
  const queueId=ctx.deliveryQueueId;if(!queueId||(ctx.deliveryPartIndex??0)!==0)throw Error('Media host queue identity required');
  const plan=resolveOwnerPlan(a,owner.adapter.j,token);if(ctx.to!==plan.peerId&&ctx.to!==plan.routeTo)throw Error('Owner target mismatch');
  const {parts,urls}=bindMediaPlan(a,owner.adapter.j,token,queueId,ctx.payload),peerId=plan.peerId;
  try{const plans=await planAll(ctx,owner,a,peerId,urls,parts.length,plan.media.voice,token,index=>JSON.stringify([queueId,index]),p=>bindMediaAuthority(a,owner.adapter.j,p,token));
   const collected=[];
   for(let index=0;index<parts.length;index++){const r=await send({...ctx,text:parts[index],mediaUrl:undefined,deliveryPartIndex:index},token);collected.push({id:r.messageId,kind:'text'});await ctx.onDeliveryResult?.(partResult(peerId,r.messageId,'text',collected.length-1));}
   await deliverPlanned(ctx,owner,a,peerId,plans,collected);
   diag(a.journalDir,'sendMedia.receipt',{text:parts.length,media:plans.length,accepted:collected.length});
   return {channel:'wechat-native-isolated',messageId:collected[0].id,chatId:peerId,receipt:mediaReceipt(collected)};
  }catch(error){if(!(error instanceof MediaSendError))diag(a.journalDir,'sendMedia.error',{errorClass:error instanceof Error?error.name:'UnknownError'});throw error;}
 }
 /** Host core media unit (no plan token): one media URL, caption only on the leading unit; origin-based authority. */
 async function sendMediaUnit(ctx){
  const {a,owner,directory}=get(ctx.cfg,ctx.accountId);if(ctx.threadId!=null||ctx.replyToId!=null||ctx.silent)throw Error('Unquoted conversation media only');
  const queueId=ctx.deliveryQueueId,index=ctx.deliveryPartIndex??0;if(!queueId)throw Error('Media host queue identity required');
  if(a.legacyPolicy&&ctx.to!==a.verifiedPeer)throw Error('send denied: explicit owner contact plan required');
  const peerId=(await directory.target(ctx.to)).id,caption=typeof ctx.text==='string'?ctx.text.trim():'';
  const [plan]=await planAll(ctx,owner,a,peerId,[ctx.mediaUrl],index,ctx.audioAsVoice===true,null,i=>JSON.stringify([queueId,i]),p=>bindMediaAuthority(a,owner.adapter.j,p,undefined));
  const collected=[];const captionParts=caption?textParts(caption):[];
  for(let k=0;k<captionParts.length;k++){const r=await send({...ctx,text:captionParts[k],mediaUrl:undefined},undefined,JSON.stringify([queueId,index,'caption',k]));collected.push({id:r.messageId,kind:'text'});await ctx.onDeliveryResult?.(partResult(peerId,r.messageId,'text',collected.length-1));}
  await deliverPlanned(ctx,owner,a,peerId,[plan],collected);
  return {channel:'wechat-native-isolated',messageId:collected[0].id,chatId:peerId,receipt:mediaReceipt(collected)};
 }
 // GET-only recovery for a media-bearing payload. "not_sent" only when the journal proves no part was ever POSTed
 // (send intents are fsynced before any POST); every part accepted -> sent; anything else stays unresolved.
 async function reconcileMedia(ctx,a,owner,p){
  const j=owner.adapter.j,scope=owner.adapter.scope(),urls=payloadMediaUrls(p),text=planText(p),token=p.channelData?.wechatSendPlan;let peerId=ctx.to,layout=[];
  if(p.channelData){if(typeof token!=='string'||Object.keys(p.channelData).length!==1)return {status:'unresolved',retryable:false};const plan=resolveOwnerPlan(a,j,token);if(ctx.to!==plan.peerId&&ctx.to!==plan.routeTo)return {status:'unresolved',retryable:false};peerId=plan.peerId;
   const parts=text?textParts(text):[];layout=[...parts.map((part,i)=>({text:part,logicalId:JSON.stringify([ctx.queueId,i])})),...urls.map((_,i)=>({logicalId:JSON.stringify([ctx.queueId,parts.length+i])}))];}
  else{if(!exactId(peerId))return {status:'unresolved',retryable:false};const caption=text?textParts(text):[];layout=[...caption.map((part,k)=>({text:part,logicalId:JSON.stringify([ctx.queueId,0,'caption',k])})),...urls.map((_,i)=>({logicalId:JSON.stringify([ctx.queueId,i])}))];}
  const results=[];let sent=0,unsent=0;
  for(const part of layout){
   if(part.text!==undefined){const key=createHash('sha256').update(JSON.stringify([scope,peerId,part.logicalId])).digest('hex');
    if(!j.rows.some(r=>r.type==='send-intent'&&r.scope===scope&&r.key===key)){unsent++;continue;}
    try{const r=await owner.adapter.reconcileSend({peerId,text:part.text,logicalId:part.logicalId},owner.client);if(r?.id&&r.accountId===a.daemonAccountId&&r.destination===peerId&&r.state==='accepted'){results.push({id:r.id,kind:'text'});sent++;}}catch{}
    continue;}
   const v=await reconcileMediaPart({j,client:owner.client,scope,peerId,logicalId:part.logicalId});
   if(v.state==='unplanned'||v.state==='unsent'){unsent++;continue;}
   if(v.state==='sent'){for(const id of v.ids)results.push({id,kind:v.kind});sent++;releaseOwned(v.plan);}
  }
  diag(a.journalDir,'reconcileMedia',{parts:layout.length,sent,unsent});
  if(sent===layout.length)return {status:'sent',messageId:results[0].id,receipt:mediaReceipt(results)};
  if(unsent===layout.length)return {status:'not_sent'};
  return {status:'unresolved',retryable:false};
 }
 return {
  messaging:{normalizeTarget:v=>typeof v==='string'&&v.trim()&&!/[\x00-\x1f\x7f]/u.test(v)&&v.trim()!=='*'?v.trim():undefined,inferTargetChatType:({to})=>isRoom(to)?'group':'direct',targetResolver:{looksLikeId:v=>/^wxid_[^\s]+$/u.test(v)||isRoom(v)||[...active.values()].some(o=>o.account?.allowFrom.includes(v)),hint:'exact contact ID or unique contact/remark name',resolveTarget:async({cfg,accountId,input})=>{const {directory}=get(cfg,accountId);const r=await directory.target(input);return {to:r.id,kind:r.kind,display:r.name,source:'directory'};}}},
  directory:{listPeers:async({cfg,accountId,query,limit})=>{const {a,directory}=get(cfg,accountId);if(a.legacyPolicy)return a.allowFrom.filter(id=>!query||id.includes(query)).map(id=>({kind:'user',id,name:id}));return queryEntries(a,directory,'contacts',query,limit);},listGroups:async({cfg,accountId,query,limit})=>{const {a,directory}=get(cfg,accountId);return (await queryEntries(a,directory,'groups',query,limit)).filter(r=>groupAllowed(a,r.id));},listGroupMembers:async({cfg,accountId,groupId,limit})=>{const {a,directory}=get(cfg,accountId);if(!groupAllowed(a,groupId))return [];return (await directory.list('members',groupId)).slice(0,limit??200).map(r=>({kind:'user',id:r.username??r.id,name:r.roomDisplayName??r.displayName??r.id}));}},
  actions:{describeMessageTool:()=>({actions:['send']}),supportsAction:({action})=>action==='send',prepareSendPayload:async({ctx,to,payload,replyToId,threadId})=>{
   const {a,owner,directory}=get(ctx.cfg,ctx.accountId);if(!payloadMediaUrls(payload).length)assertText(payload);if(replyToId!=null||threadId!=null||payload.channelData)throw Error('Plain unquoted text only');
   // Compatibility is restricted to the one pre-existing peer, never a directory contact.
   if(a.legacyPolicy&&to===a.verifiedPeer&&ctx.requesterSenderId==null)return payload;
   const target=await directory.target(to);return prepareOwnerPayload(a,owner.adapter.j,ctx,target.id,payload,to);
  }},
  outbound:{deliveryMode:'direct',textChunkLimit:4000,sendText:ctx=>send(ctx),sendMedia:ctx=>sendMediaUnit(ctx),sendPayload:async ctx=>{if(payloadMediaUrls(ctx.payload).length){const token=ctx.payload.channelData?.wechatSendPlan;if(typeof token!=='string'||Object.keys(ctx.payload.channelData).length!==1)throw Error('Owner send plan required');return sendMediaPayload(ctx,token);}assertText(ctx.payload);const token=ctx.payload.channelData?.wechatSendPlan;if(typeof token!=='string'||Object.keys(ctx.payload.channelData).length!==1)throw Error('Owner send plan required');const {a,owner}=get(ctx.cfg,ctx.accountId),parts=textParts(ctx.payload.text);if(parts.length===1)return send({...ctx,text:parts[0]},token);
   if(!ctx.deliveryQueueId||(ctx.deliveryPartIndex??0)!==0)throw Error('Multipart host queue identity required');
   const plan=resolveOwnerPlan(a,owner.adapter.j,token);if(ctx.to!==plan.peerId&&ctx.to!==plan.routeTo)throw Error('Owner target mismatch');
   bindMultipartPlan(a,owner.adapter.j,token,ctx.deliveryQueueId,ctx.payload.text);
   const results=[];for(let index=0;index<parts.length;index++){
    const result=await send({...ctx,text:parts[index],deliveryPartIndex:index},token);results.push(result);
    await ctx.onDeliveryResult?.({...result,receipt:{...messageReceipt([result]),parts:[{platformMessageId:result.messageId,kind:'text',index}]}});
   }return {...results[0],receipt:messageReceipt(results)};}},
  durableFinal:{capabilities:{text:true,media:true,payload:true,reconcileUnknownSend:true},automaticUnknownSendReconciliation:true,reconcileUnknownSendKinds:{text:true,media:true,payload:true},reconcileUnknownSend:async ctx=>{
   try{const {a,owner}=get(ctx.cfg,ctx.accountId),p=ctx.payloads[0];if(ctx.payloads.length!==1||ctx.threadId!=null||ctx.replyToId!=null||ctx.effectiveReplyToId!=null||ctx.silent)return {status:'unresolved',retryable:false};if(payloadMediaUrls(p).length)return await reconcileMedia(ctx,a,owner,p);assertText(p);
    let peerId=ctx.to;const token=p.channelData?.wechatSendPlan,parts=textParts(p.text);
    if(p.channelData){if(typeof token!=='string'||Object.keys(p.channelData).length!==1)return {status:'unresolved',retryable:false};const plan=resolveOwnerPlan(a,owner.adapter.j,token);if(ctx.to!==plan.peerId&&ctx.to!==plan.routeTo)return {status:'unresolved',retryable:false};peerId=plan.peerId;if(parts.length>1){const binding=owner.adapter.j.rows.find(r=>r.type==='send-plan-binding'&&r.scope===owner.adapter.scope()&&r.token===token&&r.queueId===ctx.queueId);if(!binding)return {status:'unresolved',retryable:false};}}
    if(!exactId(peerId))return {status:'unresolved',retryable:false};const results=[];let complete=true;
    for(let index=0;index<parts.length;index++){
     const logicalId=JSON.stringify([ctx.queueId,index]);
     try{if(token){const bound=owner.adapter.j.rows.find(r=>r.type==='send-authorization'&&r.scope===owner.adapter.scope()&&r.logicalId===logicalId&&r.token===token);if(!bound)throw Error('Missing part authorization');bindSendAuthority(a,owner.adapter.j,{peerId,text:parts[index],logicalId,partIndex:index},token);}
      const r=await owner.adapter.reconcileSend({peerId,text:parts[index],logicalId},owner.client);
      if(!r.id||r.accountId!==a.daemonAccountId||r.destination!==peerId||r.state!=='accepted')throw Error('Uncertain part');results.push({messageId:r.id});
     }catch{complete=false;}
    }
    if(!complete)return {status:'unresolved',retryable:false};return {status:'sent',messageId:results[0].messageId,receipt:messageReceipt(results)};
   }catch{return {status:'unresolved',retryable:false};}
  }}
 };
}
export const createDirectory=(a,client)=>new Directory(a,client);
