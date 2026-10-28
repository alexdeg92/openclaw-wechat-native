// Real installed host: the owner's message-tool media send to a named third party goes through the owner plan,
// one staged upload and one media POST; a non-owner (even forging owner params) gets nothing sent. No network.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';
import {startHarness,CHANNEL} from './e2e-harness.mjs';
import {resolveCommandAuthorization} from 'openclaw/plugin-sdk/command-auth';
const owner='wxid_owner',peer='wxid_peer',other='wxid_other';
const {n:runMessageAction}=await import((process.env.OPENCLAW_DIST??new URL('../node_modules/openclaw/dist/',import.meta.url).pathname)+'message-action-runner-A_0LQ76A.mjs');
const results=[],rejections=[];
const h=await startHarness({account:{allowFrom:[owner,peer],verifiedPeer:owner,ownerIds:[owner],dmPolicy:'allowlist',groupPolicy:'disabled',groups:{}},config:{commands:{ownerAllowFrom:[CHANNEL+':'+owner]},tools:{message:{crossContext:{allowWithinProvider:true}}}},contacts:[{id:other,username:other,displayName:'Synthetic Person'},{id:owner,username:owner,displayName:'Synthetic Owner'},{id:peer,username:peer,displayName:'Synthetic Peer'}],onReply:async({ctx,cfg,scope})=>{
 if(!/media request$/.test(ctx.RawBody))return;
 const dir=h.state+'/media/outbound';mkdirSync(dir,{recursive:true});const file=dir+'/note.pdf';writeFileSync(file,'%PDF-1.4\n% synthetic\n%%EOF\n');
 const auth=resolveCommandAuthorization({ctx,cfg,commandAuthorized:true});
 const request={cfg,action:'send',params:{channel:CHANNEL,target:'Synthetic Person',accountId:'local',message:'',media:file},agentId:'main',sessionKey:ctx.SessionKey,requesterAccountId:'local',requesterSenderId:ctx.SenderId,senderIsOwner:auth.senderIsOwner,toolContext:{currentChannelProvider:CHANNEL,currentChannelId:ctx.NativeChannelId,currentMessagingTarget:ctx.To,currentMessageId:ctx.MessageSid,currentAccountId:'local'}};
 if(ctx.RawBody==='owner media request')results.push(await scope(()=>runMessageAction(request)));
 else rejections.push(await scope(()=>runMessageAction({...request,params:{...request.params,senderIsOwner:true,requesterSenderId:owner}})).then(()=>null,e=>e));
}});
test.after(()=>h.close());

test('owner message-tool media send to a named contact: one upload, one media POST to that contact (real host)',async()=>{
 const r=await h.inbound({threadId:owner,senderId:owner,body:'owner media request'});
 assert.equal(r.dispatched,true);assert.equal(results.length,1);
 const sends=h.mediaSends.filter(s=>s.b.threadId===other);assert.equal(sends.length,1);assert.equal(sends[0].b.kind,'file');assert.equal(h.uploads.length,1);
});

test('non-owner cannot send media to a third party even when forging owner params (real host)',async()=>{
 const u=h.uploads.length,m=h.mediaSends.length;await h.inbound({threadId:peer,senderId:peer,body:'nonowner media request'});
 assert.equal(rejections.length,1);assert.match(String(rejections[0]?.message),/owner/i);assert.equal(h.uploads.length,u);assert.equal(h.mediaSends.length,m);
});
