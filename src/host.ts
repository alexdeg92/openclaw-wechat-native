import type { PluginRuntime } from 'openclaw/plugin-sdk/plugin-runtime';
import type { BuildChannelInboundEventContextParams } from 'openclaw/plugin-sdk/channel-inbound';
import { defineStableChannelIngressIdentity } from 'openclaw/plugin-sdk/channel-ingress-runtime';
const identity = defineStableChannelIngressIdentity({key:'wechat-peer-id',normalize:(v:string)=>v.trim()===v&&v.length?v:undefined,sensitivity:'pii'});
type Inbound = PluginRuntime['channel']['inbound'];
type Resolve = Parameters<Inbound['ingress']['resolve']>[0];
// Must receive the runtime injected into the SAME active registered plugin.
// No standalone context builder, no fabricated participant evidence.
export async function admitContext(runtime: PluginRuntime, facts: BuildChannelInboundEventContextParams,
  policy: Pick<Resolve,'allowFrom'|'readStoreAllowFrom'|'accessGroups'> & {dmPolicy?:'allowlist'|'disabled';groupAllowed?:boolean},
  binding: {agentId:string;sessionKey:string;peerId:string;senderId?:string;kind?:'direct'|'group';messageId:string;accountId:string;nativeChannelId:string}) {
  if(facts.channel!=='wechat-native-isolated'||facts.accountId!==binding.accountId||facts.messageId!==binding.messageId)throw Error('context scope mismatch');
  const kind=binding.kind??'direct',senderId=binding.senderId??binding.peerId;
  if(facts.sender.id!==senderId || facts.conversation.kind!==kind || facts.conversation.id!==binding.peerId || facts.route.agentId!==binding.agentId || facts.route.routeSessionKey!==binding.sessionKey || (facts.route.dispatchSessionKey && facts.route.dispatchSessionKey!==binding.sessionKey) || (facts.reply.nativeChannelId??facts.conversation.nativeChannelId)!==binding.nativeChannelId || facts.message.inboundEventKind!=='user_request')throw Error('binding mismatch');
  if(kind==='group'&&(!policy.groupAllowed||facts.access?.mentions?.wasMentioned!==true))return null;
  const result=await runtime.channel.inbound.ingress.resolve({
    channelId:facts.channel,accountId:binding.accountId,identity,
    subject:{stableId:senderId},conversation:{kind,id:binding.peerId},
    contextBinding:{agentId:binding.agentId,sessionKey:binding.sessionKey,messageId:binding.messageId,inboundEventKind:'user_request',nativeChannelId:binding.nativeChannelId},
    event:{kind:'message',authMode:'inbound',mayPair:false},
    policy:{dmPolicy:policy.dmPolicy??'allowlist',groupPolicy:kind==='group'&&policy.groupAllowed?'open':'disabled',...(kind==='group'?{activation:{requireMention:true,allowTextCommands:false,allowedImplicitMentionKinds:[]}}:{})},
    allowFrom:policy.allowFrom,readStoreAllowFrom:policy.readStoreAllowFrom,accessGroups:policy.accessGroups,
    ...(kind==='group'?{mentionFacts:{canDetectMention:true,wasMentioned:facts.access?.mentions?.wasMentioned===true,hasAnyMention:true},route:{id:binding.peerId,kind:'route' as const,configured:true,matched:true,allowed:policy.groupAllowed===true}}:{}),
  });
  if(result.ingress.admission!=='dispatch')return null;
  return runtime.channel.inbound.buildContext({...facts,channelIngress:result});
}
