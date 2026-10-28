// Read-only installed-host reproduction: never attaches to the running Gateway.
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {n:PluginInstance}=await import((process.env.OPENCLAW_DIST??new URL('../node_modules/openclaw/dist/',import.meta.url).pathname)+'plugin-setup-module-CbcpILjg.mjs');
test('installed host excludes long-lived account custody but blocks on independent agent registry work',async()=>{
 const instance=new PluginInstance('synthetic-lifecycle');
 const account=instance.retainConsumer(undefined,undefined,'custody');
 assert.equal(instance.retainedWorkCount,0);
 await instance.waitForRetainedWork(new AbortController().signal,true);
 const releaseAgentRegistry=instance.retainWork();
 assert.equal(instance.retainedWorkCount,1);
 account.release(); // Even physical account cleanup cannot release agent registry custody.
 assert.equal(instance.retainedWorkCount,1);
 const abort=new AbortController();const waiting=instance.waitForRetainedWork(abort.signal,true);
 abort.abort(Error('isolated drain deadline'));await assert.rejects(waiting,/isolated drain deadline/);
 releaseAgentRegistry();assert.equal(instance.retainedWorkCount,0);
 await instance.waitForRetainedWork(new AbortController().signal,true);
 await instance.dispose();
});
