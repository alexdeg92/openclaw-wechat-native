import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {decodeInbound,UNSUPPORTED_NOTE} from '../build/decode-media.mjs';
import {retrieveMedia,MediaJobs,CAPS,safeFileName} from '../build/inbound-media.mjs';
import {prepareMediaEvent,VOICE_NO_TRANSCRIPT} from '../build/host-media.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]),PNG=Buffer.from('\x89PNG\r\n\x1a\nxyz','latin1'),WAV=Buffer.from('RIFF\x24\0\0\0WAVEfmt data','latin1'),MP4=Buffer.from('\0\0\0\x18ftypmp42xxxx','latin1'),PDF=Buffer.from('%PDF-1.4 synthetic');
const ev=(id='M1')=>({cursor:'7',kind:'message.committed',data:{origin:'live',direction:'incoming',threadId:'PeerX',messageId:id}});
const msg=(o)=>({id:'M1',accountId:'daemon',threadId:'PeerX',senderId:'PeerX',direction:'incoming',type:1,body:null,media:[],...o});

test('decoder: text, media kinds, file subtype, link/quote text, unsupported note, notices and scope',()=>{
 assert.equal(decodeInbound(ev(),msg({body:'hi'}),'daemon').text,'hi');
 for(const [type,kind] of [[3,'image'],[34,'voice'],[43,'video'],[47,'sticker']]){const e=decodeInbound(ev(),msg({type}),'daemon');assert.equal(e.kind,'direct-media');assert.equal(e.mediaKind,kind);assert.equal(e.text,undefined);}
 assert.equal(decodeInbound(ev(),msg({type:49,appMessageType:6,body:null}),'daemon').mediaKind,'file');
 assert.equal(decodeInbound(ev(),msg({type:49,appMessageType:5,body:'[Link] T\nD\nhttps://x.invalid'}),'daemon').text,'[Link] T\nD\nhttps://x.invalid');
 assert.equal(decodeInbound(ev(),msg({type:49,appMessageType:57,body:'reply text'}),'daemon').kind,'direct-text');
 const q=decodeInbound(ev(),msg({type:49,appMessageType:57,body:'look',quote:{serverId:'1',type:3,embeddedImage:true}}),'daemon');assert.deepEqual([q.kind,q.mediaKind,q.text,q.optional],['direct-media','image','look',true]);
 for(const o of [{type:48,body:'<msg><location x="1"/></msg>'},{type:49,appMessageType:2000,body:null},{type:42}]){const e=decodeInbound(ev(),msg(o),'daemon');assert.equal(e.text,UNSUPPORTED_NOTE,'never raw XML');}
 assert.equal(decodeInbound(ev(),msg({type:10000,body:'notice'}),'daemon'),null);
 assert.equal(decodeInbound(ev(),msg({type:3,direction:'outgoing'}),'daemon'),null);
 assert.equal(decodeInbound(ev(),msg({type:3,recall:{observedAt:'x'}}),'daemon'),null);
 assert.equal(decodeInbound({...ev(),data:{...ev().data,origin:'history'}},msg({type:3}),'daemon'),null);
 assert.throws(()=>decodeInbound(ev(),msg({type:3,accountId:'other'}),'daemon'),/scope mismatch/);
 assert.throws(()=>decodeInbound(ev(),msg({type:3,senderId:'Other'}),'daemon'),/sender mismatch/);
 assert.equal(safeFileName('../../etc/pass\nwd'),'passwd');assert.equal(safeFileName('..'),undefined);
});

// Fake daemon client (same method surface as daemon.mjs). Records every call.
function fake({assets,jobs={},bytes={},headers={}}){const calls=[];const a=new Map(assets.map(x=>[x.id,x]));
 return {calls,a,client:{
  mediaAssets:async(acct,id)=>{calls.push('assets '+id);return {items:[...a.values()].map(x=>({...x}))};},
  mediaAsset:async(acct,id)=>{calls.push('asset '+id);return {...a.get(id)};},
  startMediaTransfer:async(acct,id,b)=>{calls.push('POST '+b.assetId+' '+b.quality);const j=jobs[b.assetId];return {...j.shift?j[0]:j};},
  job:async(acct,id)=>{calls.push('job '+id);const seq=Object.values(jobs).find(s=>s[0].id===id);const st=seq.length>1?seq.shift():seq[0];if(st.state==='available'){const x=a.get(st.assetId);Object.assign(x,x.ready);}return {...st};},
  mediaContent:async(acct,id)=>{calls.push('content '+id);const b=bytes[id];const h={'content-type':a.get(id).contentType,'content-length':String(b.length),etag:`"${sha(b)}"`,...headers[id]};return {status:200,headers:new Headers(Object.fromEntries(Object.entries(h).filter(([,v])=>v!=null))),body:(async function*(){yield b.subarray(0,Math.ceil(b.length/2));yield b.subarray(Math.ceil(b.length/2));})()};}}};}
const asset=(id,kind,variant,b,ct,o={})=>{const ready={state:'available',contentType:ct,byteLength:b.length,sha256:sha(b)};return {id,accountId:'daemon',messageId:'M1',kind,variant,actualVariant:null,filename:null,jobId:null,reason:null,retryable:true,expiresAt:null,...(o.state&&o.state!=='available'?{state:o.state,contentType:null,byteLength:null,sha256:null}:ready),ready,...o};};
const job=(id,assetId,state)=>({id,accountId:'daemon',kind:'download',state,phase:state,assetId,attempts:0,cancelRequested:false,retryable:false,reason:null,completedBytes:0,totalBytes:null,result:null});
const dir=()=>mkdtempSync(tmpdir()+'/wechat-media-');
const saved=[];const save=async(buf,ct,cap,name)=>{saved.push({ct,cap,name,len:buf.length});return {path:'/host/media/inbound/'+saved.length,size:buf.length,contentType:ct};};
const media=(kind,id='M1')=>({accountId:'daemon',peerId:'PeerX',senderId:'PeerX',messageId:id,cursor:'7',kind:'direct-media',mediaKind:kind,outgoing:false});
const opts=(client,o={})=>({client,account:'daemon',jobs:new MediaJobs(o.dir??dir()),save,sleep:async()=>{},poll:{intervalMs:1,deadlineMs:1e9},...o});

test('image available: original fetched and verified, thumbnail untouched, no transfer',async()=>{
 const f=fake({assets:[asset('A1','image','thumbnail',PNG,'image/png'),asset('A2','image','original',JPEG,'image/jpeg')],bytes:{A1:PNG,A2:JPEG}});
 const r=await retrieveMedia(media('image'),opts(f.client));
 assert.equal(r.stored.contentType,'image/jpeg');assert.equal(r.stored.size,JPEG.length);assert.equal(saved.at(-1).cap,CAPS.image);
 assert.deepEqual(f.calls,['assets M1','content A2']);
});

test('voice pending -> transfer once (normal WAV) -> queued/running/available -> stored; transcript via host runtime',async()=>{
 const f=fake({assets:[asset('V2','voice','encoded',WAV,'audio/silk',{state:'pending'}),asset('V1','voice','normal',WAV,'audio/wav',{state:'pending'})],jobs:{V1:[job('J1','V1','queued'),job('J1','V1','running'),job('J1','V1','available')]},bytes:{V1:WAV}});
 const calls=[];const runtime={channel:{media:{saveMediaBuffer:async(b,ct,sub,cap,name)=>{calls.push(['save',ct,sub,cap]);return {id:'x',path:'/host/media/inbound/v.wav',size:b.length,contentType:ct};}},routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'s'})}},
  mediaUnderstanding:{resolveAudioInputBudget:async()=>({enabled:true,maxBytes:1e6}),transcribeAudioFile:async(p)=>{calls.push(['transcribe',p.filePath,p.mime,p.scopeContext.chatType]);return {text:' hello there '};}}};
 const out=await prepareMediaEvent(media('voice'),{runtime,cfg:{},accountId:'local',channel:'wechat-native-isolated',client:f.client,daemonAccountId:'daemon',jobs:new MediaJobs(dir()),sleep:async()=>{},poll:{intervalMs:1,deadlineMs:1e9}});
 assert.deepEqual(f.calls.filter(c=>c.startsWith('POST')),['POST V1 normal'],'one transfer, WAV preferred');
 assert.deepEqual(calls,[['save','audio/wav','inbound',CAPS.voice],['transcribe','/host/media/inbound/v.wav','audio/wav','direct']]);
 assert.equal(out.kind,'direct-text');assert.equal(out.sourceModality,'voice');
 assert.equal(out.text,'<media:audio>\n[WeChat voice message transcript]\nhello there');
 assert.deepEqual(out.media,[{path:'/host/media/inbound/v.wav',contentType:'audio/wav',kind:'audio',sizeBytes:WAV.length,messageId:'M1',transcribed:true}]);
 // transcription unavailable -> attachment-only with explicit note
 const g=fake({assets:[asset('V1','voice','normal',WAV,'audio/wav')],bytes:{V1:WAV}});
 const out2=await prepareMediaEvent(media('voice'),{runtime:{...runtime,mediaUnderstanding:{resolveAudioInputBudget:async()=>({enabled:false})}},cfg:{},accountId:'local',channel:'c',client:g.client,daemonAccountId:'daemon',jobs:new MediaJobs(dir())});
 assert.equal(out2.text,'<media:audio>\n'+VOICE_NO_TRANSCRIPT);assert.equal(out2.media[0].transcribed,undefined);
});

test('file: PDF becomes a document fact with a sanitized filename; video skips thumbnail',async()=>{
 const rt={channel:{media:{saveMediaBuffer:async(b,ct,s,c,n)=>({path:'/host/f',size:b.length,contentType:ct})}}};
 const f=fake({assets:[asset('F1','file','original',PDF,'application/pdf',{filename:'../Q3 report.pdf'})],bytes:{F1:PDF}});
 const out=await prepareMediaEvent(media('file'),{runtime:rt,cfg:{},accountId:'l',channel:'c',client:f.client,daemonAccountId:'daemon',jobs:new MediaJobs(dir())});
 assert.deepEqual(out.media[0],{path:'/host/f',contentType:'application/pdf',kind:'document',sizeBytes:PDF.length,messageId:'M1',fileName:'Q3 report.pdf'});
 assert.equal(out.text,'<media:document>');assert.equal(out.sourceModality,'document');
 const v=fake({assets:[asset('T1','video','thumbnail',JPEG,'image/jpeg'),asset('V1','video','normal',MP4,'video/mp4')],bytes:{T1:JPEG,V1:MP4}});
 const vo=await prepareMediaEvent(media('video'),{runtime:rt,cfg:{},accountId:'l',channel:'c',client:v.client,daemonAccountId:'daemon',jobs:new MediaJobs(dir())});
 assert.equal(vo.media[0].kind,'video');assert.equal(vo.text,'<media:video>');assert.ok(!v.calls.includes('content T1'));
});

test('expired / unsupported / failed job / nothing discovered produce explicit notes and no fetch',async()=>{
 const rt={channel:{media:{saveMediaBuffer:async()=>{throw Error('must not save')}}}};
 const run=async(f,kind='image')=>prepareMediaEvent(media(kind),{runtime:rt,cfg:{},accountId:'l',channel:'c',client:f.client,daemonAccountId:'daemon',jobs:new MediaJobs(dir()),sleep:async()=>{},poll:{intervalMs:1,deadlineMs:1e9}});
 const exp=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'expired'})]});
 assert.equal((await run(exp)).text,'[WeChat image not available: expired on WeChat]');assert.ok(!exp.calls.some(c=>c.startsWith('content')||c.startsWith('POST')));
 const uns=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'unsupported'})]});
 assert.equal((await run(uns)).text,'[WeChat image not available: unsupported format]');
 const failed=fake({assets:[asset('A1','video','normal',MP4,'video/mp4',{state:'pending'})],jobs:{A1:[job('J','A1','queued'),job('J','A1','failed')]}});
 const fo=await run(failed,'video');assert.equal(fo.text,'[WeChat video not available: download failed]');assert.deepEqual(fo.media,[]);
 const none=fake({assets:[]});assert.equal((await run(none,'file')).text,'[WeChat file not available: download failed]');
 const wrong=fake({assets:[{...asset('A1','image','original',JPEG,'image/jpeg'),accountId:'other'}],bytes:{A1:JPEG}});
 assert.match((await run(wrong)).text,/not available/);assert.ok(!wrong.calls.some(c=>c.startsWith('content')),'foreign-account asset never fetched');
});

test('hash mismatch falls back to the next variant; all mismatched -> integrity note; MIME and magic checked',async()=>{
 const bad=Buffer.from(JPEG);bad[5]=9;
 const f=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg'),asset('A2','image','standard',JPEG,'image/jpeg')],bytes:{A1:bad,A2:JPEG},headers:{A1:{etag:null}}});
 const r=await retrieveMedia(media('image'),opts(f.client));assert.equal(r.stored.variant,'standard');assert.deepEqual(f.calls.filter(c=>c.startsWith('content')),['content A1','content A2']);
 const g=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg')],bytes:{A1:JPEG},headers:{A1:{etag:'"'+'0'.repeat(64)+'"'}}});
 assert.equal((await retrieveMedia(media('image'),opts(g.client))).error,'hash_mismatch','ETag must agree too');
 const m=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg')],bytes:{A1:JPEG},headers:{A1:{'content-type':'text/html'}}});
 assert.equal((await retrieveMedia(media('image'),opts(m.client))).error,'mime_mismatch');
 const txt=Buffer.from('not an image');const x=fake({assets:[asset('A1','image','original',txt,'image/jpeg')],bytes:{A1:txt}});
 assert.equal((await retrieveMedia(media('image'),opts(x.client))).error,'bad_bytes');
 const v=fake({assets:[asset('A1','voice','normal',JPEG,'image/jpeg')],bytes:{A1:JPEG}});
 assert.equal((await retrieveMedia(media('voice'),opts(v.client))).error,'mime_mismatch','voice must be audio/*');
});

test('oversize: declared length, Content-Length and streamed bytes are capped; nothing saved',async()=>{
 const before=saved.length,big=Buffer.alloc(64,1);
 const d=fake({assets:[{...asset('A1','file','original',big,'application/octet-stream'),byteLength:CAPS.file+1}],bytes:{A1:big}});
 assert.equal((await retrieveMedia(media('file'),opts(d.client))).error,'oversize');assert.ok(!d.calls.includes('content A1'),'refused before fetch');
 const s=fake({assets:[{...asset('A1','file','original',big,'application/octet-stream'),byteLength:null}],bytes:{A1:big},headers:{A1:{'content-length':null}}});
 assert.equal((await retrieveMedia(media('file'),opts(s.client,{caps:{...CAPS,file:32}}))).error,'oversize','streamed cap');
 const h=fake({assets:[{...asset('A1','file','original',big,'application/octet-stream'),byteLength:null}],bytes:{A1:big},headers:{A1:{'content-length':'999999999'}}});
 assert.equal((await retrieveMedia(media('file'),opts(h.client))).error,'oversize','Content-Length cap');
 assert.equal(saved.length,before);
});

test('deadline: still-running job yields a timeout note, never a second transfer',async()=>{
 let t=0;const f=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'pending'})],jobs:{A1:[job('J','A1','running')]}});
 const r=await retrieveMedia(media('image'),opts(f.client,{now:()=>(t+=1000),poll:{intervalMs:1,deadlineMs:5000}}));
 assert.equal(r.error,'timeout');assert.equal(f.calls.filter(c=>c.startsWith('POST')).length,1);
});

test('restart while pending: abort keeps the job; a new process polls the same job, zero new POSTs',async()=>{
 const d=dir(),ac=new AbortController();
 const f=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'pending'})],jobs:{A1:[job('J9','A1','queued')]},bytes:{A1:JPEG}});
 let polls=0;const sleep=async()=>{if(++polls===2)ac.abort();};
 await assert.rejects(retrieveMedia(media('image'),opts(f.client,{dir:d,signal:ac.signal,sleep})),{name:'AbortError'});
 assert.equal(f.calls.filter(c=>c.startsWith('POST')).length,1);
 // "restart": fresh journal instance from disk; daemon finished meanwhile
 const g=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'pending'})],jobs:{A1:[job('J9','A1','available')]},bytes:{A1:JPEG}});
 const r=await retrieveMedia(media('image'),opts(g.client,{dir:d}));
 assert.ok(r.stored);assert.deepEqual(g.calls,['assets M1','job J9','asset A1','content A1']);
 // job id published by the daemon on the asset is also honored without POST
 const k=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'pending',jobId:'J5'})],jobs:{A1:[job('J5','A1','available')]},bytes:{A1:JPEG}});
 assert.ok((await retrieveMedia(media('image'),opts(k.client))).stored);assert.ok(!k.calls.some(c=>c.startsWith('POST')));
 // job identity mismatch fails closed
 const bad=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg',{state:'pending'})],jobs:{A1:[{...job('J1','A1','queued'),accountId:'other'}]}});
 assert.equal((await retrieveMedia(media('image'),opts(bad.client))).error,'job_mismatch');
});

test('quoted reply with embedded image: text kept, image optional (no note when missing)',async()=>{
 const rt={channel:{media:{saveMediaBuffer:async(b,ct)=>({path:'/host/q',size:b.length,contentType:ct})}}};
 const e={...media('image'),text:'look at this',optional:true};
 const ok=fake({assets:[asset('A1','image','original',JPEG,'image/jpeg')],bytes:{A1:JPEG}});
 const out=await prepareMediaEvent(e,{runtime:rt,cfg:{},accountId:'l',channel:'c',client:ok.client,daemonAccountId:'daemon',jobs:new MediaJobs(dir())});
 assert.equal(out.text,'look at this\n<media:image>');assert.equal(out.media.length,1);assert.equal(out.sourceModality,undefined);
 const none=await prepareMediaEvent(e,{runtime:rt,cfg:{},accountId:'l',channel:'c',client:fake({assets:[]}).client,daemonAccountId:'daemon',jobs:new MediaJobs(dir())});
 assert.equal(none.text,'look at this');assert.deepEqual(none.media,[]);
});
