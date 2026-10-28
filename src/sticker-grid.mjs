// Animated sticker -> one PNG grid of evenly spaced frames on white, so vision models that only read frame 0
// (often blank for "peek-in" stickers) see the whole animation. Static or unreadable input returns null and the
// caller keeps the original bytes. Downloads only; runs FFmpeg on a private temp copy with a timeout and output cap.
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const GRID={cols:4,rows:2,cell:160,timeoutMs:15_000,maxOutBytes:4*1024*1024};
const ANIMATED=/^image\/(gif|webp)$/;

/** Fallback frame estimate when the daemon gives none: GIF graphic control blocks; webp ANMF chunk test. */
export function countFrames(buf,contentType){
 if(contentType==='image/gif'){let n=0;for(let i=0;i+1<buf.length;i++)if(buf[i]===0x21&&buf[i+1]===0xf9)n++;return n;}
 if(contentType==='image/webp')return buf.includes(Buffer.from('ANMF'))?2:1;
 return 1;
}

const run=(args,timeoutMs)=>new Promise((res,rej)=>execFile('ffmpeg',args,{timeout:timeoutMs,maxBuffer:64*1024},e=>e?rej(e):res()));

/** @returns {Promise<{buffer:Buffer,contentType:'image/png',frames:number,shown:number}|null>} */
export async function stickerGrid(buf,contentType,{frames=countFrames(buf,contentType),exec=run,grid=GRID}={}){
 if(!ANIMATED.test(contentType)||!(frames>1))return null;
 const tiles=grid.cols*grid.rows,step=Math.max(1,Math.ceil(frames/tiles)),shown=Math.min(tiles,Math.ceil(frames/step));
 const dir=mkdtempSync(join(tmpdir(),'wx-sticker-'));
 try{const input=join(dir,'in'),output=join(dir,'out.png');writeFileSync(input,buf,{mode:0o600});
  // White background drawn from the same stream: an overlay on a separate color= source desyncs and yields frame 0 only.
  const c=grid.cell;
  const filter=`[0:v]format=rgba,select='not(mod(n\\,${step}))',split[a][b];[a]drawbox=c=white:t=fill[bg];`+
   `[bg][b]overlay=format=auto,format=rgb24,scale=${c}:${c}:force_original_aspect_ratio=decrease,`+
   `pad=${c}:${c}:-1:-1:white,tile=${grid.cols}x${grid.rows}:padding=4:color=white`;
  await exec(['-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','file','-format_whitelist','gif,webp_pipe',
   '-f',contentType==='image/gif'?'gif':'webp_pipe','-i',input,'-filter_complex',filter,'-fps_mode','passthrough','-frames:v','1',output],grid.timeoutMs);
  const out=readFileSync(output);
  if(!out.length||out.length>grid.maxOutBytes||out.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return null;
  return {buffer:out,contentType:'image/png',frames,shown};
 }catch{return null;}
 finally{rmSync(dir,{recursive:true,force:true});}
}
