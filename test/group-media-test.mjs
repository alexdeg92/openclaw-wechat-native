import test from 'node:test';import assert from 'node:assert/strict';
import {decodeInbound} from '../src/decode-media.mjs';import {prepareMediaEvent} from '../build/host-media.js';
const room='room@chatroom',a={accountId:'local',daemonAccountId:'daemon',selfId:'Self',allowFrom:[],dmPolicy:'disabled',ownerIds:[],groupPolicy:'allowlist',groups:{[room]:{requireMention:true}}};
const event={cursor:'1',kind:'message.committed',data:{origin:'live',direction:'incoming',threadId:room,messageId:'M1'}};
const message={id:'M1',accountId:'daemon',threadId:room,senderId:'Member',direction:'incoming',type:3,body:null,media:[],mentions:{state:'known',self:true,userIds:['Self']}};
test('group media decoder applies exact room, structured self mention, incoming member and notice gates before preparation',()=>{
 const e=decodeInbound(event,message,'daemon',a);assert.equal(e.mediaKind,'image');assert.equal(e.senderId,'Member');assert.deepEqual(e.mentions,message.mentions);
 for(const patch of [{mentions:undefined},{mentions:{state:'unknown',self:true}},{mentions:{state:'known',self:false}},{senderId:'Self'},{senderId:room},{recall:{}},{direction:'outgoing'},{type:10000}])assert.equal(decodeInbound(event,{...message,...patch},'daemon',a),null);
 assert.equal(decodeInbound(event,message,'daemon',{...a,groups:{}}),null);assert.equal(decodeInbound(event,message,'daemon',{...a,groupPolicy:'disabled'}),null);
});
test('mentioned group voice transcription uses group route and session while preserving canonical audio facts',async()=>{
 let routeArgs,transcribeArgs;const e={...decodeInbound(event,{...message,type:34},'daemon',a)};
 const runtime={channel:{media:{saveMediaBuffer(){}},routing:{resolveAgentRoute(p){routeArgs=p;return {agentId:'main',sessionKey:'group-session'};}}},mediaUnderstanding:{resolveAudioInputBudget:async()=>({enabled:true}),transcribeAudioFile:async p=>{transcribeArgs=p;return {text:'synthetic transcript'};}}};
 const out=await prepareMediaEvent(e,{runtime,cfg:{},accountId:'local',channel:'wechat-native-isolated',daemonAccountId:'daemon',retrieve:async()=>({stored:{path:'/synthetic/audio.wav',contentType:'audio/wav',size:32},stats:{}})});
 assert.equal(out.kind,'group-text');assert.deepEqual(out.mentions,message.mentions);assert.equal(out.sourceModality,'voice');assert.equal(out.media[0].kind,'audio');assert.equal(out.media[0].transcribed,true);assert.deepEqual(routeArgs.peer,{kind:'group',id:room});assert.equal(routeArgs.dmScope,'per-account-channel-peer');assert.equal(transcribeArgs.scopeContext.chatType,'group');assert.equal(transcribeArgs.scopeContext.sessionKey,'group-session');
});
