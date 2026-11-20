import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCutoff, clampReplayAfter, isUnexpiredRelayEvent } from './replayFreshness.js';

const now = Date.parse('2026-11-20T23:16:45Z');
const day = 86400;
test('expired June cursor is clamped to the 24-hour relay retention', () => {
  const june='2026-06-27T13:19:54.164Z';
  assert.equal(replayCutoff(day,now),'2026-11-19T23:16:45.000Z');
  assert.equal(clampReplayAfter(june,day,now),replayCutoff(day,now));
  assert.equal(clampReplayAfter(null,day,now),replayCutoff(day,now));
  assert.equal(clampReplayAfter('2026-11-20T23:10:00Z',day,now),
    '2026-11-20T23:10:00.000Z');
});

test('old tool calls are not dispatchable even if physical TTL cleanup is pending',()=>{
  const june={id:'old-command',create_time:'2026-06-27T13:19:54.164Z',
    expires_at:'2026-06-28T13:19:54.164Z',data:{tool_call:{name:'RUN_COMMAND'}}};
  assert.equal(isUnexpiredRelayEvent(june,day,now),false);
  assert.equal(isUnexpiredRelayEvent({...june,create_time:'2026-11-20T23:15:00Z'},day,now),false);
  assert.equal(isUnexpiredRelayEvent({id:'new-command',
    create_time:'2026-11-20T23:15:00Z',expires_at:'2026-11-21T23:15:00Z'},day,now),true);
  assert.equal(isUnexpiredRelayEvent({id:'new-command',
    create_time:'2026-11-20T23:15:00Z'},day,now),true);
});
