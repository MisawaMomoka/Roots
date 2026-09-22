#!/usr/bin/env node
// 「タグ付与時」トリガーのシナリオに、シナリオ作成前からそのタグを持っていた人を手動で登録する。
// （L Harness のタグ付与時トリガーは「タグが新しく付いた瞬間」にしか動かないため）
//   node scripts/enroll-tagged.mjs --env=.env.lecture --scenario=講義_閲覧後未申込フォロー --dry-run   対象を表示するだけ
//   node scripts/enroll-tagged.mjs --env=.env.lecture --scenario=講義_閲覧後未申込フォロー             登録する
// 登録した時点から経過時間が始まる（1 通目は登録 + 先頭ステップのオフセット）。すでに登録済みの人・ブロック中の人は飛ばす。
import { resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, parseArgs, ApiError, ROOT_DIR } from './lib.mjs';

/** 登録対象を選ぶ（純粋関数）: タグを持ち、フォロー中で、未登録の人 */
export function pickTargets(friends, enrollments) {
  const enrolled = new Set(enrollments.map((e) => e.friendId ?? e.friend_id));
  return friends.filter((f) => f.isFollowing !== false && !enrolled.has(f.id));
}

export async function enrollTagged(api, { scenarioName, accountId, dryRun = false, log = console.log }) {
  const scenarios = (await api('GET', '/api/scenarios')).data ?? [];
  const scenario = scenarios.find((s) => s.name === scenarioName);
  if (!scenario) throw new Error(`シナリオ「${scenarioName}」が見つかりません`);
  if (scenario.triggerType !== 'tag_added' || !scenario.triggerTagId) {
    throw new Error(`シナリオ「${scenario.name}」はタグ付与時トリガーではありません（${scenario.triggerType}）`);
  }
  if (!scenario.isActive) throw new Error(`シナリオ「${scenario.name}」は停止中です。有効にしてから実行してください`);
  const tags = (await api('GET', '/api/tags')).data ?? [];
  const tag = tags.find((t) => t.id === scenario.triggerTagId);
  const detail = (await api('GET', `/api/scenarios/${scenario.id}`)).data;
  const first = [...(detail?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder)[0];
  const firstAfterMin = !first ? null
    : scenario.deliveryMode === 'elapsed' ? (first.offsetDays ?? 0) * 1440 + (first.offsetMinutes ?? 0)
    : scenario.deliveryMode === 'relative' ? (first.delayMinutes ?? 0) : null;
  log(`シナリオ: ${scenario.name}  トリガータグ: ${tag?.name ?? scenario.triggerTagId}  配信方式: ${scenario.deliveryMode}`);
  if (firstAfterMin !== null) log(`1 通目は登録の ${firstAfterMin} 分後（#${first.stepOrder}）`);

  const res = await api('GET', '/api/friends', {
    query: { tagId: scenario.triggerTagId, limit: 200, includeTags: 'false', ...(accountId ? { lineAccountId: accountId } : {}) },
  });
  const friends = res?.data?.items ?? res?.data ?? [];
  const enrollments = (await api('GET', `/api/scenarios/${scenario.id}/enrollments`, { query: { limit: 500 } })).data ?? [];
  const targets = pickTargets(friends, enrollments);
  log(`タグを持つ人 ${friends.length} 人 / 登録済み ${enrollments.length} 人 / 今回登録する ${targets.length} 人`);

  const done = [];
  const failed = [];
  for (const f of targets) {
    const name = f.displayName ?? f.id;
    if (dryRun) { log(`  [dry-run] 登録: ${name}`); done.push(name); continue; }
    try {
      const r = await api('POST', `/api/scenarios/${scenario.id}/enroll/${f.id}`);
      log(`  登録: ${name}  1 通目予定 ${r?.data?.nextDeliveryAt ?? r?.data?.next_delivery_at ?? '?'}`);
      done.push(name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { log(`  登録済み: ${name}`); continue; }
      log(`  失敗: ${name}  ${e.message}`);
      failed.push(name);
    }
  }
  return { scenario, targets: targets.length, done, failed };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs();
  loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
  const scenarioName = args.get('scenario');
  if (!scenarioName) { console.error('使い方: node scripts/enroll-tagged.mjs --env=.env.lecture --scenario=<シナリオ名> [--dry-run]'); process.exit(2); }
  const dryRun = args.has('dry-run');
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY') });
  try {
    const r = await enrollTagged(api, { scenarioName, accountId: process.env.LINE_HARNESS_ACCOUNT_ID || undefined, dryRun });
    console.log(`\n${dryRun ? '登録予定' : '登録完了'} ${r.done.length} 人${r.failed.length ? ` / 失敗 ${r.failed.length} 人` : ''}${dryRun ? '（dry-run: 何も書き込んでいません）' : ''}`);
    if (r.failed.length) process.exit(1);
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}
