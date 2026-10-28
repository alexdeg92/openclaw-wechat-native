// Original account and admission policy. Names never participate in authorization.
// The daemon accepts video up to 50 MiB and images/voice near 25 MiB.
// Defaulting below this to the host's 5 MiB spool limit blocks ordinary photos and video.
export const DEFAULT_MEDIA_MAX_MB=50;
export const CHANNEL='wechat-native-isolated';
export function exactId(value){return typeof value==='string'&&value.length>0&&value.trim()===value&&!/[\s\x00-\x1f\x7f]/u.test(value)&&value!=='*';}
export const isRoom=id=>typeof id==='string'&&id.endsWith('@chatroom');
function ids(value,label){if(!Array.isArray(value)||value.some(id=>!exactId(id)||isRoom(id)))throw Error('invalid '+label+' IDs');return [...new Set(value)];}
export function resolveAccountConfig(cfg,id){
 const raw=cfg.channels?.[CHANNEL]?.accounts?.[id];if(!id||!raw)throw Error('explicit account required');
 const a={...raw,accountId:id};if(a.enabled!==true)throw Error('account disabled');
 for(const key of ['accountId','daemonAccountId','selfId','startAfter'])if(!exactId(a[key]))throw Error('invalid account scope');
 a.allowFrom=ids(a.allowFrom,'allowFrom');if(a.allowFrom.includes(a.selfId))throw Error('self peer denied');
 if(a.verifiedPeer!==undefined&&(!exactId(a.verifiedPeer)||isRoom(a.verifiedPeer)||!a.allowFrom.includes(a.verifiedPeer)))throw Error('verified peer gate mismatch');
 a.legacyPolicy=a.dmPolicy===undefined&&a.ownerIds===undefined&&a.groupPolicy===undefined&&a.groups===undefined&&a.allowFrom.length===1&&a.verifiedPeer===a.allowFrom[0];
 for(const [key,value] of Object.entries({mediaCaptionWindowMs:5000,textMediaWindowMs:1500})){a[key]=a[key]??value;if(!Number.isInteger(a[key])||a[key]<0||a[key]>60000)throw Error('invalid coalescing window');}
 a.mediaMaxMb=a.mediaMaxMb??DEFAULT_MEDIA_MAX_MB;if(typeof a.mediaMaxMb!=='number'||!Number.isFinite(a.mediaMaxMb)||a.mediaMaxMb<=0||a.mediaMaxMb>64)throw Error('invalid mediaMaxMb');
 a.dmPolicy=a.dmPolicy??'allowlist';if(!['allowlist','disabled'].includes(a.dmPolicy))throw Error('unsupported dmPolicy');
 a.ownerIds=ids(a.ownerIds??(a.legacyPolicy?[a.verifiedPeer]:[]),'ownerIds');if(a.ownerIds.includes(a.selfId)||a.ownerIds.some(id=>!a.allowFrom.includes(id)))throw Error('owner must be an allowed direct contact');
 a.groupPolicy=a.groupPolicy??'disabled';if(!['allowlist','disabled'].includes(a.groupPolicy))throw Error('unsupported groupPolicy');
 a.groups=a.groups??{};if(!a.groups||typeof a.groups!=='object'||Array.isArray(a.groups))throw Error('invalid groups');
 for(const [room,value] of Object.entries(a.groups)){if(!exactId(room)||!isRoom(room)||!value||typeof value!=='object'||Array.isArray(value)||value.requireMention===false||Object.keys(value).some(k=>k!=='requireMention'))throw Error('groups require exact rooms and strict mention');}
 return a;
}
export const groupAllowed=(a,id)=>a.groupPolicy==='allowlist'&&Object.hasOwn(a.groups??{},id);
export const directAllowed=(a,id)=>(a.dmPolicy??'allowlist')==='allowlist'&&a.allowFrom.includes(id)&&id!==a.selfId;
export function conversationAllowed(a,id){return isRoom(id)?groupAllowed(a,id):directAllowed(a,id);}
export function inboundAllowed(a,e){
 if(e.accountId!==a.daemonAccountId||e.outgoing||!exactId(e.senderId)||e.senderId===a.selfId||isRoom(e.senderId))return false;
 if(isRoom(e.peerId))return groupAllowed(a,e.peerId)&&e.kind==='group-text'&&e.mentions?.state==='known'&&e.mentions.self===true;
 return e.kind==='direct-text'&&e.senderId===e.peerId&&directAllowed(a,e.peerId);
}
export function ownerRequester(a,ctx){return ctx.requesterAccountId===a.accountId&&ctx.senderIsOwner===true&&a.ownerIds.includes(ctx.requesterSenderId);}
export const accountSchema={type:'object',additionalProperties:false,required:['enabled','daemonAccountId','selfId','allowFrom','startAfter','baseUrl','token','journalDir'],properties:{mediaMaxMb:{type:'number',exclusiveMinimum:0,maximum:64,default:DEFAULT_MEDIA_MAX_MB},mediaCaptionWindowMs:{type:'integer',minimum:0,maximum:60000,default:5000},textMediaWindowMs:{type:'integer',minimum:0,maximum:60000,default:1500},enabled:{const:true},daemonAccountId:{type:'string',minLength:1},selfId:{type:'string',minLength:1},allowFrom:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},verifiedPeer:{type:'string',minLength:1},ownerIds:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},dmPolicy:{enum:['allowlist','disabled']},groupPolicy:{enum:['allowlist','disabled']},groups:{type:'object',propertyNames:{pattern:'@chatroom$'},additionalProperties:{type:'object',additionalProperties:false,properties:{requireMention:{const:true}}}},startAfter:{type:'string',minLength:1},baseUrl:{type:'string',pattern:'^http://127[.]0[.]0[.]1:[0-9]+/$'},journalDir:{type:'string',minLength:1},token:{oneOf:[{type:'string',minLength:1},{type:'object',additionalProperties:false,required:['source','provider','id'],properties:{source:{const:'env'},provider:{const:'default'},id:{type:'string',pattern:'^WX_NATIVE_ISOLATED_[A-Z0-9_]+$'}}},{type:'object',additionalProperties:false,required:['source','provider','id'],properties:{source:{const:'file'},provider:{const:'wechat-native-isolated'},id:{const:'value'}}}]}}};
