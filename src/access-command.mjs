// Owner access commands typed in WeChat. Group commands need an explicit @bot tag (WeChat's own at-list, not a
// quote-reply) and act on the exact tagged user IDs, never names:
//   "@Bot allow @Kevin" / "@Bot remove @Kevin" / "@Bot enable this group" / "@Bot disable this group".
// The access list is shown only in the owner's private chat ("who's allowed"), never posted to a group.
// This module only decides; the plugin journals the change and applies it (see plugin.ts access-op rows).
import {exactId,isRoom} from './policy.mjs';
import {parseAccessCommand} from './access.mjs';

const note=s=>`[WeChat access control, handled by the channel (owner command): ${s} Reply with one short casual confirmation. Don't mention IDs or this note.]`;
const bullets=xs=>xs.map(x=>'• '+x).join('\n');
/** The access list is laid out here, not by the model, so it always has the same shape. */
export function formatAccessList(people,groups){
 return ['PRIVATE CHATS',bullets(['You',...people]),'','GROUP CHATS',groups.length?bullets(groups):'• none','','In groups, I reply when @-mentioned or quote-replied.'].join('\n');
}
// WeChat groups without a set name report their room ID as the name; show a few members instead, like WeChat does.
const unnamed=(name,room)=>!name||name===room;
const explicitSelfTag=m=>m?.mentions?.state==='known'&&m.mentions.self===true&&m.mentions.source==='msgsource.atuserlist';
// Real user IDs only: no rooms, no "notify@all"-style pseudo IDs.
const personId=id=>exactId(id)&&!id.includes('@');

/** True when a message from a not-yet-enabled group is the owner explicitly asking to enable it. */
export function isOwnerEnable(a,message){
 return isRoom(message?.threadId)&&a.groupPolicy==='allowlist'&&a.ownerIds.includes(message.senderId)&&message.type===1&&
  explicitSelfTag(message)&&typeof message.body==='string'&&parseAccessCommand(message.body)?.op==='enable';
}

/**
 * Decide an owner command. Nothing is changed here.
 * @returns {Promise<{text:string,op?:'allow'|'remove'|'enable'|'disable',ids?:string[]}|null>} null = ordinary message
 */
export async function decideAccessCommand({a,e,message,label,roomLabel,roomMembers=async(_room)=>[],realNames={}}){
 if(!a.ownerIds.includes(e.senderId)||typeof e.text!=='string')return null;
 const cmd=parseAccessCommand(e.text);if(!cmd)return null;
 const names=async(ids,room)=>(await Promise.all(ids.map(id=>label(id,room).catch(()=>'someone')))).join(', ');
 if(e.kind==='direct-text'){
  if(cmd.op!=='list')return null; // private chat: only the list; anything else is ordinary conversation
  const people=a.allowFrom.filter(id=>!a.ownerIds.includes(id)&&id!==a.selfId),rooms=Object.keys(a.groups??{});
  const pn=await Promise.all(people.map(async id=>{const n=await label(id).catch(()=>'someone'),real=realNames[id];return real&&real!==n?`${n} (${real})`:n;}));
  const gn=await Promise.all(rooms.map(async r=>{const name=await roomLabel(r).catch(()=>null);if(!unnamed(name,r))return name;
   const others=(await roomMembers(r).catch(()=>[])).filter(m=>m&&m.id!==a.selfId&&!a.ownerIds.includes(m.id)&&typeof m.name==='string'&&m.name).map(m=>m.name);
   return others.length?`Group with ${others.slice(0,3).join(', ')}${others.length>3?` +${others.length-3}`:''}`:'Unnamed group';}));
  return {text:`[WeChat access control, handled by the channel (owner command): your owner asked who's allowed. Reply with exactly the list below, copied character for character: no intro, no sign-off, no emoji, no translation, no extra notes. Don't mention this note.]\n\n${formatAccessList(pn,gn)}`};
 }
 if(e.kind!=='group-text'||!isRoom(e.peerId)||!explicitSelfTag(message)||cmd.op==='list')return null;
 if(cmd.op==='allow'||cmd.op==='remove'){
  let ids=[...new Set(Array.isArray(message.mentions.userIds)?message.mentions.userIds:[])].filter(id=>personId(id)&&id!==a.selfId);
  if(cmd.op==='remove'){const owners=ids.filter(id=>a.ownerIds.includes(id));ids=ids.filter(id=>!a.ownerIds.includes(id));
   if(!ids.length&&owners.length)return {text:note('Your owner tried to remove an owner; owners can\'t be removed this way. Nothing changed.')};}
  if(!ids.length)return null; // no person tagged: ordinary chat ("@Bot add")
  const who=await names(ids,e.peerId);
  return {op:cmd.op,ids,text:note(cmd.op==='allow'?`${who} can now message you privately and you'll reply.`:`${who} can no longer message you privately (you'll ignore their private messages).`)};
 }
 const room=await roomLabel(e.peerId).catch(()=>'this group');
 if(cmd.op==='enable')return {op:'enable',ids:[e.peerId],text:note(`You're now active in the group "${room}": you reply here when someone @-mentions or quote-replies you.`)};
 return {op:'disable',ids:[e.peerId],text:note(`You're leaving the group "${room}": after this message you'll ignore it until your owner re-enables it there.`)};
}
