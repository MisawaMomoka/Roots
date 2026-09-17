import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideActions, buildMetadata, runSync } from '../sync-bookings.mjs';
import { loadFunnelConfig, jstDateTime } from '../lib.mjs';

const config = loadFunnelConfig();
const assets = { staffMeetingUrls: { 担当者A: 'https://zoom.us/j/111' }, defaultMeetingUrl: 'https://zoom.us/j/000' };

// 診断会: 2026-09-20（日）14:00 JST
const STARTS = jstDateTime('2026-09-20', '14:00').toISOString();
const booking = (over = {}) => ({
  id: 'bk-1', friend_id: 'fr-1', staff_id: 'st-1', menu_id: 'mn-1',
  menu_name: config.booking.menu.name, staff_name: '担当者A', friend_name: '三沢',
  starts_at: STARTS, status: 'confirmed', decided_at: jstDateTime('2026-09-15', '10:00').toISOString(),
  ...over,
});

test('buildMetadata: JST の日付・時刻・担当者・会議URL', () => {
  const m = buildMetadata(booking(), assets);
  assert.equal(m.diag_date, '9月20日（日）');
  assert.equal(m.diag_time, '14:00');
  assert.equal(m.diag_staff, '担当者A');
  assert.equal(m.diag_meeting_url, 'https://zoom.us/j/111');
  assert.equal(buildMetadata(booking({ staff_name: '不明' }), assets).diag_meeting_url, 'https://zoom.us/j/000');
});

test('予約直後: 確定直後は send、2回目の予約は reschedule、古い確定は skip_old', () => {
  const now = jstDateTime('2026-09-15', '10:03');
  assert.equal(decideActions({ booking: booking(), meta: {}, now, config }).thanks, 'send');
  assert.equal(decideActions({ booking: booking(), meta: { diag_thanks_sent_for: 'bk-0' }, now, config }).thanks, 'reschedule');
  assert.equal(decideActions({ booking: booking(), meta: { diag_thanks_sent_for: 'bk-1' }, now, config }).thanks, null);
  const old = jstDateTime('2026-09-15', '14:00');
  assert.equal(decideActions({ booking: booking(), meta: {}, now: old, config }).thanks, 'skip_old');
});

test('前日: 前日の日付になったら send、22:00 を過ぎたら skip_late、当日は skip_late', () => {
  const meta = { diag_thanks_sent_for: 'bk-1' };
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-18', '23:00'), config }).prevday, null);
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-19', '09:00'), config }).prevday, 'send');
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-19', '21:59'), config }).prevday, 'send');
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-19', '22:01'), config }).prevday, 'skip_late');
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-20', '09:00'), config }).prevday, 'skip_late');
  assert.equal(decideActions({ booking: booking(), meta: { ...meta, diag_prevday_sent_for: 'bk-1' }, now: jstDateTime('2026-09-19', '09:00'), config }).prevday, null);
});

test('当日: 2時間前から send、開始後は skip_past', () => {
  const meta = { diag_thanks_sent_for: 'bk-1', diag_prevday_sent_for: 'bk-1' };
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-20', '11:55'), config }).sameday, null);
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-20', '12:00'), config }).sameday, 'send');
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-20', '13:59'), config }).sameday, 'send');
  assert.equal(decideActions({ booking: booking(), meta, now: jstDateTime('2026-09-20', '14:00'), config }).sameday, 'skip_past');
});

/** メモリ上の L Harness もどき。呼ばれた書き込みを記録する */
function mockApi(state) {
  const calls = [];
  const api = async (method, path, { body, query } = {}) => {
    calls.push({ method, path, body, query });
    const m = (re) => path.match(re);
    if (method === 'GET' && path === '/api/scenarios') return { data: state.scenarios };
    if (method === 'GET' && path === '/api/tags') return { data: state.tags };
    if (method === 'GET' && path === '/api/booking/admin/requests') {
      return { requests: state.bookings.filter((b) => b.status === query.status) };
    }
    if (method === 'PATCH' && m(/^\/api\/booking\/admin\/requests\/(.+)$/)) {
      const b = state.bookings.find((x) => x.id === m(/requests\/(.+)$/)[1]);
      b.status = 'confirmed'; b.decided_at = state.now.toISOString();
      return { status: 'confirmed' };
    }
    if (method === 'GET' && m(/^\/api\/friends\/([^/]+)$/)) return { data: state.friends[m(/friends\/([^/]+)$/)[1]] };
    if (method === 'PUT' && m(/^\/api\/friends\/([^/]+)\/metadata$/)) {
      const f = state.friends[m(/friends\/([^/]+)\/metadata$/)[1]];
      Object.assign(f.metadata, body);
      return { success: true };
    }
    if (method === 'POST' && m(/^\/api\/friends\/([^/]+)\/tags$/)) {
      state.friends[m(/friends\/([^/]+)\/tags$/)[1]].tags.push({ id: body.tagId });
      return { success: true };
    }
    if (method === 'POST' && m(/^\/api\/scenarios\/([^/]+)\/enroll\/([^/]+)$/)) {
      state.enrolled.push(m(/scenarios\/([^/]+)\/enroll/)[1]);
      return { success: true };
    }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  return { api, calls };
}

function freshState(now) {
  return {
    now,
    scenarios: Object.entries(config.scenarios).map(([key, s]) => ({ id: `sc-${key}`, name: s.name })),
    tags: config.tags.map((t) => ({ id: `tg-${t.key}`, name: t.name })),
    bookings: [booking({ status: 'requested', decided_at: null })],
    friends: { 'fr-1': { id: 'fr-1', displayName: '三沢', isFollowing: true, metadata: {}, tags: [] } },
    enrolled: [],
  };
}

test('runSync: 承認 → タグ → メタデータ → 予約直後シナリオ登録、2回目の実行では何もしない', async () => {
  const now = jstDateTime('2026-09-15', '10:00');
  const state = freshState(now);
  const { api } = mockApi(state);
  const s1 = await runSync({ api, config, assets, accountId: 'acc', now, info: () => {} });
  assert.equal(s1.approved, 1);
  assert.deepEqual(state.enrolled, ['sc-thanks']);
  assert.equal(state.friends['fr-1'].metadata.diag_thanks_sent_for, 'bk-1');
  assert.equal(state.friends['fr-1'].metadata.diag_date, '9月20日（日）');
  assert.equal(state.friends['fr-1'].metadata.diag_meeting_url, 'https://zoom.us/j/111');
  assert.deepEqual(state.friends['fr-1'].tags, [{ id: 'tg-confirmed' }]);

  const s2 = await runSync({ api, config, assets, accountId: 'acc', now: new Date(now.getTime() + 5 * 60_000), info: () => {} });
  assert.equal(s2.approved, 0);
  assert.deepEqual(state.enrolled, ['sc-thanks']);
});

test('runSync: 前日と当日はそれぞれのタイミングで1回だけ登録される', async () => {
  const state = freshState(jstDateTime('2026-09-15', '10:00'));
  const { api } = mockApi(state);
  await runSync({ api, config, assets, accountId: 'acc', now: state.now, info: () => {} });
  await runSync({ api, config, assets, accountId: 'acc', now: jstDateTime('2026-09-19', '08:00'), info: () => {} });
  assert.deepEqual(state.enrolled, ['sc-thanks', 'sc-prevday']);
  await runSync({ api, config, assets, accountId: 'acc', now: jstDateTime('2026-09-19', '18:00'), info: () => {} });
  assert.deepEqual(state.enrolled, ['sc-thanks', 'sc-prevday']);
  await runSync({ api, config, assets, accountId: 'acc', now: jstDateTime('2026-09-20', '12:02'), info: () => {} });
  assert.deepEqual(state.enrolled, ['sc-thanks', 'sc-prevday', 'sc-sameday']);
  await runSync({ api, config, assets, accountId: 'acc', now: jstDateTime('2026-09-20', '12:07'), info: () => {} });
  assert.deepEqual(state.enrolled, ['sc-thanks', 'sc-prevday', 'sc-sameday']);
});

test('runSync: 日程変更（再予約）は動画なしの確定文、前日・当日は新しい日程で再送', async () => {
  const state = freshState(jstDateTime('2026-09-15', '10:00'));
  const { api } = mockApi(state);
  await runSync({ api, config, assets, accountId: 'acc', now: state.now, info: () => {} });
  // 9/20 をキャンセルし、9/25 14:00 に再予約
  state.bookings[0].status = 'cancelled';
  state.bookings.push(booking({ id: 'bk-2', status: 'requested', decided_at: null, starts_at: jstDateTime('2026-09-25', '14:00').toISOString() }));
  state.now = jstDateTime('2026-09-16', '10:00');
  await runSync({ api, config, assets, accountId: 'acc', now: state.now, info: () => {} });
  assert.deepEqual(state.enrolled, ['sc-thanks', 'sc-reschedule']);
  assert.equal(state.friends['fr-1'].metadata.diag_date, '9月25日（金）');
  await runSync({ api, config, assets, accountId: 'acc', now: jstDateTime('2026-09-24', '09:00'), info: () => {} });
  await runSync({ api, config, assets, accountId: 'acc', now: jstDateTime('2026-09-25', '12:00'), info: () => {} });
  assert.deepEqual(state.enrolled, ['sc-thanks', 'sc-reschedule', 'sc-prevday', 'sc-sameday']);
});

test('runSync: 導入前からある古い確定予約には予約直後を送らない（skipped 記録のみ）', async () => {
  const state = freshState(jstDateTime('2026-09-15', '10:00'));
  state.bookings[0].status = 'confirmed';
  state.bookings[0].decided_at = jstDateTime('2026-09-10', '10:00').toISOString();
  const { api } = mockApi(state);
  const s = await runSync({ api, config, assets, accountId: 'acc', now: state.now, info: () => {} });
  assert.deepEqual(state.enrolled, []);
  assert.equal(s.skipped, 1);
  assert.equal(state.friends['fr-1'].metadata.diag_thanks_sent_for, 'skipped:bk-1');
});

test('runSync: 別メニューの予約には触らない', async () => {
  const state = freshState(jstDateTime('2026-09-15', '10:00'));
  state.bookings[0].menu_name = '別のメニュー';
  const { api } = mockApi(state);
  const s = await runSync({ api, config, assets, accountId: 'acc', now: state.now, info: () => {} });
  assert.equal(s.approved, 0);
  assert.deepEqual(state.enrolled, []);
});
