#!/usr/bin/env node
// 診断用（読み取りだけ）: シナリオの設定・登録者・進行状況を表示する。「誰にも送られない」の切り分け用。
//   node scripts/diag-scenario.mjs --env=.env.lecture                      全シナリオの一覧
//   node scripts/diag-scenario.mjs --env=.env.lecture --scenario=講義_閲覧後未申込フォロー   詳細（同名が複数あれば全部）
import { resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, parseArgs, ROOT_DIR } from './lib.mjs';

const args = parseArgs();
loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY') });
const accountId = process.env.LINE_HARNESS_ACCOUNT_ID || undefined;

const tags = (await api('GET', '/api/tags')).data ?? [];
const tagName = (id) => tags.find((t) => t.id === id)?.name ?? (id ? `(不明なタグ ${id})` : '-');
const accounts = (await api('GET', '/api/line-accounts')).data ?? [];
const accName = (id) => accounts.find((a) => a.id === id)?.name ?? (id ? id.slice(0, 8) : '(未指定)');
const scenarios = (await api('GET', '/api/scenarios')).data ?? [];

console.log('シナリオ一覧:');
for (const s of scenarios) {
  const trig = s.triggerType === 'tag_added' ? `タグ付与時（${tagName(s.triggerTagId)}）` : s.triggerType;
  console.log(`  ${s.isActive ? '有効' : '停止'}  ${s.name}  [${s.deliveryMode}]  トリガー: ${trig}  アカウント: ${accName(s.lineAccountId)}  作成: ${String(s.createdAt ?? '').slice(0, 16)}  id=${s.id}`);
}

const want = args.get('scenario');
if (!want) process.exit(0);
const targets = scenarios.filter((s) => s.name === want);
if (!targets.length) { console.log(`\nシナリオ「${want}」が見つかりません`); process.exit(1); }
if (targets.length > 1) console.log(`\n注意: 同名のシナリオが ${targets.length} 件あります`);

for (const s of targets) {
  console.log(`\n=== ${s.name} (${s.id}) ${s.isActive ? '有効' : '停止'} / ${s.deliveryMode} / トリガー ${s.triggerType}${s.triggerTagId ? `（${tagName(s.triggerTagId)}）` : ''}`);
  const detail = (await api('GET', `/api/scenarios/${s.id}`)).data;
  const steps = [...(detail?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder);
  console.log(`ステップ ${steps.length} 通:`);
  for (const st of steps) {
    const when = s.deliveryMode === 'absolute_time' ? `${st.offsetDays}日後 ${st.deliveryTime}`
      : s.deliveryMode === 'elapsed' ? `${st.offsetDays}日 ${st.offsetMinutes}分後`
      : `${st.delayMinutes}分後`;
    const cond = st.conditionType ? `条件: ${st.conditionType}（${tagName(st.conditionValue)}）` : '条件なし';
    console.log(`  #${st.stepOrder}  ${when}  ${st.messageType}  ${cond}  「${String(st.messageContent ?? '').replace(/\s+/g, ' ').slice(0, 30)}…」`);
  }
  try {
    const stats = (await api('GET', `/api/scenarios/${s.id}/stats`)).data;
    console.log(`集計: ${JSON.stringify(stats)}`);
  } catch (e) { console.log(`集計取得失敗: ${e.message}`); }
  try {
    const enr = (await api('GET', `/api/scenarios/${s.id}/enrollments`, { query: { limit: 50 } })).data ?? [];
    console.log(`登録者 ${enr.length} 人:`);
    for (const e of enr) {
      console.log(`  ${e.display_name ?? e.displayName ?? e.friend_id}  状態=${e.status}  済=${e.current_step_order ?? e.currentStepOrder}  次=#${e.next_step_order ?? e.nextStepOrder ?? '-'} ${e.next_delivery_at ?? e.nextDeliveryAt ?? ''}  ${e.reason ?? e.note ?? ''}`);
    }
  } catch (e) { console.log(`登録者取得失敗: ${e.message}`); }

  if (s.triggerType === 'tag_added' && s.triggerTagId) {
    const count = async (type) => (await api('POST', '/api/segments/count', {
      body: { conditions: { operator: 'AND', rules: [{ type, value: s.triggerTagId }] }, ...(accountId ? { accountId } : {}) },
    }))?.count;
    console.log(`トリガータグ「${tagName(s.triggerTagId)}」を持つ友だち: ${await count('tag_exists')} 人（このアカウント）`);
    const res = await api('GET', '/api/friends', { query: { tagId: s.triggerTagId, limit: 50, includeTags: 'false', ...(accountId ? { lineAccountId: accountId } : {}) } });
    for (const f of res?.data?.items ?? []) {
      console.log(`  ${f.displayName ?? f.id}  登録 ${String(f.createdAt ?? '').slice(0, 16)}  ${f.isFollowing ? '' : '（ブロック中）'}`);
    }
  }
}
