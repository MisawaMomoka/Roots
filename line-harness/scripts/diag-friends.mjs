#!/usr/bin/env node
// 診断用: 友だち一覧（全アカウント）を「所属アカウント / 流入元(ref) / タグ / 登録日時」付きで表示する。読み取りだけ。
//   node scripts/diag-friends.mjs --env=.env.lecture            直近 50 人
//   node scripts/diag-friends.mjs --env=.env.lecture --limit=200
import { resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, parseArgs, ROOT_DIR } from './lib.mjs';

const args = parseArgs();
loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY') });

const accounts = (await api('GET', '/api/line-accounts')).data ?? [];
const accName = new Map(accounts.map((a) => [a.id, `${a.name ?? a.channelId ?? a.id}`]));
console.log('アカウント:');
for (const a of accounts) console.log(`  ${a.id.slice(0, 8)}  ${a.name ?? ''}  Messaging=${a.channelId ?? '-'}  Login=${a.loginChannelId ?? '-'}  LIFF=${a.liffId ?? '-'}`);

const limit = Number(args.get('limit') ?? 50);
const res = await api('GET', '/api/friends', { query: { limit, sort: 'recent', includeTags: 'true' } });
const friends = res?.data?.items ?? res?.data ?? res?.friends ?? [];
console.log(`\n友だち（直近 ${friends.length} 人 / 全 ${res?.data?.total ?? '?'} 人）:`);
console.log('  登録日時            所属       流入元(ref)     LINEユーザーID  名前 / タグ');
for (const f of friends) {
  const acc = f.lineAccountId ? (accName.get(f.lineAccountId) ?? f.lineAccountId.slice(0, 8)) : '(なし)';
  const tags = (f.tags ?? []).map((t) => t.name ?? t).join('、');
  console.log(`  ${String(f.createdAt ?? '').slice(0, 19).padEnd(19)}  ${String(acc).padEnd(9)}  ${String(f.refCode ?? '-').padEnd(14)}  ${String(f.lineUserId ?? '').slice(0, 8)}…  ${f.displayName ?? ''}${f.isFollowing ? '' : '（ブロック中）'}  ${tags ? '[' + tags + ']' : ''}`);
}

try {
  const rs = await api('GET', '/api/friends/ref-stats');
  console.log('\nref ごとの友だち数（全アカウント）:');
  for (const r of rs.routes ?? []) console.log(`  ${String(r.refCode).padEnd(16)} ${r.friendCount}`);
} catch (e) { console.log('\nref-stats 取得失敗:', e?.message ?? e); }
