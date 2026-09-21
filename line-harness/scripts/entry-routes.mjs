#!/usr/bin/env node
// 流入経路ごとの「友だち追加リンク」を作り、経路別の友だち追加数・割合を集計する。
// インフルエンサーのストーリー用／リール用など、リンクを分けて配れば
// どこから何人が友だち追加したかが分かる（L Harness の entry_routes 機能）。
//
//   node scripts/entry-routes.mjs --env=.env.line1 --config=config/funnel.line1.json          経路を作成/更新してリンクを表示
//   node scripts/entry-routes.mjs --env=.env.line1 --config=config/funnel.line1.json --stats  経路別の人数と割合を表示
//   ... --dry-run                                                                              作成せず内容だけ表示
import { resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, loadFunnelConfig, parseArgs, ROOT_DIR } from './lib.mjs';
import { ensureTags } from './apply.mjs';

/** 友だち追加リンク（LINE Login 経由・ref 付き）。account は Messaging API のチャネルID */
export function buildFriendAddUrl(apiUrl, channelId, refCode) {
  const base = apiUrl.replace(/\/+$/, '');
  return `${base}/auth/line?account=${encodeURIComponent(channelId)}&ref=${encodeURIComponent(refCode)}`;
}

/** 設定の entryRoutes を API に反映（refCode で照合。名前・タグ・有効を更新）。戻り値 key → id */
export async function ensureEntryRoutes(api, routes, tagIds, log) {
  const existing = (await api('GET', '/api/entry-routes')).data ?? [];
  const byRef = new Map(existing.map((r) => [r.refCode, r]));
  const ids = {};
  for (const r of routes) {
    const tagId = r.tag ? tagIds?.[r.tag] ?? null : null;
    if (r.tag && !tagId) throw new Error(`経路 "${r.key}": tag "${r.tag}" が tags に定義されていません`);
    const desired = { refCode: r.refCode, name: r.name, tagId, isActive: r.isActive !== false, runAccountFriendAddScenarios: true };
    const found = byRef.get(r.refCode);
    if (!found) {
      const created = await api('POST', '/api/entry-routes', { body: desired });
      ids[r.key] = created?.data?.id ?? '(dry-run)';
      log(`route + ${r.name} (ref=${r.refCode})`);
      continue;
    }
    ids[r.key] = found.id;
    const differs = found.name !== desired.name || (found.tagId ?? null) !== desired.tagId || found.isActive !== desired.isActive
      || found.runAccountFriendAddScenarios !== true;
    if (differs) {
      await api('PATCH', `/api/entry-routes/${found.id}`, { body: desired });
      log(`route ~ ${r.name} (ref=${r.refCode})`);
    } else {
      log(`route = ${r.name} (ref=${r.refCode})`);
    }
  }
  return ids;
}

/** 経路ごとの集計行。割合は「一覧に載せた経路の友だち追加数の合計」に対する比率 */
export function summarize(routes, funnels) {
  const rows = routes.map((r) => {
    const f = funnels[r.key] ?? {};
    const clicks = Number(f.click_count ?? 0);
    const adds = Number(f.friend_add_count ?? 0);
    return { key: r.key, name: r.name, refCode: r.refCode, clicks, adds, forms: Number(f.form_submission_count ?? 0) };
  });
  const totalAdds = rows.reduce((s, x) => s + x.adds, 0);
  for (const x of rows) {
    x.share = totalAdds ? Math.round((x.adds / totalAdds) * 1000) / 10 : 0;
    x.addRate = x.clicks ? Math.round((x.adds / x.clicks) * 1000) / 10 : null;
  }
  return { rows, totalAdds };
}

export function formatStats({ rows, totalAdds }) {
  const lines = ['経路別の友だち追加（割合は経路合計に対する比率）', ''];
  lines.push('  経路                                 クリック   友だち追加   割合     申込');
  for (const x of rows) {
    const rate = x.addRate === null ? '' : `（クリック→追加 ${x.addRate}%）`;
    lines.push(`  ${x.name.padEnd(30, '　').slice(0, 30)}  ${String(x.clicks).padStart(6)}   ${String(x.adds).padStart(8)}   ${String(x.share + '%').padStart(6)}   ${String(x.forms).padStart(4)}  ${rate}`);
  }
  lines.push('', `  合計 友だち追加: ${totalAdds} 人`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
  const config = loadFunnelConfig(args.get('config'));
  const routes = config.entryRoutes ?? [];
  if (routes.length === 0) {
    console.error(`設定 ${config.$file} に entryRoutes がありません`);
    process.exit(1);
  }
  const dryRun = args.has('dry-run');
  const apiUrl = requireEnv('LINE_HARNESS_API_URL');
  const api = createApi({ apiUrl, apiKey: requireEnv('LINE_HARNESS_API_KEY'), dryRun });
  const accountId = requireEnv('LINE_HARNESS_ACCOUNT_ID');
  const accounts = (await api('GET', '/api/line-accounts')).data ?? [];
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`LINE_HARNESS_ACCOUNT_ID=${accountId} のアカウントが見つかりません`);
  if (!account.loginChannelId || !account.liffId) {
    console.warn('注意: このアカウントに LINE Login チャネルID か LIFF ID が未設定です。管理画面 → LINEアカウント → 編集で入れないと友だち追加リンクが動きません');
  }

  const log = (m) => console.log(m);
  if (args.has('stats')) {
    const existing = (await api('GET', '/api/entry-routes')).data ?? [];
    const funnels = {};
    for (const r of routes) {
      const found = existing.find((e) => e.refCode === r.refCode);
      if (!found) { console.warn(`未作成: ${r.name}（先に --stats なしで実行）`); continue; }
      funnels[r.key] = (await api('GET', `/api/entry-routes/${found.id}/funnel`)).data ?? {};
    }
    console.log(formatStats(summarize(routes, funnels)));
    return;
  }

  const tagIds = await ensureTags(api, config.tags ?? [], log);
  await ensureEntryRoutes(api, routes, tagIds, log);
  console.log('\n配布用リンク（この URL をそのまま貼る）:');
  for (const r of routes) {
    console.log(`\n■ ${r.name}\n${buildFriendAddUrl(apiUrl, account.channelId, r.refCode)}`);
  }
  console.log('\n集計: node scripts/entry-routes.mjs --env=.env.line1 --config=config/funnel.line1.json --stats');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    console.error('エラー:', err?.message ?? err);
    process.exit(1);
  });
}
