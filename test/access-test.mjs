import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
import {parseAccessCommand,stripMentions,mergeAccess,changeAccess,readAccess,readNames} from '../src/access.mjs';
import {decideAccessCommand,isOwnerEnable,formatAccessList} from '../src/access-command.mjs';
const base=()=>({selfId:'Self',ownerIds:['O'],allowFrom:['O','P'],groups:{'r@chatroom':{requireMention:true}},groupPolicy:'allowlist'});
test('only whole-message command words trigger; ordinary chat does not',()=>{
 for(const [t,op] of [['@Timmy allow @Kevin Lee ','allow'],['Timmy, add @K ','allow'],['@Timmy remove @K !','remove'],['@Timmy enable this group','enable'],['turn off this chat','disable'],["@Timmy who's allowed?",'list'],['allowlist','list']])assert.equal(parseAccessCommand(t)?.op,op,t);
 for(const t of ['allow me to explain','can you add this to the list','@Timmy please remove the stain from my shirt','enable dark mode','who is the owner'])assert.equal(parseAccessCommand(t),null,t);});
test('mentions with spaces are stripped',()=>assert.equal(stripMentions('@Timmy allow @Kevin Lee Jr  now'),'allow now'));
test('overlay merges, blocks non-owners only, never adds self, and can disable base groups',()=>{
 const a=mergeAccess(base(),{allowFrom:['N','Self'],blockFrom:['P','O'],groups:['x@chatroom'],disabledGroups:['r@chatroom']});
 assert.deepEqual(a.allowFrom,['O','N']);assert.deepEqual(Object.keys(a.groups),['x@chatroom']);
 mergeAccess(a,{allowFrom:[],blockFrom:[],groups:[],disabledGroups:[]});assert.deepEqual(a.allowFrom,['O','P']);assert.deepEqual(Object.keys(a.groups),['r@chatroom']);});
test('changes persist atomically and are idempotent; corrupt or invalid files fail closed',()=>{const d=mkdtempSync(tmpdir()+'/acc-');
 assert.equal(changeAccess(d,'allow',['N']).changed,true);assert.equal(changeAccess(d,'allow',['N']).changed,false);
 assert.equal(changeAccess(d,'remove',['N']).changed,true);assert.deepEqual(readAccess(d),{allowFrom:[],blockFrom:['N'],groups:[],disabledGroups:[]});
 writeFileSync(d+'/access.json','{nope');assert.deepEqual(readAccess(d).blockFrom,['N'],'last good value kept');
 writeFileSync(d+'/access.json',JSON.stringify({allowFrom:['x@chatroom']}));assert.deepEqual(readAccess(d).allowFrom,[]);assert.throws(()=>changeAccess(d,'allow',['N']),/refusing/);
 const d2=mkdtempSync(tmpdir()+'/acc-');assert.throws(()=>changeAccess(d2,'allow',['bad id']));});
const run=(a,e,message)=>decideAccessCommand({a,e,message,label:async id=>'Name-'+id,roomLabel:async r=>'Room-'+r});
const tag=(...ids)=>({mentions:{state:'known',self:true,source:'msgsource.atuserlist',userIds:['Self',...ids]}});
const g=(sender,text)=>({senderId:sender,kind:'group-text',peerId:'r@chatroom',text});
test('decide: owner only; a group command needs an explicit @tag plus a tagged person; nothing is applied here',async()=>{
 assert.equal(await run(base(),g('P','@Timmy\u2005allow @N\u2005'),tag('N')),null);
 assert.equal(await run(base(),g('O','@Timmy\u2005allow'),tag()),null,'no person tagged = ordinary chat');
 assert.equal(await run(base(),g('O','approve'),{mentions:{state:'known',self:true,source:'quote-reply',userIds:[]}}),null,'quote-reply is not a command');
 assert.equal(await run(base(),g('O','remove'),{mentions:{state:'known',self:true,source:'quote-reply',userIds:['N']}}),null);
 assert.match((await run(base(),g('O','@Timmy\u2005remove @O\u2005'),tag('O'))).text,/owners can't be removed/);
 const a=base(),r=await run(a,g('O','@Timmy\u2005allow @N\u2005'),tag('N','Self','notify@all'));
 assert.deepEqual([r.op,r.ids],['allow',['N']]);assert.match(r.text,/Name-N can now message/);assert.ok(!a.allowFrom.includes('N'),'decide must not apply');
 assert.equal(await run(base(),g('O',"@Timmy\u2005who's allowed"),tag()),null,'list is never posted to a group');});
test('decide: in private chat only the list works; one-word answers stay ordinary conversation',async()=>{
 const dm=t=>({senderId:'O',kind:'direct-text',peerId:'O',text:t});
 for(const t of ['add','Approve!','allowed','access','block','remove','please add.','allow'])assert.equal(await run(base(),dm(t),{}),null,t);
 const list=(await run(base(),dm("who's allowed?"),{})).text;
 assert.ok(list.endsWith('\n\nPRIVATE CHATS\n• You\n• Name-P\n\nGROUP CHATS\n• Room-r@chatroom\n\nIn groups, I reply when @-mentioned or quote-replied.'),list);
 assert.match(list,/exactly the list below/);
 assert.equal(await run(base(),{senderId:'P',kind:'direct-text',peerId:'P',text:"who's allowed"},{}),null);});
test('an unreadable access file is never overwritten and keeps the last good value',()=>{const d=mkdtempSync(tmpdir()+'/acc-');
 changeAccess(d,'remove',['Spammer']);assert.deepEqual(readAccess(d).blockFrom,['Spammer']);
 writeFileSync(d+'/access.json','{corrupt');const before=readFileSync(d+'/access.json','utf8');
 assert.deepEqual(readAccess(d).blockFrom,['Spammer']);assert.throws(()=>changeAccess(d,'allow',['N']),/refusing/);assert.equal(readFileSync(d+'/access.json','utf8'),before);});
test('isOwnerEnable requires owner, text, self-mention and the enable command',()=>{const m=o=>({threadId:'z@chatroom',senderId:'O',type:1,body:'@T enable this group',mentions:{state:'known',self:true,source:'msgsource.atuserlist',userIds:['Self']},...o});
 assert.equal(isOwnerEnable(base(),m()),true);for(const o of [{senderId:'P'},{type:3},{mentions:{state:'known',self:false,userIds:[]}},{mentions:{state:'known',self:true,source:'quote-reply',userIds:[]}},{mentions:{state:'known',self:true,source:'quote-reply',userIds:[]}},{body:'hi'},{threadId:'O'}])assert.equal(isOwnerEnable(base(),m(o)),false);
 assert.equal(isOwnerEnable({...base(),groupPolicy:'disabled'},m()),false);});
test('list: unnamed groups show members (not the owner or bot); named groups keep their name',async()=>{
 const a={...base(),allowFrom:['O','P','Q'],groups:{'n@chatroom':{requireMention:true},'u@chatroom':{requireMention:true},'e@chatroom':{requireMention:true}}};
 const members={'u@chatroom':[{id:'O',name:'Owner'},{id:'Self',name:'Bot'},{id:'A',name:'Ann'},{id:'B',name:'Bo'},{id:'C',name:'Cy'},{id:'D',name:'Di'}],'e@chatroom':[]};
 const r=await decideAccessCommand({a,e:{senderId:'O',kind:'direct-text',peerId:'O',text:"who's allowed"},message:{},label:async id=>'Name-'+id,
  roomLabel:async room=>room==='n@chatroom'?'读书会':room,roomMembers:async room=>members[room]});
 assert.ok(r.text.endsWith('PRIVATE CHATS\n• You\n• Name-P\n• Name-Q\n\nGROUP CHATS\n• 读书会\n• Group with Ann, Bo, Cy +1\n• Unnamed group\n\nIn groups, I reply when @-mentioned or quote-replied.'),r.text);
 assert.equal(formatAccessList([],[]),'PRIVATE CHATS\n• You\n\nGROUP CHATS\n• none\n\nIn groups, I reply when @-mentioned or quote-replied.');});
test('list: owner-written real names appear in brackets; bad names file is ignored',async()=>{
 const d=mkdtempSync(tmpdir()+'/acc-');writeFileSync(d+'/names.json',JSON.stringify({P:'Li Wei','x@chatroom':'Room',Q:42,R:' '}));
 assert.deepEqual(readNames(d),{P:'Li Wei'});writeFileSync(d+'/names.json','{bad');assert.deepEqual(readNames(d),{});
 const r=await decideAccessCommand({a:base(),e:{senderId:'O',kind:'direct-text',peerId:'O',text:"who's allowed"},message:{},label:async id=>'小明-'+id,roomLabel:async()=>'读书会',realNames:{P:'Li Wei'}});
 assert.match(r.text,/\n• 小明-P \(Li Wei\)\n/);});
test('list command tolerates emoji, lead-ins, curly quotes, merged lines and the how\'s typo; other commands stay strict',()=>{
 for(const t of ["I mean who's allowed 😂","How's allowed","How's allowed\nI mean who's allowed 😂","who’s allowed?","ok so who is allowed 👍🏻"])assert.deepEqual(parseAccessCommand(t),{op:'list'},t);
 for(const t of ["allow 😂","I mean allow","hi\nallow","who's allowed to drive","how's it going"])assert.notDeepEqual(parseAccessCommand(t),{op:'allow'},t);
 for(const t of ["who's allowed to drive","how's it going","allowed"])assert.equal(parseAccessCommand(t),null,t);});
