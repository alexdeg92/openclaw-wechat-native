// Outbound pacing: a short, length-scaled, jittered pause before each send (people don't answer in 50 ms) and a
// daily send cap as a runaway guard. Runs before any send intent is journaled, so a capped or aborted send is
// "failed before send" and never needs reconciliation. The count persists in journalDir/pacing.json (UTC days).
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export const PACING_DEFAULTS=Object.freeze({minDelayMs:1200,maxDelayMs:4000,perCharMs:20,dailyCap:400});
export class SendCapError extends Error{constructor(cap){super('daily send cap reached');this.name='SendCapError';this.code='daily_send_cap';this.cap=cap;}}

const day=t=>new Date(t).toISOString().slice(0,10);
const wait=(ms,signal)=>new Promise((res,rej)=>{if(signal?.aborted)return rej(Error('aborted'));const id=setTimeout(res,ms);signal?.addEventListener?.('abort',()=>{clearTimeout(id);rej(Error('aborted'));},{once:true});});

/** Delay before sending `chars` characters: min + perChar*chars, ±20% jitter, clamped to [min, max]. */
export function delayFor(chars,o=PACING_DEFAULTS,random=Math.random){
 const base=o.minDelayMs+o.perCharMs*Math.max(0,chars|0),jit=base*(random()*0.4-0.2);
 return Math.round(Math.min(o.maxDelayMs,Math.max(o.minDelayMs,base+jit)));
}

export function makePacer(dir,options={},{now=Date.now,sleep=wait,random=Math.random}={}){
 const o={...PACING_DEFAULTS,...options},file=join(dir,'pacing.json');
 const load=()=>{try{const v=JSON.parse(readFileSync(file,'utf8'));return v&&typeof v.day==='string'&&Number.isInteger(v.count)?v:null;}catch{return null;}};
 let state=load();
 /** Call right before a new (not replayed) send. Throws SendCapError when today's cap is used up. */
 return async function pace(chars,signal){
  const today=day(now());if(!state||state.day!==today)state={day:today,count:0};
  if(o.dailyCap>0&&state.count>=o.dailyCap)throw new SendCapError(o.dailyCap);
  const ms=o.maxDelayMs>0?delayFor(chars,o,random):0;if(ms>0)await sleep(ms,signal);
  state={day:today,count:state.count+1};
  try{const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(state)+'\n',{mode:0o600});renameSync(tmp,file);}catch{}
  return ms;
 };
}
