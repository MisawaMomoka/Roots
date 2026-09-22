#!/usr/bin/env node
// 管理画面（L Harness）で直接直した文面を、リポジトリの config/messages/... のファイルに取り込む（apply.mjs の逆方向）。
// 実際の URL やフォーム ID は __BOOKING_URL__ / __LECTURE_LINK_SRC__ / __FORM_ID_apply__ などのプレースホルダーに戻す。
//
//   node scripts/pull-messages.mjs --env=.env.lecture --config=config/funnel.lecture.json                 差分を表示するだけ
//   node scripts/pull-messages.mjs --env=.env.lecture --config=config/funnel.lecture.json --write         ファイルを書き換える
//   node scripts/pull-messages.mjs ... --scenario=講義_閲覧後未申込フォロー   シナリオを絞る（設定の key か名前。カンマ区切り可）
//   node scripts/pull-messages.mjs ... --json                                    結果を JSON でも出す（自動化用）
//
// 対象は type: "text" のステップだけ。flex / video ステップはファイルの形が違うので取り込まない（表示だけ）。
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, loadFunnelConfig, readMessageFile, parseArgs, ApiError, ROOT_DIR, MESSAGES_DIR } from './lib.mjs';
import { envPlaceholders } from './apply.mjs';

/** 実際の値 → __KEY__ に戻す。長い値から順に置き換える（LECTURE_LINK_SRC は LECTURE_PAGE_URL を含むため） */
export function reversePlaceholders(content, placeholders) {
  const entries = Object.entries(placeholders)
    .filter(([, v]) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  let out = content;
  for (const [key, value] of entries) out = out.split(value).join(`__${key}__`);
  return out;
}

function normalize(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/** 設定のシナリオ（key/名前）を選ぶ。未指定なら全部 */
export function selectScenarios(config, spec) {
  const all = Object.entries(config.scenarios);
  if (!spec) return all;
  const wanted = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = all.filter(([key, sc]) => wanted.includes(key) || wanted.includes(sc.name) || wanted.includes(sc.renamedFrom));
  const missing = wanted.filter((w) => !picked.some(([key, sc]) => key === w || sc.name === w || sc.renamedFrom === w));
  if (missing.length) throw new Error(`設定にないシナリオ: ${missing.join('、')}（key または name: ${all.map(([k, s]) => `${k}=${s.name}`).join(' / ')}）`);
  return picked;
}

/**
 * 管理画面の文面を取得し、ファイルとの差分を返す。write=true ならファイルを書き換える。
 * 戻り値: [{ scenario, file, path, status: 'same'|'changed'|'skipped'|'missing', content?, note? }]
 */
export async function pullMessages(api, { config, env = {}, scenario, write = false, log = console.log, writeFile = writeFileSync }) {
  const placeholders = envPlaceholders(env);
  const forms = (await api('GET', '/api/forms')).data ?? [];
  for (const [key, def] of Object.entries(config.forms ?? {})) {
    const f = forms.find((x) => x.name === def.name);
    if (f) placeholders[`FORM_ID_${key}`] = f.id;
  }
  const links = (await api('GET', '/api/tracked-links')).data ?? [];
  for (const [key, def] of Object.entries(config.trackedLinks ?? {})) {
    const l = links.find((x) => x.name === def.name);
    if (l?.trackingUrl && key === 'lecturePage') placeholders.LECTURE_LINK = l.trackingUrl;
  }
  const scenarios = (await api('GET', '/api/scenarios')).data ?? [];
  const results = [];
  for (const [key, sc] of selectScenarios(config, scenario)) {
    const found = scenarios.find((s) => s.name === sc.name) ?? (sc.renamedFrom && scenarios.find((s) => s.name === sc.renamedFrom));
    if (!found) {
      log(`scenario ? ${sc.name}（管理画面に無い）`);
      results.push({ scenario: key, status: 'missing' });
      continue;
    }
    const steps = [...((await api('GET', `/api/scenarios/${found.id}`)).data?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder);
    log(`scenario ${found.name}（管理画面 ${steps.length} 通 / 設定 ${sc.steps.length} 通）`);
    sc.steps.forEach((step, i) => {
      const remote = steps[i];
      const label = `  #${i + 1} ${step.file ?? step.asset ?? ''}`;
      if (!remote) {
        log(`${label}: 管理画面にステップが無い → スキップ`);
        results.push({ scenario: key, file: step.file, status: 'missing' });
        return;
      }
      if (step.type !== 'text' || remote.messageType !== 'text') {
        log(`${label}: ${step.type}/${remote.messageType} は取り込み対象外`);
        results.push({ scenario: key, file: step.file, status: 'skipped' });
        return;
      }
      const content = normalize(reversePlaceholders(normalize(remote.messageContent), placeholders));
      const current = normalize(readMessageFile(step.file, config.messagesDir));
      const path = join(MESSAGES_DIR, config.messagesDir ?? '', step.file);
      if (content === current) {
        log(`${label}: 同じ`);
        results.push({ scenario: key, file: step.file, path, status: 'same' });
        return;
      }
      const leftover = content.match(/https?:\/\/\S+|\{\{form_url:[^_}][^}]*\}\}/g) ?? [];
      const note = leftover.length ? `プレースホルダーに戻せなかった値あり: ${leftover.join(' ')}` : undefined;
      if (write) {
        writeFile(path, content + '\n');
        log(`${label}: 書き換えた${note ? `（${note}）` : ''}`);
      } else {
        log(`${label}: 差分あり${note ? `（${note}）` : ''}`);
      }
      results.push({ scenario: key, file: step.file, path, status: 'changed', content, current, note });
    });
  }
  return results;
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs();
  loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
  const config = loadFunnelConfig(args.get('config'));
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY') });
  console.log(`設定: ${config.$file}`);
  try {
    const results = await pullMessages(api, { config, env: process.env, scenario: args.get('scenario'), write: args.has('write') });
    const changed = results.filter((r) => r.status === 'changed');
    console.log(`\n差分 ${changed.length} 件 / 同じ ${results.filter((r) => r.status === 'same').length} 件` + (args.has('write') ? '（ファイルを書き換えました）' : '（--write を付けると書き換えます）'));
    if (args.has('json')) {
      console.log('---PULL_MESSAGES_JSON---');
      console.log(JSON.stringify(results));
      console.log('---END_PULL_MESSAGES_JSON---');
    }
  } catch (err) {
    if (err instanceof ApiError) console.error(`API エラー: ${err.message}`);
    else console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}
