import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFriendAddUrl, ensureEntryRoutes, summarize, formatStats } from '../entry-routes.mjs';
import { loadFunnelConfig } from '../lib.mjs';

test('entry-routes: 友だち追加リンクは /auth/line?account=チャネルID&ref=経路', () => {
  assert.equal(
    buildFriendAddUrl('https://w.example.com/', '2011648117', 'ig_story'),
    'https://w.example.com/auth/line?account=2011648117&ref=ig_story',
  );
});

test('entry-routes: LINE1 設定にストーリー用とリール用の経路があり、タグと対応している', () => {
  const c = loadFunnelConfig('config/funnel.line1.json');
  const refs = c.entryRoutes.map((r) => r.refCode);
  assert.deepEqual(refs, ['ig_story', 'ig_reel']);
  const tagKeys = new Set(c.tags.map((t) => t.key));
  for (const r of c.entryRoutes) {
    assert.ok(tagKeys.has(r.tag), `経路 ${r.key} のタグ ${r.tag} が tags にない`);
    assert.match(r.refCode, /^[a-z0-9_]+$/);
  }
});

test('entry-routes: 無い経路は作成、名前やタグが違う経路は更新、同じなら何もしない', async () => {
  const calls = [];
  const api = async (method, path, { body } = {}) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/entry-routes') {
      return { data: [
        { id: 'r-reel', refCode: 'ig_reel', name: '古い名前', tagId: null, isActive: true, runAccountFriendAddScenarios: true },
        { id: 'r-same', refCode: 'same', name: '同じ', tagId: 't-same', isActive: true, runAccountFriendAddScenarios: true },
      ] };
    }
    if (method === 'POST') { assert.equal(body.refCode, 'ig_story'); assert.equal(body.tagId, 't-story'); return { data: { id: 'r-story' } }; }
    if (method === 'PATCH') { assert.equal(path, '/api/entry-routes/r-reel'); assert.equal(body.tagId, 't-reel'); return { data: { id: 'r-reel' } }; }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const routes = [
    { key: 'ig_story', refCode: 'ig_story', name: 'ストーリー', tag: 'ig_story' },
    { key: 'ig_reel', refCode: 'ig_reel', name: 'リール', tag: 'ig_reel' },
    { key: 'same', refCode: 'same', name: '同じ', tag: 'same' },
  ];
  const ids = await ensureEntryRoutes(api, routes, { ig_story: 't-story', ig_reel: 't-reel', same: 't-same' }, () => {});
  assert.deepEqual(ids, { ig_story: 'r-story', ig_reel: 'r-reel', same: 'r-same' });
  assert.deepEqual(calls, ['GET /api/entry-routes', 'POST /api/entry-routes', 'PATCH /api/entry-routes/r-reel']);
});

test('entry-routes: 集計は経路合計に対する割合とクリック→追加率を出す', () => {
  const routes = [
    { key: 'ig_story', refCode: 'ig_story', name: 'ストーリー' },
    { key: 'ig_reel', refCode: 'ig_reel', name: 'リール' },
  ];
  const s = summarize(routes, {
    ig_story: { click_count: 100, friend_add_count: 30, form_submission_count: 3 },
    ig_reel: { click_count: 40, friend_add_count: 10, form_submission_count: 0 },
  });
  assert.equal(s.totalAdds, 40);
  assert.equal(s.rows[0].share, 75);
  assert.equal(s.rows[1].share, 25);
  assert.equal(s.rows[0].addRate, 30);
  const text = formatStats(s);
  assert.match(text, /ストーリー/);
  assert.match(text, /合計 友だち追加: 40 人/);
  // 0 件でも割り算で落ちない
  const empty = summarize(routes, {});
  assert.equal(empty.totalAdds, 0);
  assert.equal(empty.rows[0].share, 0);
  assert.equal(empty.rows[0].addRate, null);
});
