// Owner access commands through the real installed host (fake daemon, no network).
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {startHarness,CHANNEL} from './e2e-harness.mjs';
const owner='wxid_owner',newbie='wxid_new',other='wxid_other',room='room@chatroom',room2='quiet@chatroom';
const mention=(...ids)=>({state:'known',self:true,userIds:['Self',...ids],all:null,source:'msgsource.atuserlist'});
const h=await startHarness({account:{allowFrom:[owner],verifiedPeer:owner,ownerIds:[owner],dmPolicy:'allowlist',groupPolicy:'allowlist',groups:{[room]:{requireMention:true}}},config:{commands:{ownerAllowFrom:[CHANNEL+':'+owner]}},
 contacts:[{id:owner,username:owner,displayName:'Synthetic Owner'},{id:newbie,username:newbie,displayName:'Synthetic Newbie'}],
 groups:[{id:room,roomId:room,displayName:'Synthetic Room'},{id:room2,roomId:room2,displayName:'Quiet Room'}],members:[{id:newbie,username:newbie,roomDisplayName:'Newbie In Room'}]});
test.after(()=>h.close());
const access=()=>{try{return JSON.parse(readFileSync(h.state+'/journal/access.json','utf8'));}catch{return null;}};
const turnFor=id=>h.turns.find(t=>(t.MessageSidFull??t.MessageSid)===id);
test('a private message from someone not yet allowed is ignored',async()=>{const turns=h.turns.length;
 await h.inbound({threadId:newbie,senderId:newbie,body:'hello?'});assert.equal(h.turns.length,turns);});
test('a non-owner cannot allow anyone; the message is dispatched as ordinary chat',async()=>{const id='M'+h.next;
 await h.inbound({threadId:room,senderId:other,body:'@Timmy allow @Newbie ',mentions:mention(newbie)});
 assert.match(turnFor(id).RawBody??turnFor(id).Body,/allow/);assert.doesNotMatch(turnFor(id).Body,/access control/);assert.equal(access(),null);});
test('owner "@Timmy allow @Newbie" in a group adds the exact mentioned ID and Timmy confirms',async()=>{const id='M'+h.next;
 const r=await h.inbound({threadId:room,senderId:owner,body:'@Timmy allow @Newbie In Room ',mentions:mention(newbie)});
 assert.equal(r.dispatched,true);assert.match(turnFor(id).Body,/access control.*Newbie In Room can now message you privately/s);
 assert.deepEqual(access().allowFrom,[newbie]);assert.equal(h.sendBodies.at(-1).threadId,room);});
test('the newly allowed person now gets a private reply without any restart',async()=>{const sends=h.sendBodies.length;
 const r=await h.inbound({threadId:newbie,senderId:newbie,body:'hi again'});assert.equal(r.dispatched,true);
 assert.equal(h.sendBodies.length,sends+1);assert.equal(h.sendBodies.at(-1).threadId,newbie);});
test('owner enables a group that was off by typing in it; replies go to that group',async()=>{const id='M'+h.next;
 const r=await h.inbound({threadId:room2,senderId:owner,body:'@Timmy enable this group',mentions:mention()});
 assert.equal(r.dispatched,true);assert.match(turnFor(id).Body,/active in the group "Quiet Room"/);
 assert.deepEqual(access().groups,[room2]);assert.equal(h.sendBodies.at(-1).threadId,room2);
 const other2=await h.inbound({threadId:room2,senderId:newbie,body:'@Timmy yo',mentions:mention()});assert.equal(other2.dispatched,true);});
test('non-owner "enable this group" in a group that is off is ignored',async()=>{const turns=h.turns.length;
 await h.inbound({threadId:'third@chatroom',senderId:newbie,body:'@Timmy enable this group',mentions:mention()});
 assert.equal(h.turns.length,turns);assert.ok(!access().groups.includes('third@chatroom'));});
test('owner disables a group: the confirmation is delivered first, then the group is ignored',async()=>{const sends=h.sendBodies.length;
 await h.inbound({threadId:room2,senderId:owner,body:'@Timmy disable this group',mentions:mention()});
 assert.equal(h.sendBodies.length,sends+1);assert.equal(h.sendBodies.at(-1).threadId,room2);assert.deepEqual(access().disabledGroups,[room2]);
 const turns=h.turns.length;await h.inbound({threadId:room2,senderId:newbie,body:'@Timmy still there?',mentions:mention()});assert.equal(h.turns.length,turns);});
test('owner removes a person: later private messages are ignored again',async()=>{
 await h.inbound({threadId:room,senderId:owner,body:'@Timmy remove @Newbie In Room ',mentions:mention(newbie)});
 assert.deepEqual(access().blockFrom,[newbie]);const turns=h.turns.length;await h.inbound({threadId:newbie,senderId:newbie,body:'hello?'});assert.equal(h.turns.length,turns);});
test('access survives a restart of the account consumer',async()=>{await h.restart();
 const turns=h.turns.length;await h.inbound({threadId:newbie,senderId:newbie,body:'after restart'});assert.equal(h.turns.length,turns);
 const r=await h.inbound({threadId:room,senderId:owner,body:'@Timmy allow @Newbie In Room ',mentions:mention(newbie)});assert.equal(r.dispatched,true);
 const r2=await h.inbound({threadId:newbie,senderId:newbie,body:'back'});assert.equal(r2.dispatched,true);});
test('a group quote-reply to one of Timmy\'s messages counts as a mention; quoting someone else does not',async()=>{
 const base={threadId:room,senderId:newbie,type:49,appMessageType:57,mentions:{state:'known',self:false,userIds:[],all:null,source:'msgsource.atuserlist'}};
 const id='M'+h.next,sends=h.sendBodies.length;
 await h.inbound({...base,body:'好久不见 哈哈',quote:{serverId:'1',type:1,state:'embedded',senderId:'Self',direction:'outgoing',embeddedText:'Hey everyone'}});
 const t=turnFor(id);assert.ok(t,'quote-reply to Timmy must start a turn');assert.equal(t.WasMentioned,true);
 assert.equal(h.sendBodies.length,sends+1);assert.equal(h.sendBodies.at(-1).threadId,room);
 const turns=h.turns.length;await h.inbound({...base,body:'lol',quote:{serverId:'2',type:1,state:'embedded',senderId:owner,direction:'incoming',embeddedText:'x'}});
 assert.equal(h.turns.length,turns);});
test('owner quote-replying "allow" to Timmy is ordinary chat, not a command',async()=>{const id='M'+h.next,before=JSON.stringify(access());
 await h.inbound({threadId:room,senderId:owner,type:49,appMessageType:57,body:'allow',mentions:{state:'known',self:false,userIds:[newbie],all:null,source:'msgsource.atuserlist'},quote:{serverId:'9',type:1,state:'embedded',senderId:'Self',direction:'outgoing',embeddedText:'x'}});
 assert.ok(turnFor(id));assert.doesNotMatch(turnFor(id).Body,/access control/);assert.equal(JSON.stringify(access()),before);});
test('a change journaled with custody but not applied before a crash is applied at startup',async()=>{
 const {appendFileSync}=await import('node:fs');const scope=JSON.stringify(['local','daemon']),key=JSON.stringify([scope,room,'Mcrash']);
 assert.ok(!(access().disabledGroups??[]).includes(room));
 appendFileSync(h.state+'/journal/custody.jsonl',JSON.stringify({type:'access-op',scope,key,op:'disable',ids:[room]})+'\n'+JSON.stringify({type:'custody',scope,key})+'\n');
 await h.restart();await h.waitFor(()=>(access().disabledGroups??[]).includes(room));assert.ok(access().disabledGroups.includes(room));
 const done=readFileSync(h.state+'/journal/custody.jsonl','utf8').split('\n').filter(l=>l.includes('"access-done"')&&l.includes('Mcrash')).length;assert.equal(done,1);});
