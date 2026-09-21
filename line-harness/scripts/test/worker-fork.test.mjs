import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatches, applyPatches, toTemplate } from '../../worker-fork/patch.mjs';

// 配布済みバンドル（v0.24.1）から抜き出したアンカー周辺のミニチュア
const FIXTURE = [
  'function renderNotificationText(kind, ctx) {',
  '  switch (kind) {',
  '    case "requested":',
  '      return `\\u4E88\\u7D04\\u30EA\\u30AF\\u30A8\\u30B9\\u30C8\\u3092\\u53D7\\u3051\\u4ED8\\u3051\\u307E\\u3057\\u305F\\u3002${detail}\n\n\\u304A\\u5E97\\u304B\\u3089\\u306E\\u8FD4\\u4FE1\\u3092\\u304A\\u5F85\\u3061\\u304F\\u3060\\u3055\\u3044\\u3002`;',
  '    case "approved":',
  '      return `\\u4E88\\u7D04\\u304C\\u78BA\\u5B9A\\u3057\\u307E\\u3057\\u305F\\u3002${detail}\n\n\\u5909\\u66F4\\u30FB\\u30AD\\u30E3\\u30F3\\u30BB\\u30EB\\u306F\\u304A\\u5E97\\u306B\\u76F4\\u63A5\\u3054\\u9023\\u7D61\\u304F\\u3060\\u3055\\u3044\\u3002`;',
  '    case "rejected":',
  '      return `x`;',
  '  }',
  '}',
  'async function sendBookingNotification(params) {',
  '  const text2 = renderNotificationText(params.kind, params.ctx);',
  '  const client = new LineClient(params.channelAccessToken);',
  '}',
  '  const due = await db.prepare(',
  '    `SELECT r.id',
  '         FROM booking_reminders r',
  '         INNER JOIN bookings b ON b.id = r.booking_id',
  '         INNER JOIN menus m ON m.id = b.menu_id',
  '         INNER JOIN staff s ON s.id = b.staff_id',
  '         INNER JOIN line_accounts la ON la.id = b.line_account_id',
  '         INNER JOIN friends f ON f.id = b.friend_id',
  "        WHERE r.status IN ('pending','failed')",
  '          AND r.scheduled_at <= ?`',
  '  );',
  '  const created = await client.createEvent({',
  '    summary: `${row.friend_name ?? "\\u304A\\u5BA2\\u69D8"}\\uFF5C${row.menu_name}`,',
  '    description: [',
  '      row.customer_note ? `\\u30E1\\u30E2: ${row.customer_note}` : ""',
  '    ].filter(Boolean).join("\\n"),',
  '  });',
].join('\n') + '\n';

test('worker-fork: 空文字なら受付／確定メッセージを送らない（送信スキップも入る）', () => {
  const { source, applied } = applyPatches(FIXTURE, buildPatches({ requested: '', approved: '', builtinReminders: false }));
  assert.deepEqual(applied, ['notify.requested', 'notify.approved', 'notify.skipEmpty', 'reminders.off', 'calendar.title', 'calendar.note']);
  assert.ok(source.includes('case "requested":\n      return ``;'));
  assert.ok(source.includes('case "approved":\n      return ``;'));
  assert.ok(source.includes('if (!text2) return;'));
  assert.ok(source.includes("WHERE r.status IN ('pending','failed') AND 1 = 0"));
  assert.ok(!source.includes('\\u304A\\u5E97\\u304B\\u3089')); // 「お店からの…」が消えている
});

test('worker-fork: 文言を指定すると差し込み付きのテンプレートになる', () => {
  const msgs = { requested: '受付しました！\n{menu} / {staff} / {datetime}', approved: 'OK `${x}`', builtinReminders: true, calendarTitleFromNote: false };
  const { source, applied } = applyPatches(FIXTURE, buildPatches(msgs));
  assert.deepEqual(applied, ['notify.requested', 'notify.approved', 'notify.skipEmpty']);
  assert.ok(source.includes('return `受付しました！\n${ctx.menuName} / ${ctx.staffName} / ${ctx.startsAtJst}`;'));
  // バッククォートと ${ はエスケープされ、コードとして壊れない
  assert.equal(toTemplate('OK `${x}`'), 'OK \\`\\${x}\\`');
  assert.ok(source.includes("WHERE r.status IN ('pending','failed')\n")); // リマインドはそのまま
});

test('worker-fork: アンカーが無い／複数ある場合はエラーで止まる', () => {
  assert.throws(() => applyPatches(FIXTURE.replace('case "requested":', 'case "REQ":'), buildPatches({})), /notify\.requested/);
  assert.throws(() => applyPatches(FIXTURE + FIXTURE, buildPatches({})), /2 箇所/);
  // --check は元を変えない
  const { source } = applyPatches(FIXTURE, buildPatches({}), { check: true });
  assert.equal(source, FIXTURE);
});

test('worker-fork: カレンダーのタイトルはメモ 1 行目の「件名: 」から取り、メモからはその行を除く', () => {
  const { source } = applyPatches(FIXTURE, buildPatches({ calendarTitleFromNote: true }));
  assert.ok(source.includes('summary: (/^\\u4EF6\\u540D: (.+)/.exec(row.customer_note ?? "")?.[1] ??'));
  assert.ok(source.includes('row.customer_note.replace(/^\\u4EF6\\u540D: .*\\n?/, "")'));
  // 置換後のコードが実際に動くことを確認
  const row = { customer_note: '件名: 山田 太郎さん：Instagram ストーリー｜個別診断会\n[申込者情報]\nお名前：山田', friend_name: 'yamada', menu_name: '個別診断会' };
  const summary = (/^件名: (.+)/.exec(row.customer_note ?? '')?.[1] ?? `${row.friend_name ?? 'お客様'}｜${row.menu_name}`).slice(0, 200);
  assert.equal(summary, '山田 太郎さん：Instagram ストーリー｜個別診断会');
  assert.equal(row.customer_note.replace(/^件名: .*\n?/, ''), '[申込者情報]\nお名前：山田');
});
