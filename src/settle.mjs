// Queued/submitting are custody, not acceptance. GET-only bounded settlement.
const PENDING=new Set(['queued','submitting']);
/** @param {any} receipt @param {any} lookup @param {any} matches @param {any} options */
export async function settleQueued(receipt,lookup,matches,{attempts=16,delay=()=>new Promise(r=>setTimeout(r,500)),signal}={}){
 if(!matches(receipt)||!PENDING.has(receipt.state))return receipt;
 for(let i=0;i<attempts;i++){if(signal?.aborted)throw Error('send aborted');await delay();if(signal?.aborted)throw Error('send aborted');const next=await lookup();if(!matches(next)||next.id!==receipt.id)throw Error('receipt identity mismatch');receipt=next;if(!PENDING.has(receipt.state))return receipt;}return receipt;
}
