import test from 'node:test';import assert from 'node:assert/strict';
import {startHarness,finalCounts} from './e2e-harness.mjs';
const h=await startHarness();
test.after(()=>h.close());

test('agent final reaches plugin sendText through the real host durable path and settles accepted',async()=>{
 const r=await h.inbound();
 assert.equal(r.dispatched,true);assert.equal(r.recorded,true);
 assert.deepEqual(h.posts,['pong M1'],'agent final must reach the daemon via plugin sendText');
 assert.deepEqual(finalCounts(r),{delivered:1,deliveredNotVisible:0,cancelled:0,failedBeforeSend:0,failedAfterSend:0});
 assert.deepEqual(h.diag().filter(e=>e.event==='deliver.error'),[]);
 assert.equal(h.calls.filter(c=>c==='GET /sends/by-idempotency-key').length,1);
 assert.deepEqual(h.diag().filter(e=>e.event==='sendText.receipt').map(e=>e.accepted),[1]);
 const s=h.session(h.sessionKey);
 assert.equal(s.pendingFinalDelivery,undefined,'host clears custody once delivered');
 assert.equal(s.pendingDeliveryNotice,undefined,'no "couldn\'t confirm" notice owed');
});

test('an older unknown pendingFinalDelivery neither blocks nor duplicates the fresh reply',async()=>{
 // Live shape: prior intent left unknown with an owed "couldn't confirm" notice.
 const old=crypto.randomUUID(),createdAt=Date.now()-60000,context={channel:'wechat-native-isolated',to:'PeerX',accountId:'local'};
 await h.patchSession(h.sessionKey,e=>({pendingFinalDelivery:{kind:'replayable',text:'stale reply',intentId:old,deliveries:[{id:crypto.randomUUID(),state:'unknown'}],context,createdAt},pendingDeliveryNotice:{createdAt,context,intentId:old,state:'owed'},updatedAt:Date.now()}));
 const before=h.posts.length;
 const r=await h.inbound();
 assert.deepEqual(finalCounts(r),{delivered:1,deliveredNotVisible:0,cancelled:0,failedBeforeSend:0,failedAfterSend:0});
 const sent=h.posts.slice(before);
 assert.deepEqual(sent.filter(t=>t==='pong M2'),['pong M2'],'fresh reply sent exactly once');
 assert.ok(!h.posts.includes('stale reply'),'uncertain old send is never replayed');
 const s=h.session(h.sessionKey);
 assert.equal(s.pendingFinalDelivery,undefined,'fresh intent replaced the old one and completed');
 assert.equal(s.pendingDeliveryNotice?.intentId,old,'only the genuinely uncertain old intent may still owe a notice');
});
