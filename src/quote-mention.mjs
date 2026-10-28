// A group quote-reply to one of the bot's own messages addresses the bot, like an @mention (Discord-style implicit
// mention). Normalized once, before every admission gate, by marking the message's mention facts as self-mentioned.
import {isRoom} from './policy.mjs';
export function quotesSelf(a,message){const q=message?.quote;return !!q&&q.senderId===a.selfId&&q.state!=='recalled';}
export function withQuoteMention(a,message){
 if(!isRoom(message?.threadId)||!quotesSelf(a,message)||(message.mentions?.state==='known'&&message.mentions.self===true))return message;
 const ids=message.mentions?.state==='known'&&Array.isArray(message.mentions.userIds)?message.mentions.userIds:[];
 return {...message,mentions:{state:'known',userIds:ids,self:true,all:message.mentions?.all??null,source:'quote-reply'}};
}
