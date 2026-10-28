// Bounded collection ahead of one ordered custody/dispatch worker. No message content is persisted here.
import {inboundAllowed,isRoom} from './policy.mjs';
export const MAX_BURST_MEDIA=6;
export class InboundCoalescer{
 constructor({account,deliver,signal,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,onError=(/** @type {any} */ error)=>{},maxQueued=32}){
  Object.assign(this,{account,deliver,signal,now,setTimer,clearTimer,onError,maxQueued});
  this.pending=null;this.timer=null;this.queue=[];this.running=null;this.error=null;this.closed=false;this.waiters=[];
  this.onAbort=()=>{this.discard();this.wake();};signal?.addEventListener('abort',this.onAbort,{once:true});
 }
 wake(){for(const resolve of this.waiters.splice(0))resolve();}
 discard(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.pending=null;this.queue=[];}
 arm(ms){if(this.timer!==null)this.clearTimer(this.timer);if(this.pending)this.pending.expiresAt=this.now()+ms;this.timer=this.setTimer(()=>{this.timer=null;this.flush();},ms);}
 flush(){if(!this.pending)return;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
  this.queue.push(this.pending);this.pending=null;this.pump();
 }
 pump(){if(this.running||this.error||this.signal?.aborted)return;
  this.running=(async()=>{while(this.queue.length&&!this.signal?.aborted){const batch=this.queue.shift();this.wake();await this.deliver(batch);}})()
   .catch(error=>{this.error=error;this.discard();this.onError(error);})
   .finally(()=>{this.running=null;this.wake();if(this.queue.length&&!this.error&&!this.signal?.aborted)this.pump();});
 }
 async add(e,cursor){
  if(this.closed||this.signal?.aborted)return;if(this.error)throw this.error;
  if(this.pending&&this.now()>=this.pending.expiresAt)this.flush();
  // Recheck policy before grouping; even captions in a group must themselves pass the structured mention gate.
  if(e&&!inboundAllowed(this.account,{...e,kind:isRoom(e.peerId)?'group-text':'direct-text'}))e=null;
  const key=e?JSON.stringify([this.account.accountId,e.accountId,e.peerId,e.senderId]):null,media=e?.kind==='direct-media';
  if(this.pending&&(key!==this.pending.key||(!media&&this.pending.texts)||(media&&this.pending.media>=MAX_BURST_MEDIA)||this.pending.sources.some(s=>s.messageId===e?.messageId)))this.flush();
  while(this.queue.length>=this.maxQueued&&!this.error&&!this.signal?.aborted)await new Promise(resolve=>this.waiters.push(resolve));
  if(this.error)throw this.error;if(this.signal?.aborted)return;
  if(!e){this.queue.push({key:null,sources:[],cursor});this.pump();return;}
  if(!this.pending){this.pending={key,sources:[],cursor,texts:0,media:0};const ms=media?this.account.mediaCaptionWindowMs:this.account.textMediaWindowMs;
   if(ms>0)this.arm(ms);
  }
  const burst=this.pending;burst.sources.push(e);burst.cursor=cursor;if(media)burst.media++;else burst.texts++;
  // Text-first bursts switch to a fixed media window at their first attachment, allowing several images.
  if(media&&burst.media===1&&burst.sources.length>1&&this.account.mediaCaptionWindowMs>0)this.arm(this.account.mediaCaptionWindowMs);
  const window=burst.media?this.account.mediaCaptionWindowMs:this.account.textMediaWindowMs;
  if(window===0)this.flush();
 }
 async finish({flush=false}={}){
  this.closed=true;if(flush&&!this.signal?.aborted&&!this.error)this.flush();else this.discard();
  while(this.running)await this.running;
  this.signal?.removeEventListener('abort',this.onAbort);if(this.error)throw this.error;
 }
}
// Caption first, followed by the host's media placeholders/notes; each media fact retains its own source ID.
export function mergePrepared(sources,prepared){
 const captions=[],mediaText=[],media=[];let sourceModality;
 for(let i=0;i<prepared.length;i++){const e=prepared[i];if(sources[i].kind==='direct-media'){if(e.text)mediaText.push(e.text);sourceModality??=e.sourceModality;}else if(e.text)captions.push(e.text);media.push(...(e.media??[]));}
 return {...prepared[0],text:[...captions,...mediaText].join('\n'),...(media.length?{media}:{}),...(sourceModality?{sourceModality}:{})};
}
