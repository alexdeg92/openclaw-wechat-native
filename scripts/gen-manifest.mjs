// Regenerates openclaw.plugin.json from the runtime config schema, so the manifest OpenClaw validates against
// can never drift from what the plugin actually accepts. Run: node scripts/gen-manifest.mjs
import {writeFileSync,readFileSync} from 'node:fs';
import {accountSchema} from '../src/policy.mjs';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
const manifest={
 id:'wechat-native-isolated',
 name:'WeChat (native Linux)',
 description:pkg.description,
 version:pkg.version,
 categories:['channels'],
 channels:['wechat-native-isolated'],
 channelConfigs:{'wechat-native-isolated':{
  label:'WeChat',
  description:'Personal WeChat through a local agent-wechat daemon on 127.0.0.1.',
  schema:{type:'object',additionalProperties:false,properties:{accounts:{type:'object',additionalProperties:accountSchema}}}}},
 configSchema:{type:'object',additionalProperties:false,properties:{}}
};
writeFileSync(new URL('../openclaw.plugin.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
console.log('openclaw.plugin.json written');
