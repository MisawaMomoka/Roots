#!/usr/bin/env node
// L Harness の配布済み Worker（bundle/worker/index.js）に、文言・動作の差し替えを当てる。
// すべて「完全一致するアンカー文字列を置き換える」方式。アンカーが見つからない／複数ある場合は
// エラーで止まる（L Harness のバージョンを上げたときに黙って壊れないため）。
//
//   node patch.mjs <index.js> [--messages=messages.json] [--check] [--out=<path>]
//     --check  置換せず、アンカーが全部一致するかだけ確認する
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** {menu} {staff} {datetime} → JS テンプレートリテラルの断片に。バッククォート等はエスケープ */
export function toTemplate(text) {
  const esc = String(text).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return esc.replace(/\{menu\}/g, '${ctx.menuName}').replace(/\{staff\}/g, '${ctx.staffName}').replace(/\{datetime\}/g, '${ctx.startsAtJst}');
}

export function buildPatches(messages) {
  const p = [];
  // 1. 受付／確定メッセージの文言（空なら送らない）
  p.push({
    name: 'notify.requested',
    from: '    case "requested":\n      return `\\u4E88\\u7D04\\u30EA\\u30AF\\u30A8\\u30B9\\u30C8\\u3092\\u53D7\\u3051\\u4ED8\\u3051\\u307E\\u3057\\u305F\\u3002${detail}\n\n\\u304A\\u5E97\\u304B\\u3089\\u306E\\u8FD4\\u4FE1\\u3092\\u304A\\u5F85\\u3061\\u304F\\u3060\\u3055\\u3044\\u3002`;\n    case "approved":',
    to: `    case "requested":\n      return \`${toTemplate(messages.requested ?? '')}\`;\n    case "approved":`,
  });
  p.push({
    name: 'notify.approved',
    from: '    case "approved":\n      return `\\u4E88\\u7D04\\u304C\\u78BA\\u5B9A\\u3057\\u307E\\u3057\\u305F\\u3002${detail}\n\n\\u5909\\u66F4\\u30FB\\u30AD\\u30E3\\u30F3\\u30BB\\u30EB\\u306F\\u304A\\u5E97\\u306B\\u76F4\\u63A5\\u3054\\u9023\\u7D61\\u304F\\u3060\\u3055\\u3044\\u3002`;\n    case "rejected":',
    to: `    case "approved":\n      return \`${toTemplate(messages.approved ?? '')}\`;\n    case "rejected":`,
  });
  // 2. 文言が空なら送信しない
  p.push({
    name: 'notify.skipEmpty',
    from: 'async function sendBookingNotification(params) {\n  const text2 = renderNotificationText(params.kind, params.ctx);\n',
    to: 'async function sendBookingNotification(params) {\n  const text2 = renderNotificationText(params.kind, params.ctx);\n  if (!text2) return;\n',
  });
  // 3. 標準リマインド（24時間前・2時間前）を止める
  if (messages.builtinReminders === false) {
    p.push({
      name: 'reminders.off',
      from: "         FROM booking_reminders r\n         INNER JOIN bookings b ON b.id = r.booking_id\n         INNER JOIN menus m ON m.id = b.menu_id\n         INNER JOIN staff s ON s.id = b.staff_id\n         INNER JOIN line_accounts la ON la.id = b.line_account_id\n         INNER JOIN friends f ON f.id = b.friend_id\n        WHERE r.status IN ('pending','failed')\n",
      to: "         FROM booking_reminders r\n         INNER JOIN bookings b ON b.id = r.booking_id\n         INNER JOIN menus m ON m.id = b.menu_id\n         INNER JOIN staff s ON s.id = b.staff_id\n         INNER JOIN line_accounts la ON la.id = b.line_account_id\n         INNER JOIN friends f ON f.id = b.friend_id\n        WHERE r.status IN ('pending','failed') AND 1 = 0 /* worker-fork: builtinReminders=false */\n",
    });
  }
  // 4. カレンダーの予定タイトル：メモ 1 行目が「件名: …」ならそれを使い、メモからはその行を除く
  if (messages.calendarTitleFromNote !== false) {
    p.push({
      name: 'calendar.title',
      from: '    summary: `${row.friend_name ?? "\\u304A\\u5BA2\\u69D8"}\\uFF5C${row.menu_name}`,\n',
      to: '    summary: (/^\\u4EF6\\u540D: (.+)/.exec(row.customer_note ?? "")?.[1] ?? `${row.friend_name ?? "\\u304A\\u5BA2\\u69D8"}\\uFF5C${row.menu_name}`).slice(0, 200),\n',
    });
    p.push({
      name: 'calendar.note',
      from: '      row.customer_note ? `\\u30E1\\u30E2: ${row.customer_note}` : ""\n',
      to: '      row.customer_note ? `\\u30E1\\u30E2: ${row.customer_note.replace(/^\\u4EF6\\u540D: .*\\n?/, "")}` : ""\n',
    });
  }
  return p;
}

export function applyPatches(source, patches, { check = false } = {}) {
  let out = source;
  const report = [];
  for (const { name, from, to } of patches) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`アンカー "${name}" が ${n} 箇所（1 箇所であるべき）。L Harness のバージョンが変わった可能性`);
    if (!check) out = out.replace(from, () => to);
    report.push(name);
  }
  return { source: out, applied: report };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=');
  if (!file) { console.error('使い方: node patch.mjs <bundle/worker/index.js> [--messages=messages.json] [--check] [--out=path]'); process.exit(1); }
  const messages = JSON.parse(readFileSync(resolve(HERE, opt('messages') || 'messages.json'), 'utf8'));
  const src = readFileSync(file, 'utf8');
  const check = args.includes('--check');
  const { source, applied } = applyPatches(src, buildPatches(messages), { check });
  if (!check) writeFileSync(opt('out') || file, source);
  console.log(`${check ? '確認OK' : '適用'}: ${applied.join(', ')}`);
}
