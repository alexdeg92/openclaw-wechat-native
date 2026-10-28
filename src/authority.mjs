// Request-local provenance; no process-wide last-sender state and no model-supplied owner flags.
import {textParts} from './multipart.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {ownerRequester,conversationAllowed,exactId,isRoom} from './policy.mjs';
import {payloadMediaUrls} from './outbound-media.mjs';
const SHARED=Symbol.for('openclaw.wechat-native-isolated.authority');
const {origins,grants}=(globalThis[SHARED]??= {origins:new AsyncLocalStorage(),grants:new WeakSet()});
export const withInboundOrigin=(origin,run)=>origins.run(Object.freeze({...origin}),run);
export const textDigest=text=>createHash('sha256').update(text).digest('hex');
const scope=a=>JSON.stringify([a.accountId,a.daemonAccountId]);
function mint(a,peerId,text,logicalId){const g=Object.freeze({scope:scope(a),peerId,digest:textDigest(text),logicalId});grants.add(g);return g;}
export function validGrant(a,p,g){return !!g&&grants.has(g)&&g.scope===scope(a)&&g.peerId===p.peerId&&g.logicalId===p.logicalId&&g.digest===textDigest(p.text);}
export function prepareOwnerPayload(a,j,ctx,peerId,payload,routeTo=peerId){
 if(!ownerRequester(a,ctx))throw Error('Only the configured owner may send to other contacts');
 if(!exactId(peerId)||peerId===a.selfId||!sendableShape(payload))throw Error('Owner contact sends support plain text and media only');
 const token=randomUUID();j.append({type:'owner-send-plan',scope:scope(a),token,peerId,routeTo,...planContent(payload),requesterId:ctx.requesterSenderId});return {...payload,channelData:{wechatSendPlan:token}};
}
export function prepareReplyPayload(a,j,e,payload){
 if(!sendableShape(payload))throw Error('Plain reply text and media only');
 if(!conversationAllowed(a,e.peerId)||e.senderId===a.selfId)throw Error('Reply source no longer admitted');
 const token=randomUUID();j.append({type:'reply-send-plan',scope:scope(a),token,peerId:e.peerId,routeTo:e.peerId,...planContent(payload),requesterId:e.senderId,messageId:e.messageId});return {...payload,channelData:{wechatSendPlan:token}};
}
// Text (possibly empty when media is present) plus up to MAX_MEDIA media references; no presentation/location/channelData.
export const MAX_MEDIA=9;
function sendableShape(p){if(!p||p.channelData||p.presentation||p.interactive||p.location)return false;const urls=payloadMediaUrls(p),text=planText(p);
 return typeof text==='string'&&urls.length<=MAX_MEDIA&&(text.length>0||urls.length>0);}
// Media payloads bind trimmed text: the host trims around its cross-context marker after plan preparation.
// Text-only plans keep exact text (unchanged Phase 2 behavior).
export function planText(p){const text=p?.text??'';return typeof text==='string'&&payloadMediaUrls(p).length?text.trim():text;}
// Plans bind text digests and the media count/voice hint. Media bytes bind at first send (host spools and renames URLs).
function planContent(p){const text=planText(p),urls=payloadMediaUrls(p);return {digest:textDigest(text),parts:text?textParts(text).map(textDigest):[],...(urls.length?{media:{count:urls.length,voice:p.audioAsVoice===true}}:{})};}
export function bindSendAuthority(a,j,p,token){
 if(isRoom(p.peerId)&&!conversationAllowed(a,p.peerId))throw Error('Group target no longer allowed');
 const digest=textDigest(p.text),s=scope(a),prior=j.rows.find(r=>r.type==='send-authorization'&&r.scope===s&&r.logicalId===p.logicalId);
 if(prior){if(prior.peerId!==p.peerId||prior.digest!==digest||prior.token!==(token??null))throw Error('Send authorization payload conflict');if(prior.ownerId&&!a.ownerIds.includes(prior.ownerId))throw Error('Owner send authority revoked');if(!prior.ownerId&&!conversationAllowed(a,p.peerId))throw Error('Reply target no longer allowed');return mint(a,p.peerId,p.text,p.logicalId);}
 let ownerId=null;
 if(token){const plan=j.rows.find(r=>['owner-send-plan','reply-send-plan'].includes(r.type)&&r.scope===s&&r.token===token);if(!plan||plan.peerId!==p.peerId)throw Error('Send plan mismatch');const multipart=plan.parts?.length>1||!!plan.media;const binding=multipart?j.rows.find(r=>r.type==='send-plan-binding'&&r.scope===s&&r.token===token):null;if(multipart?(!binding||!Number.isInteger(p.partIndex)||plan.parts[p.partIndex]!==digest||p.logicalId!==JSON.stringify([binding.queueId,p.partIndex])):plan.digest!==digest)throw Error('Send plan mismatch');if(plan.type==='owner-send-plan'&&!a.ownerIds.includes(plan.requesterId))throw Error('Owner send authority revoked');if(plan.type==='reply-send-plan'&&!conversationAllowed(a,p.peerId))throw Error('Reply target no longer allowed');if(!multipart&&j.rows.some(r=>r.type==='send-authorization'&&r.scope===s&&r.token===token))throw Error('Owner send plan already used');ownerId=plan.type==='owner-send-plan'?plan.requesterId:null;}
 else{const origin=origins.getStore();const exactOrigin=origin?.accountId===a.accountId&&origin?.daemonAccountId===a.daemonAccountId&&origin?.peerId===p.peerId&&conversationAllowed(a,p.peerId);const ownerOrigin=origin?.accountId===a.accountId&&origin?.daemonAccountId===a.daemonAccountId&&a.ownerIds.includes(origin.senderId);const legacy=a.legacyPolicy&&p.peerId===a.verifiedPeer;if(ownerOrigin)ownerId=origin.senderId;else if(!exactOrigin&&!legacy)throw Error('send denied: owner authority or exact inbound reply required');}
 if(p.peerId===a.selfId||(!ownerId&&isRoom(p.peerId)&&!conversationAllowed(a,p.peerId)))throw Error('Send denied');
 j.append({type:'send-authorization',scope:s,logicalId:p.logicalId,peerId:p.peerId,digest,token:token??null,ownerId});return mint(a,p.peerId,p.text,p.logicalId);
}
export function resolveOwnerPlan(a,j,token){const plan=j.rows.find(r=>['owner-send-plan','reply-send-plan'].includes(r.type)&&r.scope===scope(a)&&r.token===token);if(!plan)throw Error('Unknown owner send plan');return plan;}

// Bind the complete immutable chunk plan before the first platform send. No message text is journaled.
export function bindMultipartPlan(a,j,token,queueId,text){
 const plan=resolveOwnerPlan(a,j,token),parts=textParts(text),s=scope(a);
 if(plan.digest!==textDigest(text)||JSON.stringify(plan.parts)!==JSON.stringify(parts.map(textDigest)))throw Error('Send plan mismatch');
 const prior=j.rows.find(r=>r.type==='send-plan-binding'&&r.scope===s&&r.token===token);
 if(prior&&prior.queueId!==queueId)throw Error('Owner send plan already used');
 if(!prior)j.append({type:'send-plan-binding',scope:s,token,queueId});
 for(let partIndex=0;partIndex<parts.length;partIndex++)bindSendAuthority(a,j,{peerId:plan.peerId,text:parts[partIndex],logicalId:JSON.stringify([queueId,partIndex]),partIndex},token);
 return parts;
}

// Media payloads always bind the plan to one host queue entry; text parts come first, then media parts.
export function bindMediaPlan(a,j,token,queueId,payload){
 const plan=resolveOwnerPlan(a,j,token),s=scope(a),text=planText(payload),urls=payloadMediaUrls(payload),parts=text?textParts(text):[];
 if(!plan.media||plan.digest!==textDigest(text)||JSON.stringify(plan.parts)!==JSON.stringify(parts.map(textDigest))||plan.media.count!==urls.length||plan.media.voice!==(payload.audioAsVoice===true))throw Error('Send plan mismatch');
 const prior=j.rows.find(r=>r.type==='send-plan-binding'&&r.scope===s&&r.token===token);
 if(prior&&prior.queueId!==queueId)throw Error('Owner send plan already used');
 if(!prior)j.append({type:'send-plan-binding',scope:s,token,queueId});
 for(let partIndex=0;partIndex<parts.length;partIndex++)bindSendAuthority(a,j,{peerId:plan.peerId,text:parts[partIndex],logicalId:JSON.stringify([queueId,partIndex]),partIndex},token);
 return {plan,parts,urls};
}
/**
 * Authorize one physical media part (digest "media:<sha256>"). With a plan token: the plan's peer, binding and media
 * slot; without: the same request-local owner/exact-reply origin rule as text. Prior authorization must match exactly.
 */
export function bindMediaAuthority(a,j,p,token){
 const s=scope(a),digest='media:'+p.sha256,prior=j.rows.find(r=>r.type==='send-authorization'&&r.scope===s&&r.logicalId===p.logicalId);
 if(isRoom(p.peerId)&&!conversationAllowed(a,p.peerId))throw Error('Group target no longer allowed');
 if(prior){if(prior.peerId!==p.peerId||prior.digest!==digest||prior.token!==(token??null))throw Error('Send authorization payload conflict');if(prior.ownerId&&!a.ownerIds.includes(prior.ownerId))throw Error('Owner send authority revoked');if(!prior.ownerId&&!conversationAllowed(a,p.peerId))throw Error('Reply target no longer allowed');return;}
 let ownerId=null;
 if(token){const plan=j.rows.find(r=>['owner-send-plan','reply-send-plan'].includes(r.type)&&r.scope===s&&r.token===token);const binding=j.rows.find(r=>r.type==='send-plan-binding'&&r.scope===s&&r.token===token);
  const first=plan?.parts?.length??0;
  if(!plan?.media||plan.peerId!==p.peerId||!binding||!Number.isInteger(p.partIndex)||p.partIndex<first||p.partIndex>=first+plan.media.count||p.logicalId!==JSON.stringify([binding.queueId,p.partIndex]))throw Error('Send plan mismatch');
  if(plan.type==='owner-send-plan'&&!a.ownerIds.includes(plan.requesterId))throw Error('Owner send authority revoked');
  if(plan.type==='reply-send-plan'&&!conversationAllowed(a,p.peerId))throw Error('Reply target no longer allowed');
  ownerId=plan.type==='owner-send-plan'?plan.requesterId:null;}
 else{const origin=origins.getStore();const exactOrigin=origin?.accountId===a.accountId&&origin?.daemonAccountId===a.daemonAccountId&&origin?.peerId===p.peerId&&conversationAllowed(a,p.peerId);const ownerOrigin=origin?.accountId===a.accountId&&origin?.daemonAccountId===a.daemonAccountId&&a.ownerIds.includes(origin.senderId);const legacy=a.legacyPolicy&&p.peerId===a.verifiedPeer;if(ownerOrigin)ownerId=origin.senderId;else if(!exactOrigin&&!legacy)throw Error('send denied: owner authority or exact inbound reply required');}
 if(p.peerId===a.selfId||(!ownerId&&isRoom(p.peerId)&&!conversationAllowed(a,p.peerId)))throw Error('Send denied');
 j.append({type:'send-authorization',scope:s,logicalId:p.logicalId,peerId:p.peerId,digest,token:token??null,ownerId});
}
