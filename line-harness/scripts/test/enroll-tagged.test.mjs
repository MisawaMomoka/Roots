import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTargets, enrollTagged } from '../enroll-tagged.mjs';

test('enroll-tagged: タグ持ち・フォロー中・未登録の人だけ登録し、dry-run は書き込まない', async () => {
  const friends = [
    { id: 'f-1', displayName: '未登録', isFollowing: true },
    { id: 'f-2', displayName: '登録済み', isFollowing: true },
    { id: 'f-3', displayName: 'ブロック中', isFollowing: false },
  ];
  assert.deepEqual(pickTargets(friends, [{ friendId: 'f-2' }]).map((f) => f.id), ['f-1']);
  const writes = [];
  const api = async (method, path) => {
    if (method === 'POST') { writes.push(path); return { data: { nextDeliveryAt: '2026-09-23T13:00:00+09:00' } }; }
    if (path === '/api/scenarios') return { data: [{ id: 'sc', name: 'S', triggerType: 'tag_added', triggerTagId: 'tg', isActive: true, deliveryMode: 'elapsed' }] };
    if (path === '/api/tags') return { data: [{ id: 'tg', name: 'T' }] };
    if (path === '/api/scenarios/sc') return { data: { steps: [{ stepOrder: 1, offsetDays: 0, offsetMinutes: 120 }] } };
    if (path === '/api/friends') return { data: { items: friends } };
    if (path === '/api/scenarios/sc/enrollments') return { data: [{ friendId: 'f-2' }] };
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const dry = await enrollTagged(api, { scenarioName: 'S', dryRun: true, log: () => {} });
  assert.deepEqual(dry.done, ['未登録']);
  assert.equal(writes.length, 0);
  const real = await enrollTagged(api, { scenarioName: 'S', log: () => {} });
  assert.deepEqual(writes, ['/api/scenarios/sc/enroll/f-1']);
  assert.deepEqual(real.failed, []);
  await assert.rejects(enrollTagged(api, { scenarioName: 'X', log: () => {} }), /見つかりません/);
});
