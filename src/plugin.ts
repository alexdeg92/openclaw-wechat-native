import type {ChannelPlugin,OpenClawPluginApi,PluginRuntime,OpenClawConfig} from 'openclaw/plugin-sdk/channel-core';
import {resolveSecretRefValues} from 'openclaw/plugin-sdk/secret-ref-runtime';
import {admitContext} from './host.js';
// Runtime JS modules are original implementations; checked independently by node tests.
import {Adapter,Journal,opaque} from './core.mjs';
import {daemonClient} from './daemon.mjs';
import {decodeInbound} from './decode-media.mjs';
import {prepareMediaEvent,MediaJobs} from './host-media.js';
import {InboundCoalescer,mergePrepared} from './coalesce.mjs';
import {appendFileSync} from 'node:fs';
import {resolveAccountConfig,accountSchema,conversationAllowed,isRoom,groupAllowed} from './policy.mjs';
import {readAccess,mergeAccess,changeAccess,readNames} from './access.mjs';
import {decideAccessCommand,isOwnerEnable} from './access-command.mjs';
import {withQuoteMention} from './quote-mention.mjs';
import {contactsFeatures,createDirectory} from './contacts.mjs';
import {withInboundOrigin,prepareReplyPayload} from './authority.mjs';
const ID='wechat-native-isolated';
const ACTIVE=Symbol.for('openclaw.wechat-native-isolated.active');
function diag(dir:string|undefined,event:string,detail:Record<string,unknown>={}){if(!dir)return;try{appendFileSync(dir+'/diag.log',JSON.stringify({at:new Date().toISOString(),event,...detail})+'\n');}catch{}}
async function tokenFor(a:Account,cfg:OpenClawConfig):Promise<string> {if(typeof a.token==='string')return a.token;const r=a.token;if(r?.source==='env'&&r.provider==='default'&&/^WX_NATIVE_ISOLATED_[A-Z0-9_]+$/.test(r.id)){const value=process.env[r.id];if(!value)throw Error('token SecretRef unresolved');return value;}if(r?.source!=='file'||r.provider!=='wechat-native-isolated'||r.id!=='value')throw Error('scoped SecretRef required');const values=await resolveSecretRefValues([r],{config:cfg});if(values.size!==1)throw Error('token SecretRef unresolved');const value=values.values().next().value;if(typeof value!=='string'||!value)throw Error('token SecretRef unresolved');return value;}
type Account={accountId:string;daemonAccountId:string;selfId:string;allowFrom:string[];baseUrl:string;token:string|{source:'env';provider:'default';id:string}|{source:'file';provider:'wechat-native-isolated';id:'value'};startAfter:string;journalDir:string;verifiedPeer?:string;enabled:boolean;ownerIds:string[];dmPolicy:'allowlist'|'disabled';groupPolicy:'allowlist'|'disabled';groups:Record<string,{requireMention?:true}>;legacyPolicy:boolean;mediaCaptionWindowMs:number;textMediaWindowMs:number;mediaMaxMb:number};
// Owner access overlay (access.json beside the journal) is merged on every resolve, so changes need no restart.
function account(cfg:OpenClawConfig,id?:string|null):Account {const a:any=resolveAccountConfig(cfg,id);return (typeof a.journalDir==='string'?mergeAccess(a,readAccess(a.journalDir)):a) as Account;}
export function makePlugin(runtime:PluginRuntime,fetcher:typeof fetch=fetch):ChannelPlugin<Account>{
 // Host may load separate plugin instances for outbound delivery; share the live consumer per process.
 const active:Map<string,{adapter:any;client:any;journalDir:string;directory:any;account:Account}>=((globalThis as any)[ACTIVE]??=new Map());
 const instance=Math.random().toString(36).slice(2,8);
 const contacts=contactsFeatures(account,active,diag);
 const plugin:ChannelPlugin<Account>={id:ID,meta:{id:ID,label:'WeChat native isolated',selectionLabel:'WeChat native isolated',docsPath:'/channels/wechat-native-isolated',blurb:'Allowlisted contacts and mentioned groups'},capabilities:{chatTypes:['direct','group'],media:true,
 // Native voice notes are supported through the daemon's audio transcoding and chunk receipts.
 tts:{voice:{synthesisTarget:'voice-note',transcodesAudio:true}}},
 configSchema:{schema:{type:'object',additionalProperties:false,required:['accounts'],properties:{accounts:{type:'object',minProperties:1,additionalProperties:accountSchema}}},uiHints:{'accounts.*.token':{sensitive:true}}},
 config:{listAccountIds:cfg=>Object.keys((cfg.channels as any)?.[ID]?.accounts??{}),resolveAccount:account,isEnabled:a=>a.enabled,isConfigured:a=>!!a.token,resolveAllowFrom:({cfg,accountId})=>account(cfg,accountId).allowFrom},
 // Text has no quote/reply transport. Without this the host defaults replyToMode to "all", stamps the inbound
 // message id on every agent final, and its post-preparation durable check then demands a replyTo capability we lack.
 threading:{resolveReplyToMode:()=>'off',allowExplicitReplyTagsWhenOff:false},
 messaging:contacts.messaging as any,directory:contacts.directory as any,actions:contacts.actions as any,
 message:{durableFinal:contacts.durableFinal as any},outbound:contacts.outbound as any,
 gateway:{startAccount:async ctx=>{
  const a=account(ctx.cfg,ctx.accountId);if(active.has(a.accountId))throw Error('single owner required');
  const stop=new AbortController(),signal=AbortSignal.any([ctx.abortSignal,stop.signal]);
  const journal=new Journal(a.journalDir),adapter=new Adapter(a,journal),client=daemonClient(a.baseUrl,await tokenFor(a,ctx.cfg),fetcher,signal),mediaJobs=new MediaJobs(a.journalDir);
  const directory=createDirectory(a,client);active.set(a.accountId,{adapter,client,journalDir:a.journalDir,directory,account:a});
  // The core keeps its own copy of the account; refresh its lists whenever an owner command changes access.
  const syncAccess=(x:any)=>{(adapter as any).c.allowFrom=[...x.allowFrom];(adapter as any).c.groups={...x.groups};};
  // Owner access changes are journaled (access-op) when decided and applied once (access-done). allow/remove/disable
  // apply after the command message has custody; enable applies before dispatch so the confirmation can reach the
  // group. Ops whose message has custody but were never applied (crash) are applied at startup.
  const scope=adapter.scope(),opFor=(key:string)=>journal.rows.find((r:any)=>r.type==='access-op'&&r.scope===scope&&r.key===key);
  const doneFor=(key:string)=>journal.rows.some((r:any)=>r.type==='access-done'&&r.scope===scope&&r.key===key);
  const custodyFor=(key:string)=>journal.rows.some((r:any)=>r.scope===scope&&(r.type==='custody'&&r.key===key||r.type==='burst-custody'&&r.keys.includes(key)));
  const applyOp=(key:string)=>{const op:any=opFor(key);if(!op||doneFor(key))return;
   try{mergeAccess(a,changeAccess(a.journalDir,op.op,op.ids).overlay);syncAccess(a);journal.append({type:'access-done',scope,key});diag(a.journalDir,'access.applied',{op:op.op,count:op.ids.length});}
   catch{diag(a.journalDir,'access.failed',{op:op.op});}};
  for(const r of journal.rows.filter((r:any)=>r.type==='access-op'&&r.scope===scope))if(!doneFor(r.key)&&custodyFor(r.key))applyOp(r.key);
  diag(a.journalDir,'startAccount',{count:1});ctx.setStatus({accountId:a.accountId,running:true});
  const dispatch=async(e:any)=>{const kind=isRoom(e.peerId)?'group' as const:'direct' as const;const senderName=await directory.senderLabel(e.senderId,kind==='group'?e.peerId:undefined);const groupName=kind==='group'?await directory.roomLabel(e.peerId):undefined;const route=runtime.channel.routing.resolveAgentRoute({cfg:ctx.cfg,channel:ID,accountId:a.accountId,peer:{kind,id:e.peerId},dmScope:'per-account-channel-peer'});const binding={agentId:route.agentId,sessionKey:route.sessionKey,peerId:e.peerId,senderId:e.senderId,kind,messageId:e.messageId,accountId:a.accountId,nativeChannelId:e.peerId};const payload=await admitContext(runtime,{channel:ID,accountId:a.accountId,messageId:e.messageId,from:e.peerId,sender:{id:e.senderId,name:senderName},conversation:{kind,id:e.peerId,nativeChannelId:e.peerId,label:groupName},route:{agentId:route.agentId,routeSessionKey:route.sessionKey,dmScope:'per-account-channel-peer'},reply:{to:e.peerId},message:{body:e.text,rawBody:e.text,inboundEventKind:'user_request',...(e.sourceModality?{sourceModality:e.sourceModality}:{})},...(e.media?.length?{media:e.media}:{}),...(kind==='group'?{access:{mentions:{canDetectMention:true,wasMentioned:true,requireMention:true,explicitlyMentionedBot:true,mentionedUserIds:e.mentions.userIds,mentionSource:'explicit_bot' as const}}}:{})},{allowFrom:a.allowFrom,dmPolicy:a.dmPolicy,groupAllowed:groupAllowed(a,e.peerId),readStoreAllowFrom:async()=>[]},binding);if(!payload)return;let recorded=false;const result=await withInboundOrigin({accountId:a.accountId,daemonAccountId:a.daemonAccountId,peerId:e.peerId,senderId:e.senderId},()=>runtime.channel.inbound.dispatch({afterRecord:()=>{recorded=true;},cfg:ctx.cfg,channel:ID,accountId:a.accountId,route:{agentId:route.agentId,sessionKey:route.sessionKey},ctxPayload:payload,messageId:e.messageId,delivery:{preparePayload:(p:any)=>prepareReplyPayload(a,journal,e,p),durable:{to:e.peerId,requiredCapabilities:{text:true,media:true,payload:true,reconcileUnknownSend:true}},deliver:async()=>{diag(a.journalDir,'deliver.fallback',{count:1});throw Error('durable core delivery required; direct fallback refused');},onError:(err:unknown,info:{kind?:string}|undefined)=>{diag(a.journalDir,'deliver.error',{errorClass:(err as Error)?.name??'UnknownError'});}}}));diag(a.journalDir,'dispatch.result',{recorded,dispatched:result?.dispatched,final:(((result as any)?.dispatchResult??(result as any)?.result)?.settledReceipt?.counts?.final)??null});if(!recorded||!result.dispatched)throw Error('host custody unconfirmed; quarantine');};
  const collector=new InboundCoalescer({account:a,signal,onError:(error:unknown)=>stop.abort(error),deliver:async (burst:any)=>{
   if(signal.aborted)return;
   const sources=burst.sources,prepared=[];
   if(sources.length>1)diag(a.journalDir,'inbound.burst',{sources:sources.length,media:sources.filter((e:any)=>e.kind==='direct-media').length});
   // Strict per-source gates precede collection. Media is still prepared before the custody intent.
   for(const source of sources){let e=source;
    if(!adapter.hasCustody(e)&&e.kind==='direct-media')e=await prepareMediaEvent(e,{runtime,cfg:ctx.cfg,accountId:a.accountId,channel:ID,client,daemonAccountId:a.daemonAccountId,jobs:mediaJobs,signal,diag:(ev,d)=>diag(a.journalDir,ev,{instance,...d})});
    prepared.push(e);
   }
   if(signal.aborted)return;
   if(prepared.length)await adapter.receiveBatch(prepared,async (value:any)=>{
    const fresh=Array.isArray(value)?value:[value],raw=fresh.map(e=>sources.find((s:any)=>s.messageId===e.messageId));
    await dispatch(mergePrepared(raw,fresh));
   });
   else journal.append({type:'cursor',scope:adapter.scope(),cursor:opaque(burst.cursor)});
   for(const source of sources){const key=adapter.sourceKey(source);if(custodyFor(key))applyOp(key);}
   // ACKs remain in SSE order, strictly after every source in the burst has custody.
   if(!signal.aborted)for(const source of sources.length?sources:[{cursor:burst.cursor}])await client.ack(a.daemonAccountId,source.cursor);
  }});
  let streamError:unknown;
  try{
   try{for await(const event of client.events(a.daemonAccountId,adapter.cursor()??a.startAfter)){
    if(signal.aborted)break;let e=null;
    if(event.kind==='message.committed'&&(event.data?.origin==='live'||event.data?.origin==='catchup')&&event.data?.direction==='incoming'){
     const thread=event.data?.threadId,allowed=conversationAllowed(a,thread);let message:any=null;
     if(allowed)message=withQuoteMention(a,await client.message(a.daemonAccountId,event.data.messageId));
     // A group that is not enabled: read locally only to spot the owner's explicit "@bot enable this group".
     // Never logged or dispatched otherwise; a daemon error here must not stop the account consumer.
     else if(isRoom(thread)&&a.groupPolicy==='allowlist'){try{const m=await client.message(a.daemonAccountId,event.data.messageId);if(isOwnerEnable(a,m))message=m;}catch{diag(a.journalDir,'access.probe',{error:true});}}
     if(message){
      // Same decode gates as any message (live/recent catch-up, sender, explicit mention); an off group is
      // evaluated as if enabled, so a stale or replayed enable is dropped here before anything changes.
      e=decodeInbound(event,message,a.daemonAccountId,allowed?a:{...a,groups:{...a.groups,[thread]:{requireMention:true}}});
      if(e&&!adapter.hasCustody(e)){const d=await decideAccessCommand({a,e,message,label:(id:string,room?:string)=>directory.senderLabel(id,room),roomLabel:(room:string)=>directory.roomLabel(room),realNames:typeof a.journalDir==='string'?readNames(a.journalDir):{},roomMembers:async(room:string)=>(await directory.list('members',room)).map((r:any)=>({id:r.username??r.id,name:[r.roomDisplayName,r.remark,r.displayName,r.nickname].find((v:any)=>typeof v==='string'&&v.length)}))});
       if(d){e={...e,text:d.text};diag(a.journalDir,'access.command',{op:d.op??'none'});
        if(d.op){const key=adapter.sourceKey(e);if(!opFor(key))journal.append({type:'access-op',scope,key,op:d.op,ids:d.ids});if(d.op==='enable')applyOp(key);}}}
      if(e&&!conversationAllowed(a,thread))e=null;
     }
    }
    await collector.add(e,opaque(event.cursor));
   }}catch(error){streamError=error;}
   await collector.finish({flush:!signal.aborted&&!streamError});
   if(streamError)throw streamError;
  }finally{active.delete(a.accountId);journal.close();mediaJobs.close();ctx.setStatus({accountId:a.accountId,running:false});}
 }}};return plugin;
}
export default {id:ID,name:'WeChat native isolated',description:'Original contact and group channel',register(api:OpenClawPluginApi){api.registerChannel({plugin:makePlugin(api.runtime)});}};
