#!/usr/bin/env node
// 指定したシナリオの「全ステップ」に、配信時点で特定タグが付いていない人にだけ送る条件
// （conditionType: "tag_not_exists", conditionValue: タグID）を API で設定し、結果を検証する。
// 他のシナリオには触らない。
//
//   node scripts/scenario-condition.mjs --env=.env.lecture --scenario=講義_閲覧後未申込フォロー --tag=講義_相談会申込
//   node scripts/scenario-condition.mjs --env=.env.lecture --scenario=… --tag=… --dry-run   （書き込まず差分だけ表示）
//
// 検証（--dry-run でなければ自動で行う）:
//   1. シナリオを取り直し、全ステップが tag_not_exists / 対象タグID になっているか
//   2. /api/segments/count で「タグあり（＝配信対象外）」「タグなし（＝配信対象）」の人数を出す
//   3. タグが付いている友だちを何人か取り、L Harness と同じ判定（タグがあれば送らない）で対象外になることを確認
import { resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, parseArgs, ApiError, ROOT_DIR } from './lib.mjs';

/** タグ名（または ID）→ タグ。無ければ候補を添えてエラー */
export function findTag(tags, nameOrId) {
  const found = tags.find((t) => t.name === nameOrId) ?? tags.find((t) => t.id === nameOrId);
  if (!found) {
    throw new Error(`タグ「${nameOrId}」が見つかりません。登録済み: ${tags.map((t) => t.name).join('、') || '(なし)'}`);
  }
  return found;
}

/** シナリオ名（完全一致）→ シナリオ。無ければ候補を添えてエラー */
export function findScenario(scenarios, name) {
  const found = scenarios.find((s) => s.name === name);
  if (!found) {
    const similar = scenarios.filter((s) => s.name.includes('講義') || s.name.includes(name.slice(0, 3)));
    throw new Error(
      `シナリオ「${name}」が見つかりません（名前は完全一致）。` +
        `\n登録済み: ${(similar.length ? similar : scenarios).map((s) => `「${s.name}」`).join(' ') || '(なし)'}`,
    );
  }
  return found;
}

/** ステップ配列に対して「変更が要るもの」だけを返す */
export function planStepUpdates(steps, tagId) {
  return steps
    .slice()
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((s) => ({
      step: s,
      needsUpdate: s.conditionType !== 'tag_not_exists' || s.conditionValue !== tagId,
    }));
}

/**
 * L Harness の配信時判定（services/step-delivery.ts evaluateCondition）と同じ:
 * tag_not_exists は「そのタグを持っていれば送らない」。友だちのタグ配列で判定する。
 */
export function wouldDeliver(step, friendTagIds) {
  if (!step.conditionType) return true;
  if (!step.conditionValue) return false;
  if (step.conditionType === 'tag_not_exists') return !friendTagIds.includes(step.conditionValue);
  if (step.conditionType === 'tag_exists') return friendTagIds.includes(step.conditionValue);
  return false;
}

/**
 * 指定シナリオの全ステップに tag_not_exists 条件を設定する。
 * 戻り値: { scenario, tag, updated: [stepOrder...], unchanged: [stepOrder...] }
 */
export async function applyCondition(api, { scenarioName, tagName, log = console.log }) {
  const tags = (await api('GET', '/api/tags')).data ?? [];
  const tag = findTag(tags, tagName);
  const scenarios = (await api('GET', '/api/scenarios')).data ?? [];
  const scenario = findScenario(scenarios, scenarioName);
  const detail = (await api('GET', `/api/scenarios/${scenario.id}`)).data;
  const steps = detail?.steps ?? [];
  if (!steps.length) throw new Error(`シナリオ「${scenario.name}」にステップがありません`);

  log(`シナリオ: ${scenario.name} (${scenario.id})  有効=${scenario.isActive ? 'はい' : 'いいえ'}  ステップ ${steps.length} 件`);
  log(`条件: タグ「${tag.name}」(${tag.id}) が付いていない人にだけ送る（tag_not_exists）`);

  const updated = [];
  const unchanged = [];
  for (const { step, needsUpdate } of planStepUpdates(steps, tag.id)) {
    const cur = step.conditionType ? `${step.conditionType}=${step.conditionValue ?? ''}` : '条件なし';
    if (!needsUpdate) {
      unchanged.push(step.stepOrder);
      log(`  step = #${step.stepOrder}  (${cur})`);
      continue;
    }
    await api('PUT', `/api/scenarios/${scenario.id}/steps/${step.id}`, {
      body: { conditionType: 'tag_not_exists', conditionValue: tag.id },
    });
    updated.push(step.stepOrder);
    log(`  step ~ #${step.stepOrder}  ${cur} → tag_not_exists=${tag.id}`);
  }
  return { scenario, tag, updated, unchanged };
}

/**
 * 設定後の検証。問題があれば Error を投げる。
 * 戻り値: { steps, withTag, withoutTag, sampled: [{ name, excluded }] }
 */
export async function verifyCondition(api, { scenarioId, tagId, accountId, log = console.log }) {
  const detail = (await api('GET', `/api/scenarios/${scenarioId}`)).data;
  const steps = [...(detail?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder);
  const bad = steps.filter((s) => s.conditionType !== 'tag_not_exists' || s.conditionValue !== tagId);
  if (bad.length) {
    throw new Error(`検証失敗: ステップ #${bad.map((s) => s.stepOrder).join(', #')} に条件が入っていません`);
  }
  log(`検証1: 全 ${steps.length} ステップが tag_not_exists / ${tagId} になっています`);

  const count = async (type) => {
    const r = await api('POST', '/api/segments/count', {
      body: { conditions: { operator: 'AND', rules: [{ type, value: tagId }] }, ...(accountId ? { accountId } : {}) },
    });
    return r?.count ?? null;
  };
  const withTag = await count('tag_exists');
  const withoutTag = await count('tag_not_exists');
  log(`検証2: タグあり（配信対象外）${withTag ?? '?'} 人 / タグなし（配信対象）${withoutTag ?? '?'} 人`);

  // タグが付いている友だちを取り、配信時と同じ判定で「送らない」になることを確認
  const res = await api('GET', '/api/friends', {
    query: { tagId, limit: 20, includeTags: 'true', ...(accountId ? { lineAccountId: accountId } : {}) },
  });
  const friends = res?.data?.items ?? res?.data ?? [];
  const sampled = friends.map((f) => {
    const ids = (f.tags ?? []).map((t) => t.id ?? t);
    const excluded = steps.every((s) => !wouldDeliver(s, ids));
    return { name: f.displayName ?? f.id, excluded };
  });
  const leaking = sampled.filter((s) => !s.excluded);
  if (leaking.length) {
    throw new Error(`検証失敗: タグ付きなのに配信対象になる友だち: ${leaking.map((s) => s.name).join('、')}`);
  }
  if (sampled.length) {
    log(`検証3: タグ付きの友だち ${sampled.length} 人（${sampled.map((s) => s.name).join('、')}）は全ステップで配信対象外です`);
  } else {
    log('検証3: タグが付いている友だちがまだいないため、実データでの確認はスキップ（判定ロジックはテスト済み）');
  }
  return { steps, withTag, withoutTag, sampled };
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs();
  loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
  const scenarioName = args.get('scenario');
  const tagName = args.get('tag');
  if (!scenarioName || !tagName) {
    console.error('使い方: node scripts/scenario-condition.mjs --env=.env.lecture --scenario=<シナリオ名> --tag=<タグ名> [--dry-run]');
    process.exit(2);
  }
  const dryRun = args.has('dry-run');
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY'), dryRun });
  try {
    const r = await applyCondition(api, { scenarioName, tagName });
    console.log(`\n更新 ${r.updated.length} 件 / 変更なし ${r.unchanged.length} 件${dryRun ? '（dry-run: 何も書き込んでいません）' : ''}`);
    if (!dryRun) {
      await verifyCondition(api, {
        scenarioId: r.scenario.id,
        tagId: r.tag.id,
        accountId: process.env.LINE_HARNESS_ACCOUNT_ID || undefined,
      });
      console.log('\n完了: 申込済み（タグあり）の人は配信時点で対象から外れます');
    }
  } catch (err) {
    if (err instanceof ApiError) console.error(`API エラー: ${err.message}`);
    else console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}
