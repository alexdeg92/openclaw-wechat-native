import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
import {makePacer,delayFor,SendCapError,PACING_DEFAULTS} from '../src/pacing.mjs';
import {Journal,Adapter} from '../src/core.mjs';
test('delay grows with length, jitters ±20%, and stays within [min,max]',()=>{
 assert.equal(delayFor(0,PACING_DEFAULTS,()=>0.5),1200);
 assert.equal(delayFor(50,PACING_DEFAULTS,()=>0.5),2200);
 assert.equal(delayFor(10_000,PACING_DEFAULTS,()=>1),4000);
 assert.equal(delayFor(0,PACING_DEFAULTS,()=>0),1200,'never below min');
 assert.equal(delayFor(50,PACING_DEFAULTS,()=>0),1760);});
test('daily cap refuses after N sends, resets the next UTC day, and survives a restart',async()=>{
 const d=mkdtempSync(tmpdir()+'/pace-');let t=Date.parse('2026-10-28T10:00:00Z');const slept=[];
 const mk=()=>makePacer(d,{dailyCap:2},{now:()=>t,sleep:async ms=>{slept.push(ms);},random:()=>0.5});
 let pace=mk();await pace(10);await pace(10);
 await assert.rejects(pace(10),SendCapError);
 pace=mk();await assert.rejects(pace(10),SendCapError,'count persisted across restart');
 assert.deepEqual(JSON.parse(readFileSync(d+'/pacing.json','utf8')),{day:'2026-10-28',count:2});
 t=Date.parse('2026-10-29T00:00:01Z');await pace(10);assert.equal(slept.length,3);});
test('maxDelayMs 0 disables the delay and dailyCap 0 disables the cap',async()=>{
 const d=mkdtempSync(tmpdir()+'/pace-');const slept=[];const pace=makePacer(d,{maxDelayMs:0,dailyCap:0},{sleep:async ms=>{slept.push(ms);}});
 for(let i=0;i<5;i++)assert.equal(await pace(100),0);assert.equal(slept.length,0);});
test('a capped text send fails before any send intent is journaled and never reaches the daemon',async()=>{
 const d=mkdtempSync(tmpdir()+'/pace-');const j=new Journal(d);
 const a=new Adapter({daemonAccountId:'acc',accountId:'local',selfId:'Self',allowFrom:['P'],startAfter:'0'},j);
 a.gate=async()=>{throw new SendCapError(1);};let posted=0;
 await assert.rejects(a.send({peerId:'P',text:'hi',logicalId:'L1'},{postSend:async()=>{posted++;return {id:'x'};}}),SendCapError);
 assert.equal(posted,0);assert.equal(j.rows.some(r=>r.type==='send-intent'),false);});
