#!/usr/bin/env node
// openclaw-wechat: setup helper for the WeChat channel plugin.
//   openclaw-wechat login    log the bot account in on the daemon, named "<agent>'s PC", QR shown in the terminal
//   openclaw-wechat doctor   check Node, OpenClaw, Docker, ffmpeg, the daemon and the channel config
// Talks only to the daemon on 127.0.0.1. Never prints tokens.
import {readFileSync,writeFileSync,existsSync,mkdtempSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';

const CHANNEL='wechat-native-isolated';
const TERMINAL=new Set(['succeeded','failed','cancelled','expired','rejected','needs_login','approval_required','challenge_required']);
const home=p=>p?.startsWith('~/')?join(homedir(),p.slice(2)):p;

function args(argv){const o={_:[]};for(let i=0;i<argv.length;i++){const a=argv[i];
 if(a.startsWith('--')){const [k,v]=a.slice(2).split('=',2);o[k]=v??(argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true);}else o._.push(a);}return o;}

function openclawConfig(){const p=home(process.env.OPENCLAW_CONFIG_PATH||'~/.openclaw/openclaw.json');
 try{return {path:p,cfg:JSON.parse(readFileSync(p,'utf8'))};}catch{return {path:p,cfg:null};}}

/** "{agent name}'s PC", from agents.entries.<agent>.name (default agent "main"). */
export function computerName(cfg,agent='main'){
 const name=cfg?.agents?.entries?.[agent]?.name??cfg?.agents?.list?.find?.(a=>a.id===agent)?.name;
 const clean=typeof name==='string'?name.replace(/[\u0000-\u001f]/g,'').trim().slice(0,60):'';
 return clean?`${clean}'s PC`:'OpenClaw PC';
}

function channelAccount(cfg,id){const accounts=cfg?.channels?.[CHANNEL]?.accounts??{};const ids=Object.keys(accounts);
 const key=id??(ids.length===1?ids[0]:undefined);return key?{key,...accounts[key]}:null;}

function tokenFrom(o,cfg){
 if(o['token-file'])return readFileSync(home(o['token-file']),'utf8').trim();
 if(process.env.AGENT_WECHAT_TOKEN)return process.env.AGENT_WECHAT_TOKEN.trim();
 const p=cfg?.secrets?.providers?.[CHANNEL]?.path;if(p)return readFileSync(home(p),'utf8').trim();
 throw Error('no daemon token: pass --token-file <file> (a token with the "login" scope)');
}

function api(base,token){const u=new URL(base);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('daemon URL must be http://127.0.0.1:<port>/');
 return async(path,init={})=>{const r=await fetch(new URL(path,u),{...init,redirect:'error',headers:{Authorization:'Bearer '+token,...(init.body?{'Content-Type':'application/json'}:{}),...init.headers}});
  if(!r.ok){const e=Error(`daemon ${init.method??'GET'} ${path.split('?')[0]} -> HTTP ${r.status}`);e.status=r.status;throw e;}return r;};}

// Minimal PNG decoder (gray/RGB/palette/alpha, 1-8 bit, non-interlaced) so the QR can be drawn without deps.
export function decodePng(buf){
 if(buf.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('not a PNG');
 let w,h,depth,color,pal=null,idat=[];for(let i=8;i<buf.length;){const len=buf.readUInt32BE(i),type=buf.toString('ascii',i+4,i+8),d=buf.subarray(i+8,i+8+len);
  if(type==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);depth=d[8];color=d[9];if(d[12])throw Error('interlaced PNG');}
  else if(type==='PLTE')pal=d;else if(type==='IDAT')idat.push(d);else if(type==='IEND')break;i+=12+len;}
 const ch={0:1,2:3,3:1,4:2,6:4}[color];if(!ch||![1,2,4,8].includes(depth)||(color!==0&&color!==3&&depth!==8))throw Error('unsupported PNG');
 const stride=Math.ceil(w*ch*depth/8),bpp=Math.max(1,ch*depth/8),raw=inflateSync(Buffer.concat(idat)),out=new Uint8Array(w*h);let prev=new Uint8Array(stride);
 for(let y=0;y<h;y++){const f=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)),cur=new Uint8Array(stride);
  for(let x=0;x<stride;x++){const a=x>=bpp?cur[x-bpp]:0,b=prev[x],c=x>=bpp?prev[x-bpp]:0,p=a+b-c;
   const pr=Math.abs(p-a)<=Math.abs(p-b)&&Math.abs(p-a)<=Math.abs(p-c)?a:Math.abs(p-b)<=Math.abs(p-c)?b:c;
   cur[x]=(line[x]+[0,a,b,(a+b)>>1,pr][f])&255;}
  for(let x=0;x<w;x++){let v;
   if(depth<8){const bit=x*depth,s=(cur[bit>>3]>>(8-depth-(bit&7)))&((1<<depth)-1);v=color===3?s:s*255/((1<<depth)-1);}
   else v=cur[x*ch];
   if(color===3){const k=v*3;v=pal?(pal[k]+pal[k+1]+pal[k+2])/3:v;}
   else if(color===2||color===6)v=(cur[x*ch]+cur[x*ch+1]+cur[x*ch+2])/3;
   out[y*w+x]=v;}
  prev=cur;}
 return {w,h,px:out};
}

/** QR PNG -> terminal text using half blocks; module size taken from the top-left finder pattern (7 modules). */
export function qrToText({w,h,px}){
 const dark=(x,y)=>px[y*w+x]<128;let x0=-1,y0=-1;
 outer:for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(dark(x,y)){x0=x;y0=y;break outer;}
 if(x0<0)throw Error('empty QR');let run=0;while(x0+run<w&&dark(x0+run,y0))run++;
 const m=run/7,n=Math.round((w-2*x0)/m),cell=(i,j)=>i>=0&&j>=0&&i<n&&j<n&&dark(Math.floor(x0+(i+0.5)*m),Math.floor(y0+(j+0.5)*m));
 const lines=[];for(let j=-2;j<n+2;j+=2){let s='';for(let i=-2;i<n+2;i++){const t=cell(i,j),b=cell(i,j+1);s+=t&&b?' ':t?'▄':b?'▀':'█';}lines.push(s);}
 return lines.join('\n');
}

async function login(o){
 const {cfg}=openclawConfig(),acct=channelAccount(cfg,o.account);
 const base=o.base??acct?.baseUrl??'http://127.0.0.1:6174/',account=o['daemon-account']??acct?.daemonAccountId;
 if(!account)throw Error('unknown daemon account: pass --daemon-account <id> or configure channels.'+CHANNEL);
 const name=o.name??computerName(cfg,o.agent??'main'),call=api(base,tokenFrom(o,cfg)),acc='/v1/accounts/'+encodeURIComponent(account);
 console.log(`Logging in as "${name}"…`);
 const body={computerName:name,strategy:o['saved-only']?'saved-device':'auto',allowQr:!o['saved-only'],timeoutSeconds:Number(o.timeout??300)};
 let op;try{op=await (await call(acc+'/auth/login',{method:'POST',body:JSON.stringify(body),headers:{'Idempotency-Key':'openclaw-wechat-'+randomUUID()}})).json();}
 catch(e){if(e.status===403)throw Error('this daemon token is not allowed to log in. Use a token with the "login" scope (--token-file).');throw e;}
 let shown=0;const until=Date.now()+(body.timeoutSeconds+35)*1000;
 while(!TERMINAL.has(op.state)&&Date.now()<until){
  const gen=Number(op.result?.qrGeneration??0);
  if(op.result?.qrAvailable===true&&gen>shown){shown=gen;
   const png=Buffer.from(await (await call(`${acc}/operations/${encodeURIComponent(op.id)}/qr?generation=${gen}`)).arrayBuffer());
   const dir=mkdtempSync(join(tmpdir(),'wechat-qr-')),file=join(dir,`qr-${gen}.png`);writeFileSync(file,png,{mode:0o600});
   try{console.log('\n'+qrToText(decodePng(png))+'\n');}catch{}
   console.log(`Scan with the bot's WeChat (Me → scan) and approve "${name}". QR image: ${file}`);}
  if(op.result?.lanChallenge==='waiting_for_phone')console.log('WeChat wants a local network check: keep the phone on a network that can reach this computer.');
  await new Promise(r=>setTimeout(r,800));
  op=await (await call(`${acc}/operations/${encodeURIComponent(op.id)}`)).json();
 }
 if(op.state==='succeeded'){console.log(`✔ Logged in. WeChat now lists this device as "${name}".`);return 0;}
 console.error(`✖ Login ${TERMINAL.has(op.state)?op.state.replace(/_/g,' '):'timed out'}.`);return 1;
}

function have(cmd,a=['--version']){try{return execFileSync(cmd,a,{stdio:['ignore','pipe','ignore'],timeout:10000}).toString().split('\n')[0].trim();}catch{return null;}}
async function doctor(o){
 const {path,cfg}=openclawConfig(),acct=channelAccount(cfg,o.account),rows=[];const ok=(c,label,hint)=>rows.push([c?'✔':'✖',label,c?'':hint]);
 const [maj,min]=process.versions.node.split('.').map(Number);ok(maj>24||(maj===24&&min>=16)||maj>=26,`Node ${process.versions.node}`,'need Node 24.16+');
 const oc=have('openclaw');ok(!!oc,`OpenClaw ${oc??'not found'}`,'install OpenClaw: npm i -g openclaw');
 ok(!!have('docker'),'Docker','install Docker to run the agent-wechat daemon');
 ok(!!have('ffmpeg',['-version']),'ffmpeg','optional: animated stickers fall back to one frame');
 ok(!!cfg,`OpenClaw config ${path}`,'run openclaw onboard first');
 ok(!!acct,`channels.${CHANNEL} account`,'add the channel config (see README → Configuration)');
 const base=o.base??acct?.baseUrl??'http://127.0.0.1:6174/';let up=false;try{up=(await fetch(new URL('/health',base),{signal:AbortSignal.timeout(3000)})).ok;}catch{}
 ok(up,`daemon reachable at ${base}`,'start the agent-wechat daemon (loopback only)');
 if(cfg)ok(true,`device name on next login: "${computerName(cfg,o.agent??'main')}"`,'');
 for(const [s,l,h] of rows)console.log(`${s} ${l}${h?'  → '+h:''}`);return rows.some(r=>r[0]==='✖'&&!r[1].startsWith('ffmpeg'))?1:0;
}

const HELP=`openclaw-wechat — setup helper for the OpenClaw WeChat channel

  openclaw-wechat doctor                 check prerequisites, daemon and config
  openclaw-wechat version                print the version
  openclaw-wechat login [options]        log the bot in on the daemon (QR in terminal)
      --name "<text>"        device name shown in WeChat (default: "<agent>'s PC")
      --agent <id>           OpenClaw agent whose name to use (default: main)
      --account <key>        channel account key in openclaw.json (if more than one)
      --daemon-account <id>  daemon account ID (default: from openclaw.json)
      --token-file <file>    daemon token with the "login" scope
      --base <url>           daemon URL (default: from openclaw.json or http://127.0.0.1:6174/)
      --saved-only           reuse saved device trust only; never show a QR
`;
if(import.meta.url===`file://${process.argv[1]}`||process.argv[1]?.endsWith('openclaw-wechat')){
 const o=args(process.argv.slice(2)),cmd=o._[0];
 if(o.version||cmd==='version'){console.log(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);process.exit(0);}
 const run=cmd==='login'?login:cmd==='doctor'?doctor:null;
 if(!run||o.help){console.log(HELP);process.exit(run||o.help?0:1);}
 run(o).then(c=>process.exit(c),e=>{console.error('✖ '+e.message);process.exit(1);});
}
