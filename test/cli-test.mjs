import test from 'node:test';import assert from 'node:assert/strict';import {deflateSync} from 'node:zlib';
import {computerName,decodePng,qrToText} from '../bin/openclaw-wechat.mjs';
test('device name is "<agent name>\'s PC" from the OpenClaw config, with a safe fallback',()=>{
 assert.equal(computerName({agents:{entries:{main:{name:'Timmy'}}}}),"Timmy's PC");
 assert.equal(computerName({agents:{entries:{nyx:{name:'Nyx'}}}},'nyx'),"Nyx's PC");
 assert.equal(computerName({agents:{list:[{id:'main',name:'Ada'}]}}),"Ada's PC");
 assert.equal(computerName({}),'OpenClaw PC');
 assert.equal(computerName({agents:{entries:{main:{name:'Ti\u0000m\nmy  '}}}}),"Timmy's PC");});
function png(w,h,f){const crc=b=>{let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return ~c>>>0;};
 const chunk=(t,d)=>{const b=Buffer.alloc(12+d.length);b.writeUInt32BE(d.length,0);b.write(t,4,'ascii');d.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,8+d.length)),8+d.length);return b;};
 const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=0;
 const raw=Buffer.alloc((w+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)raw[y*(w+1)+1+x]=f(x,y)?0:255;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
test('QR PNG renders to half-block text with the finder pattern intact',()=>{
 const m=4,q=4,n=21,finder=(i,j)=>{const a=Math.max(Math.abs(i-3),Math.abs(j-3));return a!==2&&a<=3;};
 const dark=(x,y)=>{const i=Math.floor(x/m)-q,j=Math.floor(y/m)-q;return i>=0&&j>=0&&i<7&&j<7&&finder(i,j);};
 const img=decodePng(png((n+2*q)*m,(n+2*q)*m,dark));assert.equal(img.w,(n+2*q)*m);
 const lines=qrToText(img).split('\n');assert.ok(lines.length>=12);assert.match(lines[1],/^██[ ▀▄]{7}/);});
