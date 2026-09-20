#!/usr/bin/env node
// 営業担当ごとの「Googleカレンダー接続リンク」を発行して表示する。
// リンクを本人に送り、本人の Google アカウントで許可してもらうだけで、その担当者のカレンダーが接続される。
// リンクの有効期限は 10 分（L Harness の仕様）。期限切れなら同じコマンドで発行し直す。
//
//   node scripts/google-link.mjs --env=.env.lecture              全員分の状態を表示（リンクは発行しない）
//   node scripts/google-link.mjs --env=.env.lecture --staff=徳原  徳原さんのリンクを発行
//   node scripts/google-link.mjs --env=.env.lecture --all         未接続の全員分を発行
import { resolve } from 'node:path';
import { loadEnv, requireEnv, createApi, parseArgs, ApiError, ROOT_DIR } from './lib.mjs';

export async function listStaffWithCalendar(api, accountId) {
  const q = { account_id: accountId };
  const staff = (await api('GET', '/api/booking/admin/staff', { query: q })).staff ?? [];
  const out = [];
  let oauthConfigured = true;
  for (const s of staff) {
    let connected = false;
    let detail = '';
    try {
      const cal = await api('GET', `/api/booking/admin/staff/${s.id}/google-calendar`, { query: q });
      const conn = cal?.connection ?? null;
      if (cal?.oauth && cal.oauth.configured === false) oauthConfigured = false;
      connected = Boolean(conn?.is_active);
      if (conn?.last_error) detail = `エラー: ${conn.last_error}`;
      else if (conn?.calendar_id) detail = String(conn.calendar_id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    out.push({ id: s.id, name: s.name, displayName: s.display_name, connected, detail });
  }
  out.oauthConfigured = oauthConfigured;
  return out;
}

export async function issueLink(api, accountId, staffId) {
  const res = await api('POST', `/api/booking/admin/staff/${staffId}/google-calendar/oauth/start`, {
    query: { account_id: accountId },
  });
  return res?.authorization_url ?? '(dry-run)';
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs();
  loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY') });
  const accountId = requireEnv('LINE_HARNESS_ACCOUNT_ID');
  try {
    const staff = await listStaffWithCalendar(api, accountId);
    if (staff.length === 0) {
      console.log('担当者が登録されていません。先に apply --booking を実行してください');
      process.exit(1);
    }
    if (!staff.oauthConfigured) {
      console.error('Google OAuth が Worker に設定されていません（GOOGLE_OAUTH_CLIENT_ID / SECRET を wrangler secret put してから wrangler deploy）');
      process.exit(1);
    }
    console.log('担当者と Googleカレンダーの状態:');
    for (const s of staff) {
      console.log(`  ${s.connected ? '接続済み' : '未接続  '}  ${s.name}（${s.displayName}）${s.detail ? '  ' + s.detail : ''}`);
    }
    const wanted = args.get('staff');
    const targets = args.has('all')
      ? staff.filter((s) => !s.connected)
      : wanted
        ? staff.filter((s) => s.name === wanted || s.displayName === wanted)
        : [];
    if (wanted && targets.length === 0) {
      console.error(`「${wanted}」という担当者が見つかりません（name か display_name と一致させてください）`);
      process.exit(1);
    }
    if (targets.length === 0) {
      console.log('\nリンクを発行するには --staff=名前 か --all を付けてください');
      process.exit(0);
    }
    console.log('\n本人に送る接続リンク（有効期限 10 分・本人の Google アカウントで許可してもらう）:');
    for (const s of targets) {
      const url = await issueLink(api, accountId, s.id);
      console.log(`\n■ ${s.name}\n${url}`);
    }
    if (staff.length > 1 && targets.length === 1) {
      console.log('\n※ 他の人のリンクを同時に発行したいときは --all');
    }
    console.log('\n許可が終わると、このコマンドをもう一度打てば「接続済み」に変わります。');
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      console.error('Google OAuth が Worker に設定されていません（GOOGLE_OAUTH_CLIENT_ID / SECRET を wrangler secret put してから wrangler deploy）');
    } else {
      console.error(`エラー: ${err.message}`);
    }
    process.exit(1);
  }
}
