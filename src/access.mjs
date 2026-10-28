// Owner-managed access overlay: people and groups the owner allows (or blocks) from WeChat itself, without editing
// openclaw.json or restarting the gateway. Stored beside the journal as access.json; merged over the base account
// config on every resolve. The overlay can never add or remove owners, and never touches the bot's own ID.
import {readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,statSync,chmodSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {exactId,isRoom} from './policy.mjs';

export const ACCESS_FILE='access.json';
const EMPTY=Object.freeze({allowFrom:[],blockFrom:[],groups:[],disabledGroups:[]});
const cache=new Map();

function clean(v){
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('invalid access file');
 const out={};
 for(const key of Object.keys(EMPTY)){const list=v[key]??[];
  if(!Array.isArray(list)||list.some(id=>!exactId(id)))throw Error('invalid access '+key);
  const rooms=key==='groups'||key==='disabledGroups';if(list.some(id=>isRoom(id)!==rooms))throw Error('invalid access '+key);
  out[key]=[...new Set(list)];}
 return out;
}

/** Current overlay; missing file = empty. A corrupt/unreadable file keeps the last good value (empty if none) and
 * marks the overlay invalid so changeAccess refuses to overwrite it (blocks are never silently lost). */
function load(dir){
 const path=join(dir,ACCESS_FILE);let st;
 try{st=statSync(path);}catch(e){if(e.code==='ENOENT'){cache.set(path,{sig:'none',value:EMPTY,valid:true});return {value:EMPTY,valid:true};}const last=cache.get(path);return {value:last?.value??EMPTY,valid:false};}
 const sig=[st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':'),hit=cache.get(path);if(hit&&hit.sig===sig)return hit;
 try{const value=clean(JSON.parse(readFileSync(path,'utf8')));const r={sig,value,valid:true};cache.set(path,r);return r;}
 catch{return {value:hit?.value??EMPTY,valid:false};}
}
export function readAccess(dir){return load(dir).value;}

/** Atomic replace: unique temp + fsync + rename + directory fsync. */
export function writeAccess(dir,value){
 const v=clean(value),path=join(dir,ACCESS_FILE),tmp=`${path}.${randomUUID()}.tmp`;
 try{writeFileSync(tmp,JSON.stringify(v,null,1)+'\n',{mode:0o600,flag:'wx'});chmodSync(tmp,0o600);const fd=openSync(tmp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,path);}catch(e){rmSync(tmp,{force:true});throw e;}
 const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}
 cache.delete(path);return v;
}

/** Merge the overlay into a resolved account in place: (base ∪ allowed) − blocked; owners are never blocked. */
export function mergeAccess(a,o){
 if(!a.baseAllowFrom)Object.defineProperty(a,'baseAllowFrom',{value:[...a.allowFrom],enumerable:false});
 if(!a.baseGroups)Object.defineProperty(a,'baseGroups',{value:{...a.groups},enumerable:false});
 const owners=new Set(a.ownerIds??[]);
 a.allowFrom=[...new Set([...a.baseAllowFrom,...o.allowFrom])].filter(id=>id!==a.selfId&&(owners.has(id)||!o.blockFrom.includes(id)));
 const groups={...a.baseGroups};for(const room of o.groups)groups[room]??={requireMention:true};
 for(const room of o.disabledGroups)delete groups[room];
 a.groups=groups;return a;
}

/** Apply one change to the stored overlay. Returns {changed, overlay}. */
export function changeAccess(dir,op,ids){
 const cur=load(dir);if(!cur.valid)throw Error('access file unreadable; refusing to overwrite');const o=structuredClone(cur.value);let changed=false;
 const add=(list,id)=>{if(!o[list].includes(id)){o[list].push(id);changed=true;}};
 const drop=(list,id)=>{const i=o[list].indexOf(id);if(i>=0){o[list].splice(i,1);changed=true;}};
 for(const id of ids){
  if(op==='allow'){drop('blockFrom',id);add('allowFrom',id);}
  else if(op==='remove'){drop('allowFrom',id);add('blockFrom',id);}
  else if(op==='enable'){drop('disabledGroups',id);add('groups',id);}
  else if(op==='disable'){drop('groups',id);add('disabledGroups',id);}
  else throw Error('unknown access op');}
 return {changed,overlay:changed?writeAccess(dir,o):o};
}

// WeChat puts U+2005 after each @Name it inserts; names may contain spaces, so strip up to that marker first.
export function stripMentions(text){
 return String(text).replace(/@[^@ ]{1,64} /g,' ').replace(/@\S+/g,' ').replace(/\s+/g,' ').trim();
}

/**
 * Owner command words, matched against the whole message (mentions removed), case-insensitive, so ordinary chat
 * ("allow me to explain…") never triggers. An optional leading "<bot name>," / "please" and trailing punctuation are ignored.
 */
export function parseAccessCommand(text){
 const t=stripMentions(text).toLowerCase().replace(/^([\p{L}\p{N}_-]{1,32}[,:]\s*|(please|pls)\s+)/u,'').replace(/^(please|pls)\s+/,'').replace(/[.!?\s]+$/,'');
 if(/^(allow|add|approve)$/.test(t))return {op:'allow'};
 if(/^(remove|unallow|disallow|block|revoke)$/.test(t))return {op:'remove'};
 if(/^(enable|turn on|activate)( this)? (group|chat)$/.test(t))return {op:'enable'};
 if(/^(disable|turn off|deactivate)( this)? (group|chat)$/.test(t))return {op:'disable'};
 if(LIST.test(t))return {op:'list'};
 // The list is read-only, so it is matched more loosely: per line (merged messages), ignoring emoji, "I mean"-style
 // lead-ins and the common "how's" typo.
 for(const line of String(text).split('\n')){
  const l=stripMentions(line).toLowerCase().replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu,'').replace(/[’`]/g,"'")
   .replace(/^((i mean|so|ok|okay|hey|please|pls|and|now)[,:\s]+|[\p{L}\p{N}_-]{1,32}[,:]\s*)+/u,'').replace(/[.!?\s]+$/,'').trim();
  if(LIST.test(l)||/^how'?s allowed$/.test(l))return {op:'list'};}
 return null;
}
const LIST=/^(allow ?list|allowed list|access list|who'?s allowed|who is allowed)$/;

export const NAMES_FILE='names.json';
/** Owner-written real names shown next to WeChat names in the access list: {"<user id>":"Real Name"}.
 * Display only, never used for access. Missing or invalid file = no names. */
export function readNames(dir){
 try{const v=JSON.parse(readFileSync(join(dir,NAMES_FILE),'utf8'));if(!v||typeof v!=='object'||Array.isArray(v))return {};
  return Object.fromEntries(Object.entries(v).filter(([id,n])=>exactId(id)&&!isRoom(id)&&typeof n==='string'&&n.trim()&&n.length<=64).map(([id,n])=>[id,n.trim()]));}
 catch{return {};}
}
