// Real installed host, fake daemon: an agent final carrying an image path is spooled by the host, prepared under a
// reply plan, staged once, POSTed once and accepted with a correlated native receipt. No network, no WeChat.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {deflateSync,crc32} from 'node:zlib';
import {startHarness,finalCounts} from './e2e-harness.mjs';
function png(){const chunk=(type,data)=>{const len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2,0);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,0,255,0,0,0,0,0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);}
function wav(){const pcm=Buffer.alloc(1600),h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+pcm.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(8000,24);h.writeUInt32LE(16000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
const want=new Map();
const h=await startHarness({replyExtra:(ctx,state)=>{const w=want.get(ctx.RawBody);if(!w)return {};const dir=state+'/media/outbound';mkdirSync(dir,{recursive:true});const file=dir+'/'+w.name;writeFileSync(file,w.bytes);return {text:w.caption,mediaUrl:file,...(w.extra??{})};}});
test.after(()=>h.close());

test('agent final with an image path -> one staged upload -> one media POST -> accepted (real host)',async()=>{
 want.set('send me a picture',{name:'chart.png',bytes:png(),caption:''});
 const textBefore=h.posts.length;const r=await h.inbound({body:'send me a picture'});
 assert.equal(r.dispatched,true);assert.deepEqual(finalCounts(r),{delivered:1,deliveredNotVisible:0,cancelled:0,failedBeforeSend:0,failedAfterSend:0});
 assert.equal(h.uploads.length,1,'one staged upload');assert.match(h.uploads[0].header,/name="file"; filename="[^"]+"\r\nContent-Type: image\//);
 assert.equal(h.mediaSends.length,1,'one media POST');assert.deepEqual(h.mediaSends[0].b,{threadId:'PeerX',kind:'image',sourceId:'U1'});
 assert.equal(h.posts.length,textBefore,'no text part for a caption-less image');
 const jr=readFileSync(h.state+'/journal/custody.jsonl','utf8').trim().split('\n').map(JSON.parse);
 assert.equal(jr.filter(x=>x.type==='media-send-intent').length,1);assert.equal(jr.filter(x=>x.type==='media-plan')[0].sha256,h.uploads[0].sha256,'uploaded bytes are the planned owned copy');
 assert.ok(h.diag().some(e=>e.event==='sendMedia.receipt'&&e.accepted===1));assert.equal(h.errors.length,0);
});

test('agent final with caption + file -> caption text part then one file send, single delivered final (real host)',async()=>{
 want.set('send me the report',{name:'report.pdf',bytes:Buffer.from('%PDF-1.4\n% synthetic\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),caption:'synthetic caption'});
 const u=h.uploads.length,m=h.mediaSends.length,t=h.posts.length;const r=await h.inbound({body:'send me the report'});
 assert.equal(finalCounts(r).delivered,1);assert.equal(h.uploads.length,u+1);assert.equal(h.mediaSends.length,m+1);assert.equal(h.mediaSends.at(-1).b.kind,'file');
 assert.deepEqual(h.posts.slice(t),['synthetic caption']);assert.match(h.uploads.at(-1).header,/filename="report.pdf"/);
});

test('TTS-style speech final (audioAsVoice) is a native voice note; host TTS sees voice-note delivery for this channel (real host)',async()=>{
 const {t:resolveVoice}=await import((process.env.OPENCLAW_DIST??new URL('../node_modules/openclaw/dist/',import.meta.url).pathname)+'tts-capabilities-DzjUSelf.mjs');
 assert.deepEqual(resolveVoice('wechat-native-isolated'),{synthesisTarget:'voice-note',transcodesAudio:true});
 want.set('say it',{name:'voice.wav',bytes:wav(),caption:'',extra:{audioAsVoice:true,spokenText:'synthetic speech',trustedLocalMedia:true}});
 const m=h.mediaSends.length;const r=await h.inbound({body:'say it'});assert.equal(finalCounts(r).delivered,1);assert.equal(h.mediaSends.length,m+1);assert.equal(h.mediaSends.at(-1).b.kind,'voice');
});

test('plain audio without voice intent goes as a file; generated video goes as native video (real host)',async()=>{
 want.set('send the song',{name:'song.wav',bytes:wav(),caption:''});
 want.set('send the clip',{name:'clip.mp4',bytes:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(60,3)]),caption:''});
 const m=h.mediaSends.length;await h.inbound({body:'send the song'});await h.inbound({body:'send the clip'});
 assert.deepEqual(h.mediaSends.slice(m).map(x=>x.b.kind),['file','video']);assert.equal(h.mediaSends.at(-1).b.videoQuality,'normal');
});
