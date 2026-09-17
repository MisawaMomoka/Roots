import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepContent, buildStepPayloads, applyAll } from '../apply.mjs';
import { loadFunnelConfig } from '../lib.mjs';

const config = loadFunnelConfig();
const assets = {
  bookingVideo: { mp4Url: 'https://v.example.com/a.mp4', previewUrl: 'https://v.example.com/a.jpg', aspectRatio: '9:16' },
  prevdayVideo: { linkUrl: 'https://youtu.be/xxxx' },
};

test('text ステップ: 文面を読み、__BOOKING_URL__ を置換する', () => {
  const c = buildStepContent(config.scenarios.welcome.steps[0], { assets, bookingUrl: 'https://liff.line.me/1-x?page=book' });
  assert.equal(c.messageType, 'text');
  assert.ok(c.messageContent.includes('https://liff.line.me/1-x?page=book'));
  assert.ok(!c.messageContent.includes('__BOOKING_URL__'));
  assert.throws(() => buildStepContent(config.scenarios.welcome.steps[0], { assets }), /BOOKING_URL/);
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
    for (const step of buildStepPayloads(scenario, { assets, bookingUrl: 'https://liff.line.me/x?page=book' })) {
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
  const ctx = { api, config, assets, bookingUrl: 'https://liff.line.me/x?page=book', lineAccountId: 'acc', withBooking: false, log: () => {} };
  const r1 = await applyAll(ctx);
  assert.equal(Object.keys(r1.scenarioIds).length, Object.keys(config.scenarios).length);
  const firstRunWrites = writes.length;
  assert.ok(firstRunWrites > 0);
  await applyAll(ctx);
  assert.equal(writes.length, firstRunWrites, '2回目に書き込みが発生した');
});
