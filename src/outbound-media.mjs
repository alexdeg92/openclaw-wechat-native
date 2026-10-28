// Outbound media for one host durable part: immutable plan -> owned source copy -> staged multipart upload (once)
// -> final POST /sends (once) -> GET-only settlement by idempotency key. Never re-POSTs an uncertain send.
// All daemon access goes through the injected client; bytes come from the host-authorized media loader.
import {openSync,writeSync,fsyncSync,closeSync,readFileSync,renameSync,mkdirSync,rmSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {exactId,DEFAULT_MEDIA_MAX_MB} from './policy.mjs';

const MiB=1024*1024;
// Per-kind byte caps applied to the loaded bytes before anything is staged.
// image/voice 25 MiB - 17 B: daemon source limit (CORE/media_types.rs); larger is rejected after upload anyway.
// video 50 MiB: daemon source limit for video (FFmpeg/FFprobe preparation bound).
// file 64 MiB: daemon allows 512 MiB, but the host loads the whole buffer in memory and keeps an owned copy until
//   the send settles; beyond this a link is the better reply. The account mediaMaxMb cap (default 50 MiB) also applies
//   before loading/uploading; the host spool receives the same setting through schema defaults.
export const CAPS={image:25*MiB-17,voice:25*MiB-17,video:50*MiB,file:64*MiB};
// Account cap and daemon per-kind caps both apply, including the SDK loader's maximum buffer size.
export function accountMediaCaps(account,caps=CAPS){
 const mb=account.mediaMaxMb??DEFAULT_MEDIA_MAX_MB;if(typeof mb!=='number'||!Number.isFinite(mb)||mb<=0||mb>64)throw new MediaSendError('invalid_cap');
 return Object.fromEntries(Object.entries(caps).map(([kind,limit])=>[kind,Math.min(limit,Math.floor(mb*MiB))]));
}
// Poll every 1 s for at most 120 s: CDN upload + native submit; video preparation can take tens of seconds.
// Still pending at the deadline -> "uncertain"; the host queue reconciles later with GET only.
export const POLL={intervalMs:1000,deadlineMs:120_000};
const PENDING=new Set(['queued','running','submitting']);
const FAILED=new Set(['failed','cancelled','expired','unsupported']);
// Image types WeChat renders inline; anything else image-like (SVG, TIFF, HEIC) goes as a file.
const INLINE_IMAGE=/^image\/(jpeg|png|gif|webp|bmp)$/;

export class MediaSendError extends Error{constructor(code,detail={}){super('media send '+code);this.name='MediaSendError';this.code=code;Object.assign(this,detail);}}
const sha256=b=>createHash('sha256').update(b).digest('hex');
const base=t=>typeof t==='string'?t.split(';')[0].trim().toLowerCase():'';

/** Native kind from verified MIME and explicit host hints. Voice only on explicit request; audio otherwise is a file. */
export function chooseKind(contentType,{voice=false,forceDocument=false}={}){
 const t=base(contentType);
 if(voice&&/^audio\//.test(t))return 'voice';
 if(forceDocument)return 'file';
 if(INLINE_IMAGE.test(t))return 'image';
 if(/^video\//.test(t))return 'video';
 return 'file';
}
export function safeUploadName(n,kind,contentType){
 const s=typeof n==='string'?n.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f"]/g,'').trim().slice(0,120):'';
 if(s&&s!=='.'&&s!=='..')return s;
 const ext={'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','video/mp4':'.mp4','audio/mpeg':'.mp3','audio/wav':'.wav','audio/ogg':'.ogg','application/pdf':'.pdf'}[base(contentType)]??'';
 return kind+ext;
}
/** Deterministic daemon idempotency key for one physical media part. */
export const mediaKey=(scope,peerId,logicalId)=>createHash('sha256').update(JSON.stringify([scope,peerId,logicalId,'media'])).digest('hex');

/** All media URLs of a payload in host order (mediaUrl first, then distinct mediaUrls). */
export function payloadMediaUrls(p){const list=(Array.isArray(p?.mediaUrls)?p.mediaUrls:[]).filter(u=>typeof u==='string'&&u.trim()).map(u=>u.trim());const one=typeof p?.mediaUrl==='string'?p.mediaUrl.trim():'';return one&&!list.includes(one)?[one,...list]:list;}

function ownedDir(journalDir){const d=journalDir+'/outbound-media';mkdirSync(d,{recursive:true,mode:0o700});return d;}
function writeOwned(journalDir,key,bytes){const d=ownedDir(journalDir),tmp=`${d}/${key}.${randomUUID()}.part`,final=`${d}/${key}.bin`;
 const fd=openSync(tmp,'wx',0o600);try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,final);const dfd=openSync(d,'r');try{fsyncSync(dfd);}finally{closeSync(dfd);}return final;}
function readOwned(plan){let b;try{b=readFileSync(plan.file);}catch{throw new MediaSendError('owned_copy_missing');}if(sha256(b)!==plan.sha256||b.length!==plan.size)throw new MediaSendError('owned_copy_mismatch');return b;}
export function releaseOwned(plan){try{rmSync(plan.file,{force:true});}catch{}}

const rows=(j,scope,type,key)=>j.rows.filter(r=>r.type===type&&r.scope===scope&&r.key===key);
export const findPlan=(j,scope,key)=>rows(j,scope,'media-plan',key)[0];

/**
 * Load, verify and persist the immutable plan for one media part. Runs before any part of the payload is sent, so a
 * load/cap/authority failure sends nothing. A prior plan for the same key wins; changed bytes are a payload conflict.
 * @param {any} o
 */
export async function planMediaPart({j,scope,account,peerId,logicalId,mediaUrl,voice,forceDocument,load,loadOptions,authorize,journalDir,caps=CAPS,token=null}){
 const key=mediaKey(scope,peerId,logicalId),prior=findPlan(j,scope,key);
 if(prior){if(prior.size>caps[prior.kind])throw new MediaSendError('oversize',{kind:prior.kind});if(prior.peerId!==peerId||prior.logicalId!==logicalId||prior.voice!==!!voice)throw new MediaSendError('plan_conflict');authorize(prior);return prior;}
 let media;try{media=await load(mediaUrl,{...loadOptions,maxBytes:Math.max(...Object.values(caps))});}catch(err){throw new MediaSendError(/exceeds|too large|limit/i.test(String(err?.message))?'oversize':'load_failed');}
 const bytes=Buffer.isBuffer(media?.buffer)?media.buffer:media?.buffer instanceof Uint8Array?Buffer.from(media.buffer):null;
 if(!bytes?.length)throw new MediaSendError('load_failed');
 const declared=base(media.contentType),contentType=/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared)?declared:'application/octet-stream',kind=chooseKind(contentType,{voice,forceDocument});
 if(bytes.length>caps[kind])throw new MediaSendError('oversize',{kind});
 const plan={type:'media-plan',scope,key,account,peerId,logicalId,token,kind,voice:!!voice,sha256:sha256(bytes),size:bytes.length,contentType,fileName:safeUploadName(media.fileName,kind,contentType)};
 authorize(plan);
 plan.file=writeOwned(journalDir,key,bytes);j.append(plan);return plan;
}

function checkUpload(u,plan){if(!u||!exactId(u.id)||u.byteLength!==plan.size||(typeof u.sha256==='string'&&u.sha256.toLowerCase()!==plan.sha256))throw new MediaSendError('upload_mismatch');return u.id;}

/**
 * Judge one daemon media job against the immutable plan. Job ID alone is never a platform receipt.
 * @returns {{state:'sent'|'pending'|'failed'|'unresolved'|'mismatch'|'unknown',ids:string[],kind?:string}}
 */
export function judgeJob(job,plan,sourceId){
 if(!job||typeof job!=='object'||!exactId(job.id))return {state:'unknown',ids:[]};
 if(job.accountId!==plan.account||job.threadId!==plan.peerId||job.sourceId!==sourceId||(job.kind!=null&&job.kind!=='send'))return {state:'mismatch',ids:[]};
 const chunks=Array.isArray(job.result?.chunks)?[...job.result.chunks].sort((x,y)=>x.index-y.index):[];
 const acceptedChunks=chunks.filter(c=>c?.state==='accepted'&&exactId(c.serverMessageId)).map(c=>c.serverMessageId);
 if(PENDING.has(job.state))return {state:'pending',ids:acceptedChunks};
 if(job.state==='accepted'){
  if(plan.kind==='voice'){const whole=chunks.length>0&&chunks.every((c,i)=>c?.index===i&&c.state==='accepted'&&exactId(c.serverMessageId));return whole?{state:'sent',ids:acceptedChunks,kind:'voice'}:{state:'unresolved',ids:acceptedChunks};}
  const r=job.result?.nativeReceipt;
  if(r?.status==='server_accepted'&&exactId(r.serverMessageId)&&r.clientIdMatches!==false&&(job.serverMessageId==null||job.serverMessageId===r.serverMessageId))return {state:'sent',ids:[r.serverMessageId],kind:'media'};
  return {state:'unresolved',ids:[]};
 }
 if(FAILED.has(job.state))return {state:'failed',ids:acceptedChunks};
 return {state:'unresolved',ids:acceptedChunks}; // needs_review and anything unknown
}

const sleepFor=(ms,signal)=>new Promise((res,rej)=>{if(signal?.aborted)return rej(new MediaSendError('aborted'));const t=setTimeout(()=>{signal?.removeEventListener?.('abort',on);res();},ms);const on=()=>{clearTimeout(t);rej(new MediaSendError('aborted'));};signal?.addEventListener?.('abort',on,{once:true});});

/** GET-only lookup of the job for a planned key, journaling each observation. */
async function lookup(j,client,plan,sourceId){let job;try{job=await client.findSend(plan.account,plan.key);}catch{return {state:'unknown',ids:[]};}
 const v=judgeJob(job,plan,sourceId);observe(j,plan,job,v);return v;}
// Journal an observation only when the verdict or evidence changes (polling must not grow the journal per second).
function observe(j,plan,job,v){const row={type:'media-send-observation',scope:plan.scope,key:plan.key,jobId:job?.id??null,state:job?.state??null,verdict:v.state,ids:v.ids};
 const last=rows(j,plan.scope,'media-send-observation',plan.key).at(-1);if(last&&JSON.stringify({...last,type:0})===JSON.stringify({...row,type:0}))return;j.append(row);}
// A 4xx answer to the final POST is the daemon refusing that request (bad body, missing scope, too large): no job
// exists to wait for. 408/425/429 are not definitive. The intent row stays, so recovery remains GET-only.
const definitiveRefusal=status=>Number.isInteger(status)&&status>=400&&status<500&&![408,425,429].includes(status);

/**
 * Deliver one planned media part. Upload at most once per plan (journaled source ID), POST at most once per plan
 * (journaled intent before I/O), then settle with GET only. Returns platform IDs; throws MediaSendError otherwise,
 * carrying any accepted voice chunk IDs in `.ids` so the caller can report them before failing.
 * @param {any} o
 */
export async function deliverMediaPart({j,client,plan,beforeSend,signal,sleep=sleepFor,now=Date.now,poll=POLL}){
 const s=plan.scope,key=plan.key,intent=rows(j,s,'media-send-intent',key)[0];let sourceId=intent?.sourceId;
 if(!intent){
  sourceId=rows(j,s,'media-upload',key)[0]?.sourceId;
  if(!sourceId){const bytes=readOwned(plan);if(signal?.aborted)throw new MediaSendError('aborted');
   let u;try{u=await client.upload(plan.account,{bytes,fileName:plan.fileName,contentType:plan.contentType});}catch{throw new MediaSendError('upload_failed');}
   sourceId=checkUpload(u,plan);j.append({type:'media-upload',scope:s,key,sourceId});}
  await beforeSend?.();if(signal?.aborted)throw new MediaSendError('aborted');
  const body={threadId:plan.peerId,kind:plan.kind,sourceId,...(plan.kind==='video'?{videoQuality:'normal'}:{})};
  j.append({type:'media-send-intent',scope:s,key,sourceId});
  let job;try{job=await client.postSend(plan.account,body,key);}catch(err){if(definitiveRefusal(err?.status)){observe(j,plan,null,{state:'refused',ids:[]});throw new MediaSendError('refused',{status:err.status,ids:[]});}job=undefined;/* lost response: GET-only from here */}
  if(job!==undefined){const v=judgeJob(job,plan,sourceId);observe(j,plan,job,v);
   if(v.state==='sent')return v;if(v.state==='mismatch')throw new MediaSendError('uncertain',{ids:[]});}
 }
 const deadline=now()+poll.deadlineMs;let v={state:'unknown',ids:[]};
 for(;;){v=await lookup(j,client,plan,sourceId);
  if(v.state==='sent')return v;
  if(v.state==='failed')throw new MediaSendError('failed',{ids:v.ids});
  if(v.state==='mismatch'||v.state==='unresolved'||now()>=deadline)throw new MediaSendError('uncertain',{ids:v.ids});
  await sleep(poll.intervalMs,signal);}
}

/** Recovery verdict for one planned part, GET only. No plan or no intent means this part was never POSTed. */
export async function reconcileMediaPart({j,client,scope,peerId,logicalId}){
 const key=mediaKey(scope,peerId,logicalId),plan=findPlan(j,scope,key);if(!plan)return {state:'unplanned',ids:[]};
 const intent=rows(j,scope,'media-send-intent',key)[0];if(!intent)return {state:'unsent',ids:[],plan};
 const v=await lookup(j,client,plan,intent.sourceId);return {...v,plan};
}

/** RFC 7578 body with exactly one `file` part; built by hand so the bytes and boundary are deterministic per call. */
export function multipartBody({bytes,fileName,contentType}){const boundary='----wechat-native-'+randomUUID().replace(/-/g,'');
 const head=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
 return {boundary,body:Buffer.concat([head,bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])};}

export function mediaReceipt(parts){const all=parts.map((p,index)=>({platformMessageId:p.id,kind:p.kind,index}));return {primaryPlatformMessageId:all[0]?.platformMessageId,platformMessageIds:all.map(p=>p.platformMessageId),parts:all,sentAt:Date.now()};}
