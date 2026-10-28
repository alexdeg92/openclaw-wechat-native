import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makePlugin} from '../build/plugin.js';
const ID='wechat-native-isolated';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('shutdown deadline exceeded')),1500);t.unref()})]);
function config(baseUrl){return {channels:{[ID]:{accounts:{local:{enabled:true,startAfter:'0',daemonAccountId:'daemon',selfId:'Self',allowFrom:['PeerX'],verifiedPeer:'PeerX',baseUrl,token:'synthetic',journalDir:mkdtempSync(tmpdir()+'/wechat-lifecycle-')}}}}}}
function start(plugin,cfg,abort,status){return plugin.gateway.startAccount({cfg,accountId:'local',account:plugin.config.resolveAccount(cfg,'local'),abortSignal:abort.signal,setStatus:s=>status.push(s.running)})}
for(const mode of ['headers','stalled-body'])test('abort settles real fetch '+mode+' and releases account ownership',async()=>{
 const entered=deferred(),closed=deferred();let posts=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;req.on('close',()=>closed.resolve());if(mode==='stalled-body'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': idle\n\n')}entered.resolve()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const cfg=config('http://127.0.0.1:'+server.address().port+'/'),plugin=makePlugin({}),status=[],abort=new AbortController();const task=start(plugin,cfg,abort,status);const settled=task.then(()=>null,e=>e);await entered.promise;abort.abort();const error=await bounded(settled);assert.equal(error?.name,'AbortError');await bounded(closed.promise);assert.deepEqual(status,[true,false]);assert.equal(posts,0);
 const second=new AbortController();second.abort();const again=await bounded(start(plugin,cfg,second,[]).then(()=>null,e=>e));assert.notEqual(again?.message,'single owner required');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
});
test('abort during host dispatch preserves custody until physical settlement; no replay or ACK',async()=>{
 const entered=deferred(),dispatch=deferred();let posts=0,acks=0;const abort=new AbortController(),status=[];
 const event={cursor:'1',kind:'message.committed',data:{origin:'live',direction:'incoming',messageId:'M',threadId:'PeerX'}};
 const message={id:'M',accountId:'daemon',threadId:'PeerX',senderId:'PeerX',type:1,direction:'incoming',body:'synthetic',media:[]};
 const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'agent:main:wechat:synthetic'})},inbound:{ingress:{resolve:async()=>({ingress:{admission:'dispatch'}})},buildContext:x=>x,dispatch:async()=>{entered.resolve();return dispatch.promise}}}};
 const fetcher=async(url,init)=>{if(init.signal.aborted)throw init.signal.reason;if(url.pathname.endsWith('/events/stream'))return {ok:true,body:(async function*(){yield new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n')})()};if(url.pathname.endsWith('/messages/M'))return {ok:true,json:async()=>message};if(url.pathname.endsWith('/ack'))acks++;if(init.method==='POST')posts++;throw Error('unexpected request')};
 const cfg=config('http://127.0.0.1:6174/'),plugin=makePlugin(runtime,fetcher);let finished=false;const task=start(plugin,cfg,abort,status).then(()=>{finished=true},e=>{finished=true;return e});await entered.promise;abort.abort();await new Promise(r=>setImmediate(r));assert.equal(finished,false);assert.deepEqual(status,[true]);dispatch.reject(Error('synthetic custody failure'));assert.match((await bounded(task)).message,/custody failure/);assert.deepEqual(status,[true,false]);assert.equal(posts,0);assert.equal(acks,0);const rows=readFileSync(cfg.channels[ID].accounts.local.journalDir+'/custody.jsonl','utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(r=>r.type),['intent']);
});
