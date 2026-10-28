import {test} from 'node:test';import assert from 'node:assert/strict';import built from '../build/plugin.js';
// Guard for the P1 fix: without this the host stamps replyToId on finals and the durable send fails before sendText.
test('reply threading is off and explicit reply tags are dropped',()=>{const p=built.makePlugin({},async()=>{throw Error('no network')});assert.equal(p.threading.resolveReplyToMode(),'off');assert.equal(p.threading.allowExplicitReplyTagsWhenOff,false);});
