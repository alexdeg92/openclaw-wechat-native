// Inbound media retrieval for one admitted direct message: discover -> (start transfer once) -> bounded poll ->
// verified fetch -> host-managed storage. Downloads only; never sends. All daemon access goes through the injected client.
import {openSync,writeSync,fsyncSync,closeSync,readFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {opaque} from './core.mjs';
import {stickerGrid} from './sticker-grid.mjs';

const MiB=1024*1024;
// Per-kind byte caps (applied to declared length, Content-Length, streamed bytes and host storage).
// image 20 MiB: WeChat originals are usually <10 MiB and vision providers reject much larger inputs.
// sticker 5 MiB: stickers are small GIF/PNG/WebP; equals the host's default media writer cap.
// voice 10 MiB: WeChat voice is <=60 s; daemon "normal" WAV is ~2 MiB/min, so 10 MiB is ample headroom.
// video 50 MiB: daemon source limit for video (MAX_VIDEO_SOURCE_BYTES); larger is not a WeChat video.
// file 50 MiB: daemon allows 512 MiB files, but the agent cannot use huge files and they would sit in host
//   media storage; above the cap the model gets an explicit "too large" note instead.
export const CAPS={image:20*MiB,sticker:5*MiB,voice:10*MiB,video:50*MiB,file:50*MiB};
// Poll every 1 s for at most 120 s (daemon itself polls at 500 ms). A message whose download is still running at
// the deadline is dispatched with an explicit "timed out" note rather than blocking the serialized consumer.
export const POLL={intervalMs:1000,deadlineMs:120_000};

// Variant preference per message media kind: [daemon kind, variant]. Video thumbnails are images, never the video.
const PREFER={image:[['image','original'],['image','standard'],['image','best'],['image','thumbnail']],
 sticker:[['sticker','original'],['sticker','best']],voice:[['voice','normal'],['voice','encoded']],
 video:[['video','normal'],['video','original'],['video','best']],file:[['file','original'],['file','best']]};
const TERMINAL=new Set(['failed','cancelled','expired','unsupported','needs_review']);
const FAMILY={image:/^image\//,sticker:/^image\//,voice:/^audio\//,video:/^video\//,file:/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/};
// Errors that make the next variant worth trying (bytes/metadata problem of this asset only).
const NEXT_VARIANT=new Set(['failed','expired','unsupported','cancelled','hash_mismatch','size_mismatch','mime_mismatch','hash_missing','bad_bytes','oversize']);

export class MediaError extends Error{constructor(code){super('media '+code);this.code=code;}}
const abortError=()=>Object.assign(Error('media aborted'),{name:'AbortError'});

/** Append-only retention of transfer job IDs so a restart polls the same job instead of starting another. */
export class MediaJobs{
 constructor(dir){mkdirSync(dir,{recursive:true,mode:0o700});this.path=dir+'/media-jobs.jsonl';this.rows=[];
  try{const lines=readFileSync(this.path,'utf8').split('\n');
   // A torn final line only loses a job ID; recovery then uses asset.jobId or starts one more download.
   for(const l of lines){if(!l)continue;try{this.rows.push(JSON.parse(l));}catch{}}}catch(e){if(e.code!=='ENOENT')throw e;}
  this.fd=openSync(this.path,'a',0o600);}
 append(r){writeSync(this.fd,JSON.stringify(r)+'\n');fsyncSync(this.fd);this.rows.push(r);}
 jobFor(scope,assetId){return this.rows.findLast(r=>r.type==='transfer'&&r.scope===scope&&r.assetId===assetId)?.jobId;}
 close(){closeSync(this.fd);}
}

const base=t=>typeof t==='string'?t.split(';')[0].trim().toLowerCase():'';
export function safeFileName(n){if(typeof n!=='string')return undefined;const s=n.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,120);return s&&s!=='.'&&s!=='..'?s:undefined;}
function sniffImage(b){const h=b.subarray(0,12),s=h.toString('latin1');
 return h[0]===0xff&&h[1]===0xd8&&h[2]===0xff||s.startsWith('\x89PNG')||s.startsWith('GIF8')||s.startsWith('RIFF')&&s.slice(8,12)==='WEBP'||s.startsWith('BM')||s.slice(4,8)==='ftyp';}

/** Read a response body with a hard byte cap; cancels the stream when exceeded. */
async function readCapped(res,cap,signal){const parts=[];let n=0;const body=res.body;if(!body)throw new MediaError('bad_bytes');
 for await(const chunk of body){if(signal?.aborted){await body.cancel?.().catch(()=>{});throw abortError();}const c=Buffer.from(chunk);n+=c.length;if(n>cap){await body.cancel?.().catch(()=>{});throw new MediaError('oversize');}parts.push(c);}
 return Buffer.concat(parts);}

export async function fetchVerified({client,account,asset,mediaKind,cap,signal}){
 if(asset.byteLength!=null&&asset.byteLength>cap)throw new MediaError('oversize');
 const res=await client.mediaContent(account,asset.id);
 if(res.status!==undefined&&res.status!==200)throw new MediaError('bad_status');
 const declared=base(asset.contentType),header=base(res.headers?.get?.('content-type'));
 if(declared&&header&&declared!==header)throw new MediaError('mime_mismatch');
 const type=declared||header;if(!type||!FAMILY[mediaKind].test(type))throw new MediaError('mime_mismatch');
 const len=Number(res.headers?.get?.('content-length'));if(Number.isFinite(len)&&len>cap)throw new MediaError('oversize');
 const buf=await readCapped(res,cap,signal);
 if(!buf.length)throw new MediaError('bad_bytes');
 if(asset.byteLength!=null&&buf.length!==asset.byteLength||Number.isFinite(len)&&buf.length!==len)throw new MediaError('size_mismatch');
 const sha=createHash('sha256').update(buf).digest('hex');
 const expected=typeof asset.sha256==='string'?asset.sha256.toLowerCase():'';
 const etag=(res.headers?.get?.('etag')??'').replace(/^W\//,'').replace(/"/g,'').toLowerCase();
 if(!expected&&!etag)throw new MediaError('hash_missing');
 if(expected&&sha!==expected||etag&&sha!==etag)throw new MediaError('hash_mismatch');
 if(/^image\//.test(type)&&!sniffImage(buf))throw new MediaError('bad_bytes');
 return {buffer:buf,contentType:type,sha256:sha};
}

function checkAsset(a,{account,messageId}){return a&&typeof a.id==='string'&&a.accountId===account&&(a.messageId==null||a.messageId===messageId)&&(()=>{try{opaque(a.id);return true}catch{return false}})();}
function checkJob(j,{account,assetId,jobId}){if(!j||typeof j.id!=='string'||j.accountId!==account||j.kind!=='download'||(jobId&&j.id!==jobId)||(j.assetId!=null&&j.assetId!==assetId))throw new MediaError('job_mismatch');opaque(j.id);return j;}

/** Wait until the asset is available, starting at most one transfer job per asset (retained across restarts). */
async function settleAsset(asset,{client,account,messageId,jobs,scope,signal,sleep,now,poll,stats}){
 if(asset.state==='available')return asset;
 let jobId=jobs.jobFor(scope,asset.id)??(typeof asset.jobId==='string'&&asset.jobId?asset.jobId:undefined);
 if(TERMINAL.has(asset.state)&&!(asset.state==='failed'&&jobId))throw new MediaError(asset.state);
 if(jobId&&!jobs.jobFor(scope,asset.id))jobs.append({type:'transfer',scope,messageId,assetId:asset.id,jobId});
 if(!jobId){if(signal?.aborted)throw abortError();
  const job=checkJob(await client.startMediaTransfer(account,messageId,{messageId,assetId:asset.id,quality:asset.variant??'best'}),{account,assetId:asset.id});
  jobId=job.id;jobs.append({type:'transfer',scope,messageId,assetId:asset.id,jobId});stats.started++;}
 const deadline=now()+poll.deadlineMs;
 for(;;){if(signal?.aborted)throw abortError();
  const job=checkJob(await client.job(account,jobId),{account,assetId:asset.id,jobId});stats.polls++;
  if(job.state==='available'){const fresh=await client.mediaAsset(account,asset.id);if(!checkAsset(fresh,{account,messageId})||fresh.id!==asset.id)throw new MediaError('asset_mismatch');if(fresh.state!=='available')throw new MediaError('not_available');return fresh;}
  if(job.state==='failed'&&job.retryable===true&&!jobs.rows.some(r=>r.type==='retry'&&r.scope===scope&&r.jobId===jobId)){
   if(now()>=deadline)throw new MediaError('timeout');if(signal?.aborted)throw abortError();
   // Persist before POST: an uncertain response/restart must only poll this same job, never retry twice.
   jobs.append({type:'retry',scope,assetId:asset.id,jobId});
   try{checkJob(await client.retryJob(account,jobId),{account,assetId:asset.id,jobId});}
   catch(error){if(signal?.aborted||error?.name==='AbortError')throw abortError();if(error instanceof MediaError)throw error;}
   // An uncertain retry response is followed by GET only; its persisted allowance is already spent.
   continue;
  }
  if(TERMINAL.has(job.state))throw new MediaError(job.state);
  if(now()>=deadline)throw new MediaError('timeout');
  await sleep(poll.intervalMs,signal);}
}

const defaultSleep=(ms,signal)=>new Promise((res,rej)=>{if(signal?.aborted)return rej(abortError());const t=setTimeout(()=>{signal?.removeEventListener?.('abort',onAbort);res();},ms);const onAbort=()=>{clearTimeout(t);rej(abortError());};signal?.addEventListener?.('abort',onAbort,{once:true});});

/**
 * Retrieve and store the media of one decoded direct-media event.
 * @returns {Promise<{stored?:{path:string,size:number,contentType:string,fileName?:string,daemonKind:string,variant?:string,grid?:{frames:number,shown:number}},error?:string,stats:object}>}
 * Throws only on abort (caller must not take custody or ACK); every other failure is returned as an error code.
 */
export async function retrieveMedia(e,{client,account,jobs,save,signal,sleep=defaultSleep,now=Date.now,poll=POLL,caps=CAPS,grid=stickerGrid}){
 const stats={assets:0,started:0,polls:0,tried:0};const ctx={client,account,messageId:e.messageId,jobs,scope:JSON.stringify([account,e.peerId]),signal,sleep,now,poll,stats};
 const cap=caps[e.mediaKind];
 let items;try{items=(await client.mediaAssets(account,e.messageId))?.items;}catch(err){if(signal?.aborted)throw abortError();return {error:'discovery_failed',stats};}
 const assets=Array.isArray(items)?items.filter(a=>checkAsset(a,ctx)):[];stats.assets=assets.length;
 const order=[];for(const [kind,variant] of PREFER[e.mediaKind])for(const a of assets)if(a.kind===kind&&a.variant===variant&&!order.includes(a))order.push(a);
 if(!order.length)return {error:assets.length?'unsupported':'unavailable',stats};
 let error='unavailable';
 for(const asset of order){stats.tried++;
  try{const ready=await settleAsset(asset,ctx);
   const got=await fetchVerified({client,account,asset:ready,mediaKind:e.mediaKind,cap,signal});
   let fileName=safeFileName(ready.filename);
   // Animated sticker: store a frame grid instead (verified bytes in, PNG out); null keeps the original.
   const g=e.mediaKind==='sticker'?await grid(got.buffer,got.contentType,Number.isInteger(ready.animationFrames)?{frames:ready.animationFrames}:{}):null;
   if(g){got.buffer=g.buffer;got.contentType=g.contentType;fileName='sticker-frames.png';stats.gridFrames=g.frames;}
   const saved=await save(got.buffer,got.contentType,cap,fileName);
   return {stored:{path:saved.path,size:saved.size??got.buffer.length,contentType:saved.contentType??got.contentType,fileName,daemonKind:asset.kind,variant:ready.actualVariant??ready.variant,...(g?{grid:{frames:g.frames,shown:g.shown}}:{})},stats};
  }catch(err){if(err?.name==='AbortError'||signal?.aborted)throw abortError();
   error=err instanceof MediaError?err.code:'failed';if(!NEXT_VARIANT.has(error))break;}
 }
 return {error,stats};
}
