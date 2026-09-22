import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTag, findScenario, planStepUpdates, wouldDeliver, applyCondition, verifyCondition } from '../scenario-condition.mjs';
import { buildStepPayloads } from '../apply.mjs';
import { loadFunnelConfig } from '../lib.mjs';

const TAG = { id: 'tg-applied', name: '講義_相談会申込' };
const OTHER_TAG = { id: 'tg-watched', name: '講義_視聴ページを開いた' };

function mockApi(state) {
  const writes = [];
  const api = async (method, path, { body, query } = {}) => {
    if (method !== 'GET') writes.push({ method, path, body });
    let m;
    if (method === 'GET' && path === '/api/tags') return { data: state.tags };
    if (method === 'GET' && path === '/api/scenarios') return { data: state.scenarios.map(({ steps: _s, ...s }) => s) };
    if (method === 'GET' && (m = path.match(/^\/api\/scenarios\/([^/]+)$/))) {
      return { data: state.scenarios.find((s) => s.id === m[1]) };
    }
    if (method === 'PUT' && (m = path.match(/^\/api\/scenarios\/([^/]+)\/steps\/([^/]+)$/))) {
      const step = state.scenarios.find((s) => s.id === m[1]).steps.find((st) => st.id === m[2]);
      Object.assign(step, body);
      return { data: step };
    }
    if (method === 'POST' && path === '/api/segments/count') {
      const rule = body.conditions.rules[0];
      const has = state.friends.filter((f) => f.tags.some((t) => t.id === rule.value)).length;
      return { success: true, count: rule.type === 'tag_exists' ? has : state.friends.length - has };
    }
    if (method === 'GET' && path === '/api/friends') {
      return { data: { items: state.friends.filter((f) => f.tags.some((t) => t.id === query.tagId)) } };
    }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  return { api, writes };
}

function freshState() {
  return {
    tags: [OTHER_TAG, TAG],
    scenarios: [
      {
        id: 'sc-target', name: '講義_閲覧後未申込フォロー', isActive: true, deliveryMode: 'absolute_time',
        steps: [
          { id: 'st-1', stepOrder: 1, conditionType: null, conditionValue: null },
          { id: 'st-2', stepOrder: 2, conditionType: 'tag_not_exists', conditionValue: TAG.id }, // 設定済み
          { id: 'st-3', stepOrder: 3, conditionType: 'tag_not_exists', conditionValue: OTHER_TAG.id }, // 別タグ
        ],
      },
      {
        id: 'sc-other', name: '講義_友だち追加直後（相対）', isActive: true, deliveryMode: 'relative',
        steps: [{ id: 'st-o1', stepOrder: 1, conditionType: null, conditionValue: null }],
      },
    ],
    friends: [
      { id: 'f-1', displayName: '申込済みさん', tags: [TAG, OTHER_TAG] },
      { id: 'f-2', displayName: '未申込さん', tags: [OTHER_TAG] },
      { id: 'f-3', displayName: '何もなしさん', tags: [] },
    ],
  };
}

test('scenario-condition: タグ／シナリオは完全一致で探し、無ければ候補付きで失敗する', () => {
  assert.equal(findTag([TAG], '講義_相談会申込').id, TAG.id);
  assert.equal(findTag([TAG], TAG.id).id, TAG.id);
  assert.throws(() => findTag([TAG], '講義_相談会'), /講義_相談会申込/);
  const s = freshState().scenarios;
  assert.equal(findScenario(s, '講義_閲覧後未申込フォロー').id, 'sc-target');
  assert.throws(() => findScenario(s, '講義_閲覧後'), /完全一致[\s\S]*講義_閲覧後未申込フォロー/);
});

test('scenario-condition: 変更が要るステップだけ更新し、他のシナリオには触らない', async () => {
  const state = freshState();
  const { api, writes } = mockApi(state);
  const r = await applyCondition(api, { scenarioName: '講義_閲覧後未申込フォロー', tagName: '講義_相談会申込', log: () => {} });
  assert.deepEqual(r.updated, [1, 3]);
  assert.deepEqual(r.unchanged, [2]);
  assert.deepEqual(writes.map((w) => w.path), ['/api/scenarios/sc-target/steps/st-1', '/api/scenarios/sc-target/steps/st-3']);
  for (const w of writes) assert.deepEqual(w.body, { conditionType: 'tag_not_exists', conditionValue: TAG.id });
  const target = state.scenarios[0];
  assert.ok(target.steps.every((s) => s.conditionType === 'tag_not_exists' && s.conditionValue === TAG.id));
  assert.equal(state.scenarios[1].steps[0].conditionType, null); // 他シナリオは無変更

  // 2 回目は書き込みなし（冪等）
  const before = writes.length;
  const r2 = await applyCondition(api, { scenarioName: '講義_閲覧後未申込フォロー', tagName: '講義_相談会申込', log: () => {} });
  assert.deepEqual(r2.updated, []);
  assert.equal(writes.length, before);
});

test('scenario-condition: 配信時判定は L Harness と同じ（タグがあれば送らない、条件だけあって値が無ければ送らない）', () => {
  const step = { conditionType: 'tag_not_exists', conditionValue: TAG.id };
  assert.equal(wouldDeliver(step, [TAG.id, OTHER_TAG.id]), false); // 申込済み → 送らない
  assert.equal(wouldDeliver(step, [OTHER_TAG.id]), true); // 未申込 → 送る
  assert.equal(wouldDeliver(step, []), true);
  assert.equal(wouldDeliver({ conditionType: null, conditionValue: null }, [TAG.id]), true); // 条件なし → 全員
  assert.equal(wouldDeliver({ conditionType: 'tag_not_exists', conditionValue: '' }, []), false); // 値なし → 送らない
  assert.equal(wouldDeliver({ conditionType: 'tag_exists', conditionValue: TAG.id }, [TAG.id]), true);
  assert.deepEqual(planStepUpdates(freshState().scenarios[0].steps, TAG.id).map((p) => p.needsUpdate), [true, false, true]);
});

test('scenario-condition: 検証で申込済み（タグあり）の人が全ステップの配信対象から外れることを確かめる', async () => {
  const state = freshState();
  const { api } = mockApi(state);
  // 設定前は検証が失敗する
  await assert.rejects(verifyCondition(api, { scenarioId: 'sc-target', tagId: TAG.id, log: () => {} }), /#1, #3/);
  await applyCondition(api, { scenarioName: '講義_閲覧後未申込フォロー', tagName: '講義_相談会申込', log: () => {} });
  const v = await verifyCondition(api, { scenarioId: 'sc-target', tagId: TAG.id, log: () => {} });
  assert.equal(v.withTag, 1); // 配信対象外
  assert.equal(v.withoutTag, 2); // 配信対象
  assert.deepEqual(v.sampled, [{ name: '申込済みさん', excluded: true }]);
  // タグを持たない人は全ステップで配信対象のまま
  for (const step of v.steps) assert.equal(wouldDeliver(step, [OTHER_TAG.id]), true);
});

test('scenario-condition: リポジトリ設定でも「講義_閲覧後未申込フォロー」の全ステップが skipIfTag: applied（tag_not_exists）になっている', () => {
  const lecture = loadFunnelConfig('config/funnel.lecture.json');
  const scenario = Object.values(lecture.scenarios).find((s) => s.name === '講義_閲覧後未申込フォロー');
  assert.ok(scenario, '設定にシナリオが無い');
  assert.ok(scenario.steps.length >= 1);
  assert.ok(scenario.steps.every((s) => s.skipIfTag === 'applied'));
  assert.equal(lecture.tags.find((t) => t.key === 'applied').name, '講義_相談会申込');
  const payloads = buildStepPayloads(scenario, {
    assets: null, messagesDir: lecture.messagesDir, tagIds: { applied: TAG.id, watched: OTHER_TAG.id, confirmed: 'tg-c' },
    placeholders: { BOOKING_URL: 'https://liff.line.me/2-y?page=book', LECTURE_LINK_SRC: 'https://liff.line.me/2-z?src={{ref}}', FORM_ID_apply: 'form-1' },
  });
  for (const p of payloads) {
    assert.equal(p.conditionType, 'tag_not_exists');
    assert.equal(p.conditionValue, TAG.id);
    assert.equal(wouldDeliver(p, [TAG.id]), false);
  }
});
