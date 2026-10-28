import test from 'node:test';import assert from 'node:assert/strict';
import {decode,admitOrigin,CATCHUP_MS} from '../src/daemon.mjs';
import {decodeInbound} from '../src/decode-media.mjs';
const now=Date.parse('2026-10-26T23:10:00Z');
const ev=(origin)=>({cursor:'9',kind:'message.committed',data:{origin,direction:'incoming',threadId:'PeerX',messageId:'M'}});
const msg=(createdAt,extra={})=>({id:'M',accountId:'A',threadId:'PeerX',senderId:'PeerX',direction:'incoming',type:1,media:[],body:'hi',createdAt,...extra});
test('recent catch-up text (sent during a restart) is decoded like live',()=>{
 const r=decode(ev('catchup'),msg('2026-10-26T23:08:14Z'),'A',undefined,now);assert.equal(r?.text,'hi');});
test('old catch-up history, future timestamps and other origins stay ignored',()=>{
 assert.equal(decode(ev('catchup'),msg(new Date(now-CATCHUP_MS-1000).toISOString()),'A',undefined,now),null);
 assert.equal(decode(ev('catchup'),msg('2026-10-26T23:20:00Z'),'A',undefined,now),null);
 assert.equal(decode(ev('catchup'),msg(undefined),'A',undefined,now),null);
 assert.equal(decode(ev('local_send'),msg('2026-10-26T23:09:00Z'),'A',undefined,now),null);
 assert.equal(admitOrigin({origin:'history'},msg('2026-10-26T23:09:00Z'),now),false);});
test('recent catch-up sticker reaches the media decoder',()=>{
 const r=decodeInbound(ev('catchup'),msg('2026-10-26T23:08:22Z',{type:47,body:null}),'A',undefined,now);
 assert.equal(r?.mediaKind,'sticker');});
test('live is unaffected by timestamps',()=>{assert.equal(decode(ev('live'),msg(undefined),'A',undefined,now)?.text,'hi');});
