// Decoder for non-text WeChat messages after exact conversation and mention gates. Text keeps the original decoder in daemon.mjs.
// Never forwards raw XML: only daemon-normalized bodies (text, link card, quote title) reach the prompt.
import {opaque} from './core.mjs';
import {decode,admitOrigin} from './daemon.mjs';
import {isRoom,inboundAllowed} from './policy.mjs';
// native type -> daemon MediaKind (CORE/media.rs discover); 49 needs appMessageType 6 for a file.
export const MEDIA_TYPES={3:'image',34:'voice',43:'video',47:'sticker'};
const FILE_APP=6,LINK_APPS=new Set([3,4,5]),QUOTE_APP=57;
// System/notice rows (recall notices, pats, joins) are not user requests: drop silently.
const SYSTEM_TYPES=new Set([10000,10002,9999]);
export const UNSUPPORTED_NOTE='[unsupported WeChat message type]';

/** @returns {any} null or event envelope; kind 'direct-text' or 'direct-media' (mediaKind set). */
/** @param {any} [policy] */
export function decodeInbound(event,message,account,policy=undefined,now=Date.now()){
 const text=decode(event,message,account,policy,now);if(text)return text;
 // Same scope gates as decode(); decode() returned null, so re-derive which case this is.
 opaque(event.cursor);if(event.kind!=='message.committed')return null;
 const d=event.data;if(!d||(d.origin!=='live'&&d.origin!=='catchup'))return null;
 opaque(d.messageId);opaque(d.threadId);
 if(message.id!==d.messageId||message.accountId!==account||message.threadId!==d.threadId)throw Error('daemon scope mismatch');
 if(!admitOrigin(d,message,now))return null;
 if(d.direction!=='incoming'||message.direction!=='incoming'||message.recall)return null;
 const group=isRoom(message.threadId),textKind=group?'group-text':'direct-text';
 if(group&&(!policy||!inboundAllowed(policy,{accountId:account,peerId:message.threadId,senderId:message.senderId,kind:'group-text',mentions:message.mentions,outgoing:false})))return null;
 if(!group&&policy&&!inboundAllowed(policy,{accountId:account,peerId:message.threadId,senderId:message.senderId,kind:textKind,outgoing:false}))return null;
 opaque(message.senderId);if(!group&&message.senderId!==message.threadId)throw Error('direct sender mismatch');
 const base={accountId:account,peerId:message.threadId,senderId:message.senderId,messageId:message.id,cursor:event.cursor,outgoing:false,...(group?{mentions:message.mentions}:{})};
 const type=message.type,app=message.appMessageType??null;
 if(SYSTEM_TYPES.has(type))return null; // notices
 // Text whose (schema-less) media array is non-empty: keep the text; media is discovered separately only for media types.
 if(type===1)return typeof message.body==='string'&&message.body.length?{...base,kind:textKind,text:message.body}:null;
 // Quoted reply embedding an image: text plus an optional image sidecar.
 if(type===49&&app===QUOTE_APP&&message.quote?.embeddedImage===true&&typeof message.body==='string'&&message.body.trim())return {...base,kind:'direct-media',mediaKind:'image',text:message.body,optional:true};
 if(MEDIA_TYPES[type])return {...base,kind:'direct-media',mediaKind:MEDIA_TYPES[type]};
 if(type===49&&app===FILE_APP)return {...base,kind:'direct-media',mediaKind:'file'};
 // Link cards and quoted replies: the daemon already normalized body to plain text.
 if(type===49&&(LINK_APPS.has(app)||app===QUOTE_APP)&&typeof message.body==='string'&&message.body.trim())return {...base,kind:textKind,text:message.body};
 return {...base,kind:textKind,text:UNSUPPORTED_NOTE};
}
