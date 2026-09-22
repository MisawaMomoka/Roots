import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reversePlaceholders, selectScenarios, pullMessages } from '../pull-messages.mjs';
import { buildStepPayloads, fillPlaceholders, envPlaceholders } from '../apply.mjs';
import { loadFunnelConfig, readMessageFile } from '../lib.mjs';

const lecture = loadFunnelConfig('config/funnel.lecture.json');
const env = {
  LINE_HARNESS_API_URL: 'https://w.example.com',
  BOOKING_URL: 'https://liff.line.me/2-y?page=book',
  LECTURE_PAGE_URL: 'https://liff.line.me/2-z',
  BONUS1_URL: 'https://youtu.be/b1',
  BONUS2_URL: 'https://youtu.be/b2',
};
const placeholders = { ...envPlaceholders(env), FORM_ID_apply: 'form-1', LECTURE_LINK: 'https://w.example.com/t/abc' };

test('pull-messages: 埋めた文面を元のプレースホルダーに戻せる（往復）', () => {
  const src = 'A __LECTURE_LINK_SRC__ B __LECTURE_PAGE_URL__ C {{form_url:__FORM_ID_apply__}} D __BOOKING_URL__ E __LECTURE_LINK__';
  const filled = fillPlaceholders(src, { placeholders }, 'x');
  assert.ok(!filled.includes('__'));
  assert.equal(reversePlaceholders(filled, placeholders), src);
  // 実ファイルでも往復できる
  for (const step of lecture.scenarios.drip.steps) {
    const original = readMessageFile(step.file, lecture.messagesDir);
    const filledFile = fillPlaceholders(original, { placeholders }, step.file);
    assert.equal(reversePlaceholders(filledFile, placeholders), original);
  }
});

test('pull-messages: シナリオは key・名前・旧名で選べ、無ければ失敗', () => {
  assert.deepEqual(selectScenarios(lecture, 'drip').map(([k]) => k), ['drip']);
  assert.deepEqual(selectScenarios(lecture, '講義_閲覧後未申込フォロー').map(([k]) => k), ['drip']);
  assert.deepEqual(selectScenarios(lecture, '講義_友だち追加ステップ,welcome').map(([k]) => k), ['welcome', 'drip']);
  assert.equal(selectScenarios(lecture).length, Object.keys(lecture.scenarios).length);
  assert.throws(() => selectScenarios(lecture, 'nope'), /設定にないシナリオ: nope/);
});

test('pull-messages: 管理画面と同じなら書かず、違うステップだけプレースホルダーに戻して書く', async () => {
  const ctx = { assets: null, messagesDir: lecture.messagesDir, tagIds: { applied: 'tg-a' }, placeholders };
  const remoteSteps = buildStepPayloads(lecture.scenarios.drip, ctx).map((p, i) => ({ id: `st-${i + 1}`, ...p }));
  // #2 だけ管理画面で直した想定（実 URL・フォーム ID 入り）
  remoteSteps[1].messageContent = `【受付は明日まで】\n直しました。\n{{form_url:form-1}}\nhttps://liff.line.me/2-z?src={{ref}}\nhttps://liff.line.me/2-y?page=book  `;
  const api = async (method, path) => {
    if (path === '/api/forms') return { data: [{ id: 'form-1', name: lecture.forms.apply.name }] };
    if (path === '/api/tracked-links') return { data: [{ name: lecture.trackedLinks.lecturePage.name, trackingUrl: 'https://w.example.com/t/abc' }] };
    if (path === '/api/scenarios') return { data: [{ id: 'sc-1', name: '講義_閲覧後未申込フォロー' }] };
    if (path === '/api/scenarios/sc-1') return { data: { id: 'sc-1', steps: remoteSteps } };
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const written = [];
  const dry = await pullMessages(api, { config: lecture, env, scenario: 'drip', write: false, log: () => {}, writeFile: (p, c) => written.push([p, c]) });
  assert.deepEqual(dry.map((r) => r.status), ['same', 'changed', 'same']);
  assert.equal(written.length, 0);

  const res = await pullMessages(api, { config: lecture, env, scenario: 'drip', write: true, log: () => {}, writeFile: (p, c) => written.push([p, c]) });
  assert.equal(written.length, 1);
  assert.ok(written[0][0].endsWith('/config/messages/lecture/drip-03-deadline.txt'));
  assert.equal(written[0][1], '【受付は明日まで】\n直しました。\n{{form_url:__FORM_ID_apply__}}\n__LECTURE_LINK_SRC__\n__BOOKING_URL__\n');
  assert.equal(res[1].note, undefined);
});

test('pull-messages: 戻せない URL が残ったら注意を付け、旧名のシナリオ・text 以外・欠けたステップは扱いを分ける', async () => {
  const api = async (method, path) => {
    if (path === '/api/forms') return { data: [] };
    if (path === '/api/tracked-links') return { data: [] };
    if (path === '/api/scenarios') return { data: [{ id: 'sc-old', name: '講義_友だち追加ステップ' }, { id: 'sc-th', name: '相談会_予約直後' }] };
    if (path === '/api/scenarios/sc-old') return { data: { id: 'sc-old', steps: [{ id: 'a', stepOrder: 1, messageType: 'text', messageContent: '新しい文面 https://example.com/unknown' }] } };
    if (path === '/api/scenarios/sc-th') return { data: { id: 'sc-th', steps: [{ id: 'b', stepOrder: 1, messageType: 'flex', messageContent: '{}' }] } };
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const res = await pullMessages(api, { config: lecture, env, scenario: 'drip,thanks,welcome', write: false, log: () => {}, writeFile: () => {} });
  const drip = res.filter((r) => r.scenario === 'drip');
  assert.deepEqual(drip.map((r) => r.status), ['changed', 'missing', 'missing']);
  assert.match(drip[0].note, /https:\/\/example\.com\/unknown/);
  assert.equal(res.find((r) => r.scenario === 'thanks').status, 'skipped');
  assert.equal(res.find((r) => r.scenario === 'welcome').status, 'missing');
});
