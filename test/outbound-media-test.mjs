// Outbound media unit tests: fake daemon client + injected host media loader. No network, no WeChat.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {Adapter,Journal} from '../src/core.mjs';import {contactsFeatures} from '../src/contacts.mjs';import {prepareReplyPayload,prepareOwnerPayload,withInboundOrigin} from '../src/authority.mjs';
import {chooseKind,judgeJob,multipartBody,CAPS} from '../src/outbound-media.mjs';import {daemonClient} from '../src/daemon.mjs';
globalThis.fetch=async()=>{throw Error('real network forbidden')};
const owner='wxid_owner',peer='wxid_peer',other='wxid_other';
const account=()=>({accountId:'local',daemonAccountId:'daemon',selfId:'Self',allowFrom:[owner,peer],ownerIds:[owner],dmPolicy:'allowlist',groupPolicy:'disabled',groups:{}});
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(64,7)]),PDF=Buffer.from('%PDF-1.4 synthetic'),MP4=Buffer.alloc(80,3),OGG=Buffer.from('OggS synthetic voice');
const FILES={'/m/a.png':[PNG,'image/png','a.png'],'/m/r.pdf':[PDF,'application/pdf','report.pdf'],'/m/v.mp4':[MP4,'video/mp4','v.mp4'],'/m/n.ogg':[OGG,'audio/ogg','n.ogg'],'/m/b.png':[Buffer.concat([PNG,Buffer.alloc(9)]),'image/png','b.png']};
const sha=b=>createHash('sha256').update(b).digest('hex');
const accepted=(job,b)=>b.kind==='voice'?{...job,state:'accepted',phase:'completed',result:{chunks:[{index:0,state:'accepted',durationMs:60000,serverMessageId:'V0'},{index:1,state:'accepted',durationMs:5000,serverMessageId:'V1'}]}}:{...job,state:'accepted',phase:'completed',serverMessageId:'N'+job.id,result:{nativeReceipt:{status:'server_accepted',serviceCode:0,serverMessageId:'N'+job.id,clientIdMatches:true}}};

function setup({ownerSend=false,payload={text:'',mediaUrl:'/m/a.png'},a=account()}={}){
 const dir=mkdtempSync(tmpdir()+'/outmedia-');let j=new Journal(dir);a.journalDir=dir;
 const event={peerId:peer,senderId:peer,messageId:'M1'};
 const p=ownerSend?prepareOwnerPayload(a,j,{requesterAccountId:'local',requesterSenderId:owner,senderIsOwner:true},other,payload):prepareReplyPayload(a,j,event,payload);
 const uploads=[],posts=[],gets=[],textPosts=[],loads=[],jobs=new Map();let n=0;
 // script(body,job) -> list of job states returned by successive GETs (last repeats); default: queued then accepted.
 const s={script:(b,job)=>[{...job,state:'running',phase:'submitting'},accepted(job,b)],postThrows:false,uploadThrows:false};
 const client={
  upload:async(ac,{bytes,fileName,contentType})=>{uploads.push({ac,size:bytes.length,fileName,contentType});if(s.uploadThrows)throw Error('lost');return {id:'U'+uploads.length,name:fileName,mediaType:contentType,byteLength:bytes.length,sha256:sha(bytes),createdAt:'t'};},
  postSend:async(ac,b,key)=>{if(b.text!==undefined){textPosts.push({b,key});const r={id:'T'+textPosts.length,accountId:ac,destination:b.threadId,state:'accepted'};jobs.set(key,[r]);return r;}
   posts.push({ac,b,key});const job={id:'J'+(++n),accountId:ac,kind:'send',state:'queued',phase:'queued',sourceId:b.sourceId,threadId:b.threadId,serverMessageId:null,result:null};jobs.set(key,s.script(b,job));if(s.postThrows)throw Error('lost response');return job;},
  findSend:async(ac,key)=>{gets.push(key);const list=jobs.get(key);if(!list)throw Error('not found');return list.length>1?list.shift():list[0];}};
 const active=new Map(),results=[];let f;
 function reopen(){active.clear();active.set('local',{adapter:new Adapter(a,j),client,directory:{target:async id=>({id})},loadMedia:async(url,o)=>{loads.push({url,o});const [b,ct,fn]=FILES[url];return {buffer:b,contentType:ct,fileName:fn,kind:'x'};},mediaPoll:{intervalMs:0,deadlineMs:50},...(s.caps?{mediaCaps:s.caps}:{})});f=contactsFeatures(()=>a,active,()=>{});}reopen();
 const ctx={cfg:{},accountId:'local',to:ownerSend?other:peer,deliveryQueueId:'Q1',payload:p,mediaUrl:p.mediaUrl,mediaAccess:{localRoots:['/m']},onDeliveryResult:r=>{results.push(r);}};
 return {a,dir,p,ctx,s,uploads,posts,gets,textPosts,loads,results,jobs,get j(){return j;},get f(){return f;},reopen,restart(){j.close();j=new Journal(dir);reopen();},close(){j.close();},
  reconcile(){return f.durableFinal.reconcileUnknownSend({cfg:{},accountId:'local',queueId:'Q1',channel:'wechat-native-isolated',to:ctx.to,payloads:[p],enqueuedAt:0,retryCount:1});}};
}
const journalText=s=>readFileSync(s.j.path,'utf8');

test('kind selection: images/video native, voice only when requested, other audio and forceDocument become files',()=>{
 assert.equal(chooseKind('image/png'),'image');assert.equal(chooseKind('image/svg+xml'),'file');assert.equal(chooseKind('video/mp4'),'video');
 assert.equal(chooseKind('audio/ogg'),'file');assert.equal(chooseKind('audio/ogg',{voice:true}),'voice');assert.equal(chooseKind('image/png',{voice:true}),'image');
 assert.equal(chooseKind('image/jpeg',{forceDocument:true}),'file');assert.equal(chooseKind('application/pdf'),'file');
});

test('image reply: one staged upload, one POST without text/caption field, accepted native receipt, owned copy released',async()=>{
 const s=setup();try{const r=await s.f.outbound.sendPayload(s.ctx);
  assert.equal(s.uploads.length,1);assert.equal(s.posts.length,1);assert.deepEqual(s.posts[0].b,{threadId:peer,kind:'image',sourceId:'U1'});assert.equal(s.posts[0].ac,'daemon');
  assert.equal(r.messageId,'NJ1');assert.deepEqual(r.receipt.parts,[{platformMessageId:'NJ1',kind:'media',index:0}]);assert.equal(s.results.length,1);
  assert.equal(readdirSync(s.dir+'/outbound-media').length,0,'owned copy released after acceptance');
  const plan=s.j.rows.find(x=>x.type==='media-plan');assert.equal(plan.sha256,sha(PNG));assert.equal(plan.kind,'image');assert.equal(s.loads[0].o.mediaAccess.localRoots[0],'/m');
 }finally{s.close();}
});

test('file keeps its name and MIME; video requests normal quality; voice reports every chunk receipt',async()=>{
 for(const [url,kind,extra,voice] of [['/m/r.pdf','file',{}],['/m/v.mp4','video',{videoQuality:'normal'}],['/m/n.ogg','voice',{},true],['/m/n.ogg','file',{}]]){
  const s=setup({payload:{text:'',mediaUrl:url,...(voice?{audioAsVoice:true}:{})}});try{const r=await s.f.outbound.sendPayload(s.ctx);
   assert.deepEqual(s.posts[0].b,{threadId:peer,kind,sourceId:'U1',...extra});assert.equal(s.uploads[0].fileName,FILES[url][2]);assert.equal(s.uploads[0].contentType,FILES[url][1]);
   if(kind==='voice'){assert.deepEqual(r.receipt.platformMessageIds,['V0','V1']);assert.deepEqual(r.receipt.parts.map(p=>p.kind),['voice','voice']);}
  }finally{s.close();}}
});

test('caption + media: caption is a separate text part sent first, both receipts reported, plan binds one queue entry',async()=>{
 const s=setup({payload:{text:'synthetic caption',mediaUrl:'/m/a.png'}});try{const r=await s.f.outbound.sendPayload(s.ctx);
  assert.equal(s.textPosts.length,1);assert.equal(s.textPosts[0].b.text,'synthetic caption');assert.equal(s.posts.length,1);assert.equal(s.posts[0].b.text,undefined);
  assert.deepEqual(r.receipt.parts.map(p=>[p.kind,p.index]),[['text',0],['media',1]]);assert.equal(s.results.length,2);
  assert.ok(!journalText(s).includes('synthetic caption'),'no caption text in journal');
  await assert.rejects(s.f.outbound.sendPayload({...s.ctx,deliveryQueueId:'Q2'}),/already used/);assert.equal(s.posts.length,1);
 }finally{s.close();}
});

test('two media in one payload send in order with distinct idempotency keys',async()=>{
 const s=setup({payload:{text:'',mediaUrls:['/m/a.png','/m/r.pdf']}});try{const r=await s.f.outbound.sendPayload(s.ctx);
  assert.deepEqual(s.posts.map(p=>p.b.kind),['image','file']);assert.equal(new Set(s.posts.map(p=>p.key)).size,2);assert.equal(r.receipt.platformMessageIds.length,2);
 }finally{s.close();}
});

test('oversize media fails before anything is sent, including its caption',async()=>{
 const s=setup({payload:{text:'synthetic caption',mediaUrl:'/m/a.png'}});s.s.caps={...CAPS,image:10};s.reopen();try{
  await assert.rejects(s.f.outbound.sendPayload(s.ctx),e=>e.code==='oversize');assert.equal(s.uploads.length,0);assert.equal(s.posts.length,0);assert.equal(s.textPosts.length,0);
  assert.deepEqual(await s.reconcile(),{status:'not_sent'});
 }finally{s.close();}
});

test('crash after upload (before submit): restart reuses the staged source, POSTs exactly once',async()=>{
 const s=setup();try{await assert.rejects(s.f.outbound.sendPayload({...s.ctx,onPlatformSendDispatch:async()=>{throw Error('crash');}}),/crash/);
  assert.equal(s.uploads.length,1);assert.equal(s.posts.length,0);
  s.restart();assert.deepEqual(await s.reconcile(),{status:'not_sent'},'journal proves nothing was POSTed');
  const r=await s.f.outbound.sendPayload(s.ctx);assert.equal(s.uploads.length,1,'no second upload');assert.equal(s.posts.length,1);assert.equal(s.posts[0].b.sourceId,'U1');assert.equal(r.messageId,'NJ1');
 }finally{s.close();}
});

test('crash after submit (lost POST response): GET-only recovery, never a second POST',async()=>{
 const s=setup();s.s.postThrows=true;s.s.script=(b,job)=>[{...job,state:'running',phase:'submitting'}];try{
  await assert.rejects(s.f.outbound.sendPayload(s.ctx),e=>e.code==='uncertain');assert.equal(s.posts.length,1);
  s.restart();assert.equal((await s.reconcile()).status,'unresolved','still pending');
  await assert.rejects(s.f.outbound.sendPayload(s.ctx),e=>e.code==='uncertain');assert.equal(s.posts.length,1,'retry is GET-only');
  s.jobs.set(s.posts[0].key,[accepted({id:'J1',accountId:'daemon',kind:'send',sourceId:'U1',threadId:peer},{kind:'image'})]);
  const r=await s.reconcile();assert.equal(r.status,'sent');assert.equal(r.messageId,'NJ1');assert.equal(s.posts.length,1);assert.equal(s.uploads.length,1);
 }finally{s.close();}
});

test('crash after accepted: reconcile returns the correlated receipt; a replayed send is GET-only',async()=>{
 const s=setup();s.s.script=(b,job)=>[accepted(job,b)];try{
  // Platform accepted, then the process died before the host recorded the result.
  await assert.rejects(s.f.outbound.sendPayload({...s.ctx,onDeliveryResult:()=>{throw Error('crash');}}),/crash/);assert.equal(s.posts.length,1);
  s.restart();const r=await s.reconcile();assert.equal(r.status,'sent');assert.deepEqual(r.receipt.platformMessageIds,['NJ1']);
  const again=await s.f.outbound.sendPayload(s.ctx);assert.equal(again.messageId,'NJ1');assert.equal(s.posts.length,1);assert.equal(s.uploads.length,1);
 }finally{s.close();}
});

test('partial voice: accepted chunk receipt preserved and reported, rest unresolved, no resend',async()=>{
 const s=setup({payload:{text:'',mediaUrl:'/m/n.ogg',audioAsVoice:true}});
 s.s.script=(b,job)=>[{...job,state:'needs_review',phase:'completed',reason:'submission_outcome_unknown',result:{chunks:[{index:0,state:'accepted',durationMs:60000,serverMessageId:'V0'},{index:1,state:'needs_review',durationMs:5000,serverMessageId:null}]}}];try{
  await assert.rejects(s.f.outbound.sendPayload(s.ctx),e=>e.code==='uncertain'&&e.ids[0]==='V0');
  assert.deepEqual(s.results.map(r=>r.receipt.parts[0]),[{platformMessageId:'V0',kind:'voice',index:0}]);
  assert.deepEqual(await s.reconcile(),{status:'unresolved',retryable:false});
  const obs=s.j.rows.filter(r=>r.type==='media-send-observation').at(-1);assert.deepEqual(obs.ids,['V0']);assert.equal(s.posts.length,1);
 }finally{s.close();}
});

test('failed job, accepted job without native receipt, and foreign-thread job are never success and never resent',async()=>{
 for(const script of [(b,job)=>[{...job,state:'failed',phase:'uploading',reason:'transport_unavailable'}],(b,job)=>[{...job,state:'accepted',phase:'completed',result:{profileProjection:'pending'}}],(b,job)=>[{...accepted(job,b),threadId:'wxid_elsewhere'}],(b,job)=>[{...job,state:'running',phase:'completed'}]]){
  const s=setup();s.s.script=script;try{await assert.rejects(s.f.outbound.sendPayload(s.ctx),e=>['failed','uncertain'].includes(e.code));
   assert.equal((await s.reconcile()).status,'unresolved');await assert.rejects(s.f.outbound.sendPayload(s.ctx));assert.equal(s.posts.length,1);assert.equal(s.uploads.length,1);
  }finally{s.close();}}
});

test('owner may send media to a third party; non-owner and revoked owner cannot, before any upload',async()=>{
 const s=setup({ownerSend:true});try{await s.f.outbound.sendPayload(s.ctx);assert.equal(s.posts[0].b.threadId,other);
  assert.throws(()=>prepareOwnerPayload(s.a,s.j,{requesterAccountId:'local',requesterSenderId:peer,senderIsOwner:false},other,{text:'',mediaUrl:'/m/a.png'}),/owner/i);
  assert.throws(()=>prepareOwnerPayload(s.a,s.j,{requesterAccountId:'local',requesterSenderId:peer,senderIsOwner:true},other,{text:'',mediaUrl:'/m/a.png'}),/owner/i);
 }finally{s.close();}
 const r=setup({ownerSend:true});try{r.a.ownerIds=[];r.reopen();await assert.rejects(r.f.outbound.sendPayload(r.ctx),/revoked/);assert.equal(r.uploads.length,0);assert.equal(r.posts.length,0);}finally{r.close();}
});

test('reply plan cannot be redirected and media payloads require a plan token',async()=>{
 const s=setup();try{await assert.rejects(s.f.outbound.sendPayload({...s.ctx,to:other}),/target mismatch/);
  await assert.rejects(s.f.outbound.sendPayload({...s.ctx,payload:{text:'',mediaUrl:'/m/a.png'}}),/plan required/);
  await assert.rejects(s.f.outbound.sendPayload({...s.ctx,payload:{...s.p,mediaUrls:['/m/a.png','/m/r.pdf'],mediaUrl:undefined}}),/plan mismatch/);assert.equal(s.uploads.length+s.posts.length,0);
 }finally{s.close();}
});

test('core sendMedia (no plan token): exact inbound reply origin allowed, caption first; no origin -> denied before upload',async()=>{
 const s=setup();try{const ctx={cfg:{},accountId:'local',to:peer,text:'synthetic caption',mediaUrl:'/m/r.pdf',deliveryQueueId:'Q9',deliveryPartIndex:0,mediaAccess:{localRoots:['/m']}};
  await assert.rejects(s.f.outbound.sendMedia(ctx),/send denied/);assert.equal(s.uploads.length,0);
  const r=await withInboundOrigin({accountId:'local',daemonAccountId:'daemon',peerId:peer,senderId:peer},()=>s.f.outbound.sendMedia({...ctx,deliveryQueueId:'Q10'}));
  assert.deepEqual(r.receipt.parts.map(p=>p.kind),['text','media']);assert.equal(s.posts[0].b.kind,'file');
  await assert.rejects(withInboundOrigin({accountId:'local',daemonAccountId:'daemon',peerId:peer,senderId:peer},()=>s.f.outbound.sendMedia({...ctx,to:other,deliveryQueueId:'Q11'})),/send denied/);
 }finally{s.close();}
});

test('judgeJob correlates account/thread/source; multipart body carries exactly one file part; upload client is POST multipart',async()=>{
 const plan={account:'daemon',peerId:peer,kind:'image'},job={id:'J1',accountId:'daemon',threadId:peer,sourceId:'U1',kind:'send'};
 assert.equal(judgeJob(accepted(job,{kind:'image'}),plan,'U1').state,'sent');assert.equal(judgeJob(accepted(job,{kind:'image'}),plan,'U2').state,'mismatch');
 assert.equal(judgeJob({...accepted(job,{kind:'image'}),accountId:'x'},plan,'U1').state,'mismatch');assert.equal(judgeJob({...job,state:'queued'},plan,'U1').state,'pending');
 assert.equal(judgeJob({...accepted(job,{kind:'image'}),result:{nativeReceipt:{status:'server_accepted',serverMessageId:'N',clientIdMatches:false}}},plan,'U1').state,'unresolved');
 const {boundary,body}=multipartBody({bytes:PDF,fileName:'report.pdf',contentType:'application/pdf'});const text=body.toString('latin1');
 assert.equal(text.split('--'+boundary).length-1,2);assert.match(text,/name="file"; filename="report.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF/);
 const seen=[];const c=daemonClient('http://127.0.0.1:6174/','synthetic',async(url,init)=>{seen.push({url:String(url),init});return {ok:true,status:201,json:async()=>({id:'U1'})};});
 await c.upload('daemon',{bytes:PDF,fileName:'report.pdf',contentType:'application/pdf'});
 assert.equal(seen[0].url,'http://127.0.0.1:6174/v1/accounts/daemon/uploads');assert.equal(seen[0].init.method,'POST');assert.match(seen[0].init.headers['Content-Type'],/^multipart\/form-data; boundary=/);assert.equal(seen[0].init.redirect,'error');
});

test('durable capabilities declare media with a media reconciler; plugin advertises media',async()=>{
 const s=setup();try{assert.equal(s.f.durableFinal.capabilities.media,true);assert.equal(s.f.durableFinal.reconcileUnknownSendKinds.media,true);assert.equal(s.f.durableFinal.capabilities.batch,undefined);assert.equal(typeof s.f.outbound.sendMedia,'function');}finally{s.close();}
 const plugin=(await import('../build/plugin.js')).default.makePlugin({});assert.equal(plugin.capabilities.media,true);assert.equal(plugin.message.durableFinal.capabilities.media,true);
});

test('host capability proof helper: every declared durable capability has a passing behavioral proof',async()=>{
 const {verifyChannelMessageAdapterCapabilityProofs}=await import('openclaw/plugin-sdk/channel-outbound');
 const run=async(payload,check,prep=s=>{})=>{const s=setup({payload});try{prep(s);await check(s);}finally{s.close();}};
 const proofs={
  text:()=>run({text:'synthetic text'},async s=>{await s.f.outbound.sendPayload(s.ctx);assert.equal(s.textPosts.length,1);assert.equal(s.posts.length,0);}),
  media:()=>run({text:'',mediaUrl:'/m/a.png'},async s=>{const r=await s.f.outbound.sendPayload(s.ctx);assert.equal(s.posts.length,1);assert.equal(r.receipt.parts[0].kind,'media');}),
  payload:()=>run({text:'synthetic caption',mediaUrls:['/m/a.png','/m/r.pdf']},async s=>{const r=await s.f.outbound.sendPayload(s.ctx);assert.deepEqual(r.receipt.parts.map(p=>p.kind),['text','media','media']);}),
  reconcileUnknownSend:()=>run({text:'',mediaUrl:'/m/a.png'},async s=>{await assert.rejects(s.f.outbound.sendPayload(s.ctx));s.restart();s.jobs.set(s.posts[0].key,[accepted({id:'J1',accountId:'daemon',kind:'send',sourceId:'U1',threadId:peer},{kind:'image'})]);assert.equal((await s.reconcile()).status,'sent');assert.equal(s.posts.length,1);},s=>{s.s.postThrows=true;s.s.script=(b,job)=>[{...job,state:'running'}];})
 };
 const s=setup();let result;try{result=await verifyChannelMessageAdapterCapabilityProofs({adapterName:'wechat-native-isolated',adapter:{durableFinal:s.f.durableFinal},proofs});}finally{s.close();}
 assert.deepEqual(result.filter(r=>r.status==='verified').map(r=>r.capability).sort(),['media','payload','reconcileUnknownSend','text']);
});

test('definitive 4xx on the final POST fails at once (no polling); retry and reconcile stay GET-only',async()=>{
 const s=setup();s.s.script=(b,job)=>{throw Object.assign(Error('daemon request failed'),{status:403});};try{
  await assert.rejects(s.f.outbound.sendPayload(s.ctx),e=>e.code==='refused'&&e.status===403);assert.equal(s.gets.length,0,'no polling after a refusal');
  assert.equal((await s.reconcile()).status,'unresolved');await assert.rejects(s.f.outbound.sendPayload(s.ctx));assert.equal(s.posts.length,1);
 }finally{s.close();}
});
test('polling journals observations only on change',async()=>{
 const s=setup();s.s.script=(b,job)=>[...Array(5).fill({...job,state:'running',phase:'uploading'}),accepted(job,b)];try{
  await s.f.outbound.sendPayload(s.ctx);const obs=s.j.rows.filter(r=>r.type==='media-send-observation').map(r=>r.state);assert.ok(s.gets.length>=6);assert.deepEqual(obs,['queued','running','accepted']);
 }finally{s.close();}
});
