import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';
import {startHarness,finalCounts} from './e2e-harness.mjs';
const h=await startHarness();
test.after(()=>h.close());
const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xff,0xd9]);
const {u:projectMediaFacts}=await import((process.env.OPENCLAW_DIST??new URL('../node_modules/openclaw/dist/',import.meta.url).pathname)+'media-facts-CYny4oQ-.mjs');
const count=(re)=>h.calls.filter(c=>re.test(c)).length;

test('image message produces one model turn whose context carries the stored media path (real host)',async()=>{
 const n=h.next;h.mediaMessage(n,{type:3,assets:[{id:'A'+n+'o',kind:'image',variant:'original',contentType:'image/jpeg',bytes:JPEG},{id:'A'+n+'t',kind:'image',variant:'thumbnail',contentType:'image/jpeg',bytes:JPEG}]});
 const r=await h.inbound();
 assert.deepEqual(finalCounts(r),{delivered:1,deliveredNotVisible:0,cancelled:0,failedBeforeSend:0,failedAfterSend:0});
 const ctx=h.turns.at(-1);
 assert.equal(ctx.MessageSid,'M'+n);
 // Finalized ctx carries canonical media facts (host strips deprecated MediaPath* keys and projects them on demand).
 assert.equal(ctx.media.length,1);const f=ctx.media[0];
 assert.equal(f.kind,'image');assert.equal(f.contentType,'image/jpeg');assert.equal(f.messageId,'M'+n);assert.equal(f.sizeBytes,JPEG.length);
 assert.ok(existsSync(f.path),'host-managed file exists');assert.ok(f.path.startsWith(h.state+'/media/inbound/'),'stored by host media store');
 assert.deepEqual(readFileSync(f.path),JPEG);
 const legacy=projectMediaFacts(ctx.media);
 assert.equal(legacy.MediaPath,f.path);assert.deepEqual(legacy.MediaPaths,[f.path]);assert.equal(legacy.MediaType,'image/jpeg');
 assert.match(ctx.Body??ctx.RawBody,/<media:image>/);assert.doesNotMatch(JSON.stringify(ctx),/<msg|<img|cdnurl/i);
 assert.equal(count(/media-transfers/),0,'available asset needs no transfer');
 assert.equal(count(/A\d+t\/content/),0,'thumbnail not fetched when original verifies');
 // diag hygiene: counts/classes only
 const d=h.diag().filter(e=>e.event==='media.prepare').at(-1);assert.deepEqual(Object.keys(d).sort(),['assets','at','error','event','instance','kind','polls','started','stored','transcribed','tried'].sort());
});

test('restart while a download is pending: no early ACK, no turn, same job resumed, exactly one turn after',async()=>{
 const n=h.next,asset='A'+n;
 const pending={id:'J'+n,accountId:'daemon',kind:'download',state:'queued',phase:'queued',assetId:asset,attempts:0,cancelRequested:false,retryable:false,reason:null,completedBytes:0,totalBytes:null,result:null};
 h.mediaMessage(n,{type:3,assets:[{id:asset,kind:'image',variant:'original',state:'pending',contentType:'image/jpeg',bytes:JPEG,script:[{id:'J'+n,states:[pending]}]}]});
 const acks=h.acks(),turns=h.turns.length;
 h.push();
 assert.ok(await h.waitFor(()=>count(new RegExp(`GET /jobs/J${n}$`))>=1),'job polled');
 assert.equal(h.acks(),acks,'no ACK while pending');assert.equal(h.turns.length,turns,'no model turn while pending');
 await h.restart();
 // Download finishes while the consumer is down.
 h.jobs.get('J'+n).states=[{...pending,state:'available',phase:'completed',completedBytes:JPEG.length,totalBytes:JPEG.length}];
 assert.ok(await h.waitFor(()=>h.acks()>acks),'acked after completion');
 assert.equal(count(new RegExp(`POST /messages/M${n}/media-transfers`)),1,'transfer started exactly once across restart');
 assert.equal(h.turns.length,turns+1,'exactly one model turn');
 assert.ok(existsSync(h.turns.at(-1).media[0].path));
 // A further restart (cursor journaled after custody) must not dispatch again.
 await h.restart();await new Promise(r=>setTimeout(r,500));assert.equal(h.turns.length,turns+1);
});
