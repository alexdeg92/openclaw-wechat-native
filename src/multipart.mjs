// Stable UTF-16 chunks at the advertised host limit; never cut a surrogate pair.
export const TEXT_CHUNK_LIMIT=4000;
export function textParts(text){
 if(typeof text!=='string'||!text.length)throw Error('Plain text required');
 const parts=[];let offset=0;
 while(offset<text.length){let end=Math.min(offset+TEXT_CHUNK_LIMIT,text.length);
  if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1])&&/[\uDC00-\uDFFF]/u.test(text[end]))end--;
  parts.push(text.slice(offset,end));offset=end;
 }return parts;
}
export function messageReceipt(results){const parts=results.map((r,index)=>({platformMessageId:r.messageId,kind:'text',index}));return {primaryPlatformMessageId:parts[0].platformMessageId,platformMessageIds:parts.map(p=>p.platformMessageId),parts,sentAt:Date.now()};}
