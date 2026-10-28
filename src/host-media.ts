import type {PluginRuntime,OpenClawConfig} from 'openclaw/plugin-sdk/channel-core';
// Runtime JS module is an original implementation; checked independently by node tests.
import {isRoom} from './policy.mjs';
import {retrieveMedia,MediaJobs} from './inbound-media.mjs';
export {MediaJobs};
type MediaKind='image'|'audio'|'video'|'document';
type DaemonKind='image'|'sticker'|'voice'|'video'|'file';
// Host placeholder convention (<media:kind>); the host's own media understanding keys off canonical facts, not this text.
const PLACEHOLDER:Record<DaemonKind,string>={image:'<media:image>',sticker:'<media:sticker>',voice:'<media:audio>',video:'<media:video>',file:'<media:document>'};
const LABEL:Record<DaemonKind,string>={image:'image',sticker:'sticker',voice:'voice message',video:'video',file:'file'};
const MODALITY:Record<DaemonKind,string>={image:'image',sticker:'image',voice:'voice',video:'video',file:'document'};
const REASON:Record<string,string>={timeout:'download timed out',expired:'expired on WeChat',oversize:'too large',unsupported:'unsupported format',
 hash_mismatch:'failed integrity check',size_mismatch:'failed integrity check',mime_mismatch:'failed integrity check',hash_missing:'failed integrity check',bad_bytes:'failed integrity check'};

/** Host media kind from the verified MIME; a WeChat "file" that is a PDF stays a document. */
export function hostMediaKind(daemonKind:DaemonKind,contentType:string):MediaKind{
 if(daemonKind==='image'||daemonKind==='sticker')return 'image';
 if(daemonKind==='voice')return 'audio';
 if(daemonKind==='video')return 'video';
 if(/^image\//.test(contentType))return 'image';if(/^audio\//.test(contentType))return 'audio';if(/^video\//.test(contentType))return 'video';
 return 'document';
}
export function unavailableNote(kind:DaemonKind,code:string){return `[WeChat ${LABEL[kind]} not available: ${REASON[code]??'download failed'}]`;}
export const VOICE_NO_TRANSCRIPT='[WeChat voice message: transcription unavailable; audio attached]';

type Deps={runtime:PluginRuntime;cfg:OpenClawConfig;accountId:string;channel:string;client:any;daemonAccountId:string;jobs:MediaJobs;signal?:AbortSignal;
 diag?:(event:string,detail:Record<string,unknown>)=>void;retrieve?:typeof retrieveMedia;sleep?:any;now?:()=>number;poll?:any;caps?:any};

/** Voice -> transcript through the host runtime when audio understanding is enabled; never used for activation. */
async function transcribe(deps:Deps,path:string,contentType:string,size:number,peerId:string):Promise<string|undefined>{
 const mu:any=(deps.runtime as any).mediaUnderstanding;if(typeof mu?.transcribeAudioFile!=='function')return;
 try{const budget=typeof mu.resolveAudioInputBudget==='function'?await mu.resolveAudioInputBudget({cfg:deps.cfg}):{enabled:true};
  if(!budget?.enabled||budget.maxBytes!=null&&size>budget.maxBytes)return;
  const route=deps.runtime.channel.routing.resolveAgentRoute({cfg:deps.cfg,channel:deps.channel,accountId:deps.accountId,peer:{kind:isRoom(peerId)?'group':'direct',id:peerId},dmScope:'per-account-channel-peer'});
  const r=await mu.transcribeAudioFile({filePath:path,cfg:deps.cfg,agentId:route.agentId,mime:contentType,scopeContext:{sessionKey:route.sessionKey,channel:deps.channel,chatType:isRoom(peerId)?'group':'direct'}});
  const text=typeof r?.text==='string'?r.text.trim():'';return text||undefined;
 }catch{return;}
}

/**
 * Turns a decoded media event into the ordinary direct/group text custody envelope with a non-empty body,
 * plus canonical host media facts. Runs BEFORE custody (no intent journaled), so a crash or abort mid-download
 * leaves nothing dispatched and nothing ACKed; the retained job ID resumes the same download on replay.
 */
export async function prepareMediaEvent(e:any,deps:Deps){
 const kind=e.mediaKind as DaemonKind;
 const save=(buffer:Buffer,contentType:string,cap:number,fileName?:string)=>deps.runtime.channel.media.saveMediaBuffer(buffer,contentType,'inbound',cap,fileName);
 const r=await (deps.retrieve??retrieveMedia)(e,{client:deps.client,account:deps.daemonAccountId,jobs:deps.jobs,save,signal:deps.signal,
  ...(deps.sleep?{sleep:deps.sleep}:{}),...(deps.now?{now:deps.now}:{}),...(deps.poll?{poll:deps.poll}:{}),...(deps.caps?{caps:deps.caps}:{})});
 const lines:string[]=[];if(typeof e.text==='string'&&e.text)lines.push(e.text);
 const media:any[]=[];let transcribed=false;
 if(r.stored){const s=r.stored;const fact:any={path:s.path,contentType:s.contentType,kind:hostMediaKind(kind,s.contentType),sizeBytes:s.size,messageId:e.messageId,...(s.fileName?{fileName:s.fileName}:{})};
  lines.push(PLACEHOLDER[kind]);
  if(s.grid)lines.push(`[WeChat animated sticker: ${s.grid.frames} frames; image shows ${s.grid.shown} of them in order, left-to-right then top-to-bottom]`);
  if(kind==='voice'){const t=await transcribe(deps,s.path,s.contentType,s.size,e.peerId);
   if(t){transcribed=true;fact.transcribed=true;lines.push('[WeChat voice message transcript]',t);}else lines.push(VOICE_NO_TRANSCRIPT);}
  media.push(fact);}
 else if(!e.optional)lines.push(unavailableNote(kind,r.error??'failed'));
 deps.diag?.('media.prepare',{kind,stored:!!r.stored,error:r.error??null,...r.stats,transcribed});
 const {mediaKind:_k,optional:_o,...rest}=e;
 return {...rest,kind:isRoom(e.peerId)?'group-text':'direct-text',text:lines.join('\n'),media,...(e.optional?{}:{sourceModality:MODALITY[kind]})};
}
