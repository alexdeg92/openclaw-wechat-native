import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {stickerGrid,countFrames} from '../src/sticker-grid.mjs';
import {retrieveMedia} from '../src/inbound-media.mjs';
const anim=readFileSync(new URL('./fixtures/anim-test.gif',import.meta.url)),still=readFileSync(new URL('./fixtures/static-test.gif',import.meta.url));
test('animated gif becomes one PNG grid with frame counts',async()=>{
 const g=await stickerGrid(anim,'image/gif',{frames:10});assert.ok(g);assert.equal(g.contentType,'image/png');
 assert.equal(g.buffer.subarray(1,4).toString(),'PNG');assert.equal(g.frames,10);assert.equal(g.shown,5);
 // 4x2 tiles of 160 px + 4 px padding
 assert.equal(g.buffer.readUInt32BE(16),4*160+3*4);assert.equal(g.buffer.readUInt32BE(20),2*160+4);});
test('static, non-animated and broken inputs keep the original',async()=>{
 assert.equal(await stickerGrid(still,'image/gif',{frames:1}),null);
 assert.equal(await stickerGrid(anim,'image/png',{frames:10}),null);
 assert.equal(await stickerGrid(Buffer.from('GIF89a garbage'),'image/gif',{frames:5}),null);
 assert.equal(await stickerGrid(anim,'image/gif',{frames:10,exec:async()=>{throw Error('timeout')}}),null);});
test('countFrames estimates gif frames',()=>{assert.ok(countFrames(anim,'image/gif')>1);assert.equal(countFrames(still,'image/gif')<=1,true);});
test('retrieveMedia stores the grid for an animated sticker and the original for an image',async()=>{
 const sha=(await import('node:crypto')).createHash('sha256').update(anim).digest('hex');
 const asset=(kind)=>({id:'asset_1',kind,variant:'original',state:'available',contentType:'image/gif',byteLength:anim.length,sha256:sha,animationFrames:10,messageId:'m1',accountId:'acct'});
 for(const [kind,expectGrid] of [['sticker',true],['image',false]]){
  const saved=[];const client={mediaAssets:async()=>({items:[asset(kind)]}),
   mediaContent:async()=>({status:200,headers:new Headers({'content-type':'image/gif','content-length':String(anim.length)}),body:new Blob([anim]).stream()})};
  const r=await retrieveMedia({messageId:'m1',peerId:'wxid_peer',mediaKind:kind},{client,account:'acct',jobs:{jobFor(){},append(){}},
   save:async(b,ct,cap,fn)=>{saved.push({ct,fn,len:b.length});return {path:'/x',size:b.length,contentType:ct};}});
  assert.ok(r.stored,JSON.stringify(r));assert.equal(saved[0].ct,expectGrid?'image/png':'image/gif');
  assert.equal(!!r.stored.grid,expectGrid);if(expectGrid)assert.deepEqual(r.stored.grid,{frames:10,shown:5});}});
