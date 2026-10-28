// Real installed host, fake daemon, model stood in by the existing reply resolver. No network.
import test from 'node:test';import assert from 'node:assert/strict';
import {startHarness,finalCounts,CHANNEL} from './e2e-harness.mjs';
import {resolveCommandAuthorization} from 'openclaw/plugin-sdk/command-auth';
const owner='wxid_owner',peer='wxid_peer',other='wxid_other',room='room@chatroom';
const {n:runMessageAction}=await import((process.env.OPENCLAW_DIST??new URL('../node_modules/openclaw/dist/',import.meta.url).pathname)+'message-action-runner-A_0LQ76A.mjs');
const observed=[],toolResults=[];
const h=await startHarness({account:{allowFrom:[owner,peer],verifiedPeer:owner,ownerIds:[owner],dmPolicy:'allowlist',groupPolicy:'allowlist',groups:{[room]:{requireMention:true}}},config:{commands:{ownerAllowFrom:[CHANNEL+':'+owner]},tools:{message:{crossContext:{allowWithinProvider:true}}}},contacts:[{id:other,username:other,displayName:'Synthetic Person'},{id:owner,username:owner,displayName:'Synthetic Owner'},{id:peer,username:peer,displayName:'Synthetic Peer'}],groups:[{id:room,roomId:room,displayName:'Synthetic Room'}],members:[{id:other,username:other,roomDisplayName:'Synthetic Room Member'}],onReply:async({ctx,cfg,scope})=>{
 const auth=resolveCommandAuthorization({ctx,cfg,commandAuthorized:true});observed.push({senderId:ctx.SenderId,owner:auth.senderIsOwner,sessionKey:ctx.SessionKey});
 if(ctx.RawBody!=='owner contact request'&&ctx.RawBody!=='nonowner contact request')return;
 const request={cfg,action:'send',params:{channel:CHANNEL,target:'Synthetic Person',accountId:'local',message:'synthetic owner-requested hello'},agentId:'main',sessionKey:ctx.SessionKey,requesterAccountId:'local',requesterSenderId:ctx.SenderId,senderIsOwner:auth.senderIsOwner,toolContext:{currentChannelProvider:CHANNEL,currentChannelId:ctx.NativeChannelId,currentMessagingTarget:ctx.To,currentMessageId:ctx.MessageSid,currentAccountId:'local'}};
 if(ctx.RawBody==='owner contact request')toolResults.push(await scope(()=>runMessageAction(request)));
 else await assert.rejects(scope(()=>runMessageAction({...request,params:{...request.params,senderIsOwner:true,requesterSenderId:owner}})),/owner/i);
}});
test.after(()=>h.close());
test('real-host group @mention retains real member identity and replies to its room through durable sendText',async()=>{
 const result=await h.inbound({threadId:room,senderId:other,body:'synthetic @mention',mentions:{state:'known',self:true,userIds:['Self'],all:null,source:'msgsource.atuserlist'}});
 assert.equal(result.dispatched,true);assert.deepEqual(finalCounts(result),{delivered:1,deliveredNotVisible:0,cancelled:0,failedBeforeSend:0,failedAfterSend:0});
 const ctx=h.contexts.at(-1);assert.equal(ctx.ChatType,'group');assert.equal(ctx.ChatId,room);assert.equal(ctx.To,room);assert.equal(ctx.SenderId,other);assert.equal(ctx.SenderName,'Synthetic Room Member');assert.equal(ctx.GroupSubject,'Synthetic Room');assert.equal(ctx.WasMentioned,true);assert.equal(h.sendBodies.at(-1).threadId,room);assert.equal(observed.at(-1).owner,false);
});
test('real-host owner DM is recognized by supported owner config and message tool sends once to a uniquely named third party',async()=>{
 const before=h.sendBodies.length;const r=await h.inbound({threadId:owner,senderId:owner,body:'owner contact request'});
 assert.equal(r.dispatched,true);assert.equal(observed.at(-1).owner,true);assert.equal(toolResults.length,1);
 const sends=h.sendBodies.slice(before);assert.equal(sends.filter(b=>b.threadId===other).length,1);assert.ok(sends.some(b=>b.threadId===owner));assert.deepEqual(finalCounts(r),{delivered:1,deliveredNotVisible:0,cancelled:0,failedBeforeSend:0,failedAfterSend:0});
});
test('real-host nonowner cannot forge owner params; own DM reply still delivers in a separate session',async()=>{
 const ownerSession=observed.at(-1).sessionKey,before=h.sendBodies.length;const r=await h.inbound({threadId:peer,senderId:peer,body:'nonowner contact request'});
 assert.equal(observed.at(-1).owner,false);assert.notEqual(observed.at(-1).sessionKey,ownerSession);assert.equal(h.sendBodies.slice(before).filter(b=>b.threadId===other).length,0);assert.equal(h.sendBodies.at(-1).threadId,peer);assert.equal(finalCounts(r).delivered,1);
});
test('unmentioned group image is ACKed without media discovery, download, or dispatch',async()=>{const before=h.calls.length,turns=h.turns.length,n=h.next;h.mediaMessage(n,{type:3,threadId:room,senderId:other,mentions:{state:'known',self:false,userIds:[]}});const ack=h.acks();h.push();assert.ok(await h.waitFor(()=>h.acks()>ack));assert.equal(h.turns.length,turns);assert.ok(!h.calls.slice(before).some(c=>/\/media|\/jobs\//.test(c)));});
test('mentioned group image retains media facts and member identity through real host dispatch',async()=>{const n=h.next,ack=h.acks();const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,...Array(64).fill(0),0xff,0xd9]);h.mediaMessage(n,{type:3,threadId:room,senderId:other,mentions:{state:'known',self:true,userIds:['Self']},assets:[{id:'groupimage',kind:'image',variant:'original',bytes:jpeg,contentType:'image/jpeg'}]});h.push();assert.ok(await h.waitFor(()=>h.acks()>ack));const ctx=h.turns.at(-1);assert.equal(ctx.ChatType,'group');assert.equal(ctx.SenderId,other);assert.equal(ctx.To,room);assert.equal(ctx.SourceModality,'image');assert.equal(ctx.media[0].kind,'image');assert.ok(ctx.media[0].path);assert.equal(finalCounts(h.diag().filter(r=>r.event==='dispatch.result').at(-1)).delivered,1);});
