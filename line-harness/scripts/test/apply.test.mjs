import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepContent, buildStepPayloads, applyAll, fillPlaceholders } from '../apply.mjs';
import { loadFunnelConfig } from '../lib.mjs';

const config = loadFunnelConfig();
const assets = {
  bookingVideo: { mp4Url: 'https://v.example.com/a.mp4', previewUrl: 'https://v.example.com/a.jpg', aspectRatio: '9:16' },
  prevdayVideo: { linkUrl: 'https://youtu.be/xxxx' },
};

test('text ステップ: 文面を読み、__BOOKING_URL__ を置換する', () => {
  const c = buildStepContent(config.scenarios.welcome.steps[0], { assets, placeholders: { BOOKING_URL: 'https://liff.line.me/1-x?page=book' } });
  assert.equal(c.messageType, 'text');
  assert.ok(c.messageContent.includes('https://liff.line.me/1-x?page=book'));
  assert.ok(!c.messageContent.includes('__BOOKING_URL__'));
  assert.throws(() => buildStepContent(config.scenarios.welcome.steps[0], { assets, placeholders: {} }), /BOOKING_URL/);
});

test('video ステップ: mp4 があれば Flex(hero video)、linkUrl だけならテキスト', () => {
  const flex = buildStepContent(config.scenarios.thanks.steps[1], { assets });
  assert.equal(flex.messageType, 'flex');
  const bubble = JSON.parse(flex.messageContent);
  assert.equal(bubble.hero.type, 'video');
  assert.equal(bubble.hero.url, 'https://v.example.com/a.mp4');
  assert.equal(bubble.hero.altContent.url, 'https://v.example.com/a.jpg');
  assert.equal(bubble.body.contents[0].text, 'ゆうなりから、予約してくださったあなたへ');

  const link = buildStepContent(config.scenarios.prevday.steps[1], { assets });
  assert.equal(link.messageType, 'text');
  assert.ok(link.messageContent.includes('https://youtu.be/xxxx'));

  assert.throws(() => buildStepContent(config.scenarios.thanks.steps[1], { assets: {} }), /assets\.json/);
});

test('ステップ payload: relative は delayMinutes、absolute_time は offsetDays+deliveryTime', () => {
  const rel = buildStepPayloads(config.scenarios.thanks, { assets });
  assert.deepEqual(rel.map((s) => [s.stepOrder, s.delayMinutes]), [[1, 0], [2, 0], [3, 1]]);
  assert.ok(rel.every((s) => s.offsetDays === undefined));
  const abs = buildStepPayloads(config.scenarios.prevday, { assets });
  assert.deepEqual(abs.map((s) => [s.offsetDays, s.deliveryTime]), [[0, '19:00'], [0, '19:00'], [0, '19:01']]);
  assert.ok(abs.every((s) => s.delayMinutes === undefined));
});

test('全シナリオの文面に L Harness が展開できない変数が無い', () => {
  const allowed = /^(name|uid|friend_id|ref|metadata\.[a-z_]+)$/;
  for (const scenario of Object.values(config.scenarios)) {
    for (const step of buildStepPayloads(scenario, { assets, placeholders: { BOOKING_URL: 'https://liff.line.me/x?page=book' } })) {
      for (const m of step.messageContent.matchAll(/\{\{([^}]+)\}\}/g)) {
        assert.match(m[1], allowed, `${scenario.name} #${step.stepOrder}: {{${m[1]}}}`);
      }
      assert.ok(!step.messageContent.includes('__'), `${scenario.name} #${step.stepOrder}: 未置換のプレースホルダー`);
    }
  }
});

test('applyAll: 2回目の実行では作成・更新の書き込みが起きない（冪等）', async () => {
  const state = { tags: [], scenarios: [], steps: {}, nextId: 1 };
  const writes = [];
  const api = async (method, path, { body } = {}) => {
    if (method !== 'GET') writes.push(`${method} ${path}`);
    const id = () => `id-${state.nextId++}`;
    if (method === 'GET' && path === '/api/tags') return { data: state.tags };
    if (method === 'POST' && path === '/api/tags') { const t = { id: id(), ...body }; state.tags.push(t); return { data: t }; }
    if (method === 'GET' && path === '/api/scenarios') return { data: state.scenarios };
    if (method === 'POST' && path === '/api/scenarios') {
      const s = { id: id(), isActive: true, ...body }; state.scenarios.push(s); state.steps[s.id] = []; return { data: s };
    }
    let m;
    if (method === 'GET' && (m = path.match(/^\/api\/scenarios\/([^/]+)$/))) {
      return { data: { ...state.scenarios.find((s) => s.id === m[1]), steps: state.steps[m[1]] } };
    }
    if (method === 'POST' && (m = path.match(/^\/api\/scenarios\/([^/]+)\/steps$/))) {
      state.steps[m[1]].push({ id: id(), ...body }); return { data: {} };
    }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const ctx = { api, config, assets, env: { BOOKING_URL: 'https://liff.line.me/x?page=book' }, lineAccountId: 'acc', withBooking: false, log: () => {} };
  const r1 = await applyAll(ctx);
  assert.equal(Object.keys(r1.scenarioIds).length, Object.keys(config.scenarios).length);
  const firstRunWrites = writes.length;
  assert.ok(firstRunWrites > 0);
  await applyAll(ctx);
  assert.equal(writes.length, firstRunWrites, '2回目に書き込みが発生した');
});

// ---------- LINE2（講義）設定 ----------

const lecture = loadFunnelConfig('config/funnel.lecture.json');

test('fillPlaceholders: 未定義の __X__ はファイル名付きで失敗する', () => {
  assert.equal(fillPlaceholders('a __B__ c', { placeholders: { B: 'x' } }, 'f'), 'a x c');
  assert.throws(() => fillPlaceholders('__NOPE__', { placeholders: {} }, 'drip-00.txt'), /drip-00\.txt.*__NOPE__/);
});

test('講義設定: skipIfTag が tag_not_exists 条件になり、フォーム・リンクのプレースホルダーが埋まる', () => {
  const ctx = {
    assets: null, messagesDir: lecture.messagesDir,
    tagIds: { watched: 'tg-w', applied: 'tg-a', confirmed: 'tg-c' },
    placeholders: { BOOKING_URL: 'https://liff.line.me/2-y?page=book', LECTURE_LINK: 'https://w/t/abc', FORM_ID_apply: 'form-1', BONUS1_URL: 'https://youtu.be/b1', BONUS2_URL: 'https://youtu.be/b2' },
  };
  const drip = buildStepPayloads(lecture.scenarios.drip, ctx);
  assert.equal(drip[0].conditionType, undefined);
  assert.equal(drip[1].conditionType, 'tag_not_exists');
  assert.equal(drip[1].conditionValue, 'tg-a');
  assert.deepEqual(drip.map((s) => [s.offsetDays, s.deliveryTime]), [[0, '00:00'], [0, '21:00'], [1, '08:00'], [1, '20:00'], [2, '20:00']]);
  assert.ok(drip[0].messageContent.includes('https://w/t/abc'));
  assert.ok(drip[1].messageContent.includes('{{form_url:form-1}}'));
  const bonus = buildStepPayloads(lecture.scenarios.bonus, ctx);
  assert.equal(bonus[0].delayMinutes, 60);
  assert.ok(bonus[0].messageContent.includes('https://youtu.be/b1') && bonus[0].messageContent.includes('https://youtu.be/b2'));
  const applied = buildStepPayloads(lecture.scenarios.applied, ctx);
  assert.equal(applied[1].delayMinutes, 1440);
  assert.equal(applied[1].conditionValue, 'tg-c');
  assert.ok(applied[1].messageContent.includes('https://liff.line.me/2-y?page=book'));
  for (const scenario of Object.values(lecture.scenarios)) {
    for (const step of buildStepPayloads(scenario, ctx)) {
      assert.ok(!step.messageContent.includes('__'), `${scenario.name} #${step.stepOrder}: 未置換`);
    }
  }
});

test('講義設定 applyAll: タグ → フォーム → リンク → シナリオの順に作られ、2回目は冪等', async () => {
  const state = { tags: [], forms: [], links: [], scenarios: [], steps: {}, nextId: 1 };
  const writes = [];
  const api = async (method, path, { body } = {}) => {
    if (method !== 'GET') writes.push(`${method} ${path}`);
    const id = () => `id-${state.nextId++}`;
    let m;
    if (method === 'GET' && path === '/api/tags') return { data: state.tags };
    if (method === 'POST' && path === '/api/tags') { const t = { id: id(), ...body }; state.tags.push(t); return { data: t }; }
    if (method === 'GET' && path === '/api/forms') return { data: state.forms };
    if (method === 'POST' && path === '/api/forms') { const f = { id: id(), ...body }; state.forms.push(f); return { data: f }; }
    if (method === 'PUT' && (m = path.match(/^\/api\/forms\/([^/]+)$/))) return { data: {} };
    if (method === 'GET' && path === '/api/tracked-links') return { data: state.links };
    if (method === 'POST' && path === '/api/tracked-links') {
      const l = { id: id(), ...body, trackingUrl: `https://w/t/${state.nextId}` }; state.links.push(l); return { data: l };
    }
    if (method === 'GET' && path === '/api/scenarios') return { data: state.scenarios };
    if (method === 'POST' && path === '/api/scenarios') {
      const s = { id: id(), isActive: true, ...body }; state.scenarios.push(s); state.steps[s.id] = []; return { data: s };
    }
    if (method === 'GET' && (m = path.match(/^\/api\/scenarios\/([^/]+)$/))) {
      return { data: { ...state.scenarios.find((s) => s.id === m[1]), steps: state.steps[m[1]] } };
    }
    if (method === 'POST' && (m = path.match(/^\/api\/scenarios\/([^/]+)\/steps$/))) {
      state.steps[m[1]].push({ id: id(), ...body }); return { data: {} };
    }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const ctx = {
    api, config: lecture, assets: null,
    env: { BOOKING_URL: 'https://liff.line.me/2-y?page=book', LECTURE_PAGE_URL: 'https://roots-lecture.pages.dev', BONUS1_URL: 'https://youtu.be/b1', BONUS2_URL: 'https://youtu.be/b2' },
    lineAccountId: 'acc2', withBooking: false, log: () => {},
  };
  const r1 = await applyAll(ctx);
  assert.equal(state.forms[0].onSubmitTagId, r1.tagIds.applied);
  assert.ok(state.forms[0].onSubmitMessageContent.includes('お申し込みありがとうございます'));
  assert.equal(state.links[0].originalUrl, 'https://roots-lecture.pages.dev');
  assert.equal(state.links[0].tagId, r1.tagIds.watched);
  const applied = state.scenarios.find((s) => s.name === '講義_申込後フォロー');
  assert.equal(applied.triggerType, 'tag_added');
  assert.equal(applied.triggerTagId, r1.tagIds.applied);
  const drip = state.scenarios.find((s) => s.name === '講義_友だち追加ステップ');
  assert.ok(state.steps[drip.id][0].messageContent.includes(state.links[0].trackingUrl));
  assert.ok(state.steps[drip.id][1].messageContent.includes(`{{form_url:${state.forms[0].id}}}`));

  const before = writes.length;
  await applyAll(ctx);
  // 2回目: フォームは内容比較をせず PUT で同期する（1件）。それ以外の書き込みは無い
  assert.deepEqual(writes.slice(before), ['PUT /api/forms/' + state.forms[0].id]);
});

test('ensureBooking: 担当者ごとの受付時間があればそれを使い、無ければ共通設定を使う', async () => {
  const { ensureBooking } = await import('../apply.mjs');
  const calls = [];
  const api = async (method, path, { body } = {}) => {
    calls.push({ method, path, body });
    if (path === '/api/booking/admin/menus' && method === 'GET') return { menus: [] };
    if (path === '/api/booking/admin/menus') return { id: 'menu-1' };
    if (path === '/api/booking/admin/staff' && method === 'GET') return { staff: [] };
    if (path === '/api/booking/admin/staff') return { id: `st-${calls.length}` };
    return { ok: true };
  };
  const own = [{ weekday: 2, start_time: '13:00', end_time: '21:00' }];
  const booking = {
    ...lecture.booking,
    staff: [...lecture.booking.staff.slice(0, 2), { ...lecture.booking.staff[2], availabilityRules: own }],
  };
  await ensureBooking(api, booking, {}, 'acc2', () => {});
  const rules = calls.filter((c) => c.path.endsWith('/availability-rules')).map((c) => c.body.rules);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], lecture.booking.availabilityRules);
  assert.deepEqual(rules[2], own);
});

// ---------- LINE1（誘導）設定 ----------

test('LINE1 設定: Flex にサムネイルと LINE2 の auth_url が入り、余計なプレースホルダーが残らない', () => {
  const line1 = loadFunnelConfig('config/funnel.line1.json');
  const ctx = {
    assets: null, messagesDir: line1.messagesDir, tagIds: {},
    placeholders: { LINE2_CHANNEL_ID: '2011652832', THUMB_URL: 'https://roots-lecture.pages.dev/thumb.jpg', THUMB_ASPECT: '16:9' },
  };
  const steps = buildStepPayloads(line1.scenarios.invite, ctx);
  // あいさつ文は LINE 側のあいさつメッセージで送るので、L Harness 側は即時 Flex 1 通だけ
  assert.equal(steps.length, 1);
  assert.equal(steps[0].messageType, 'flex');
  assert.equal(steps[0].delayMinutes, 0);
  const bubble = JSON.parse(steps[0].messageContent);
  assert.deepEqual(bubble.body.contents.map((c) => c.text), ['やせ習慣1Day講義']);
  assert.equal(bubble.hero.url, 'https://roots-lecture.pages.dev/thumb.jpg');
  assert.equal(bubble.hero.aspectRatio, '16:9');
  assert.equal(bubble.footer.contents[0].action.uri, '{{auth_url:2011652832}}');
  assert.equal(bubble.hero.action.uri, '{{auth_url:2011652832}}');
  for (const s of steps) assert.ok(!s.messageContent.includes('__'), '未置換のプレースホルダー');
  assert.throws(() => buildStepPayloads(line1.scenarios.invite, { ...ctx, placeholders: {} }), /THUMB_URL|LINE2_CHANNEL_ID/);
});
