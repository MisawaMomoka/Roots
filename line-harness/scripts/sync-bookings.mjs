#!/usr/bin/env node
// 予約 → シナリオ登録の橋渡し。5分おきに実行する（03-operations.md §3）。
//
//   1. 承認待ち（requested）の予約を自動承認し、タグ「診断会_予約確定」を付ける
//   2. 確定予約ごとに友だちメタデータ（diag_date / diag_time / diag_staff / diag_meeting_url）を更新
//   3. タイミングが来たら「予約直後」「前日19時」「当日2時間前」のシナリオに登録する
//      送信済みかどうかは友だちメタデータ（diag_*_sent_for = 予約ID）で判定する
//
//   node scripts/sync-bookings.mjs                 実行
//   node scripts/sync-bookings.mjs --dry-run       書き込みなし
//   node scripts/sync-bookings.mjs --verbose       判断の理由も表示
import { execFileSync } from 'node:child_process';
import {
  loadEnv, requireEnv, createApi, loadFunnelConfig, loadAssets, parseArgs, ApiError,
  jstDateString, jstDateLabel, jstTimeLabel, jstDateTime, addDaysJst,
} from './lib.mjs';

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

// ---------- 判断ロジック（純粋関数・テスト対象） ----------

/**
 * 1件の確定予約について、今回の実行で何をすべきかを返す。
 * @returns {{ thanks: 'send'|'reschedule'|'skip_old'|null, prevday: 'send'|'skip_late'|null, sameday: 'send'|'skip_past'|null }}
 */
export function decideActions({ booking, meta, now, config }) {
  const startsAt = new Date(booking.starts_at);
  const nowMs = now.getTime();
  const out = { thanks: null, prevday: null, sameday: null };

  // 予約直後
  if (meta.diag_thanks_sent_for !== booking.id) {
    const decidedAt = booking.decided_at ? new Date(booking.decided_at) : startsAt;
    const ageMin = (nowMs - decidedAt.getTime()) / MS.minute;
    if (ageMin > (config.thanksMaxAgeMinutes ?? 180)) out.thanks = 'skip_old';
    else out.thanks = meta.diag_thanks_sent_for ? 'reschedule' : 'send';
  }

  // 前日 19:00（absolute_time シナリオ。前日の日付になったら登録し、配信時刻は L Harness 側が 19:00 に揃える）
  if (meta.diag_prevday_sent_for !== booking.id) {
    const prevDate = addDaysJst(jstDateString(startsAt), -1);
    const today = jstDateString(now);
    if (today === prevDate) {
      const cutoff = jstDateTime(prevDate, config.prevDay?.cutoffTime ?? '22:00');
      out.prevday = nowMs <= cutoff.getTime() ? 'send' : 'skip_late';
    } else if (today > prevDate) {
      out.prevday = 'skip_late'; // 前日を過ぎている（当日予約など）
    }
  }

  // 当日 2時間前
  if (meta.diag_sameday_sent_for !== booking.id) {
    const sendAt = startsAt.getTime() - (config.sameDay?.minutesBefore ?? 120) * MS.minute;
    if (nowMs >= startsAt.getTime()) out.sameday = 'skip_past';
    else if (nowMs >= sendAt) out.sameday = 'send';
  }
  return out;
}

/** 予約から友だちメタデータに書く値を作る */
export function buildMetadata(booking, assets) {
  const staff = booking.staff_name ?? '';
  const meetingUrl = assets?.staffMeetingUrls?.[staff] || assets?.defaultMeetingUrl || '';
  return {
    diag_booking_id: booking.id,
    diag_date: jstDateLabel(booking.starts_at),
    diag_time: jstTimeLabel(booking.starts_at),
    diag_staff: staff,
    diag_meeting_url: meetingUrl,
  };
}

// ---------- 実行 ----------

export async function runSync({ api, config, assets, accountId, now = new Date(), log = () => {}, info = console.log }) {
  const q = { account_id: accountId };
  const summary = { approved: 0, enrolled: { thanks: 0, reschedule: 0, prevday: 0, sameday: 0 }, skipped: 0, errors: 0 };

  // 名前 → ID を解決
  const scenarios = (await api('GET', '/api/scenarios')).data;
  const scenarioId = {};
  for (const [key, def] of Object.entries(config.scenarios)) {
    const found = scenarios.find((s) => s.name === def.name);
    if (!found && key !== 'welcome') throw new Error(`シナリオ「${def.name}」がありません。先に node scripts/apply.mjs を実行してください`);
    if (found) scenarioId[key] = found.id;
  }
  const tags = (await api('GET', '/api/tags')).data;
  const confirmedTag = tags.find((t) => t.name === config.tags.find((x) => x.key === 'confirmed')?.name);

  const menuName = config.booking?.menu?.name;
  const isTarget = (b) => !menuName || b.menu_name === menuName;

  // 1. 自動承認
  if (config.autoApprove) {
    const requested = (await api('GET', '/api/booking/admin/requests', { query: { ...q, status: 'requested' } })).requests ?? [];
    for (const b of requested.filter(isTarget)) {
      try {
        await api('PATCH', `/api/booking/admin/requests/${b.id}`, { query: q, body: { action: 'approve' } });
        summary.approved++;
        info(`承認: ${b.friend_name ?? b.friend_id} ${jstDateLabel(b.starts_at)} ${jstTimeLabel(b.starts_at)}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) log(`承認スキップ（別の操作が先行）: ${b.id}`);
        else { summary.errors++; console.error(`承認失敗 ${b.id}: ${err.message}`); }
      }
    }
  }

  // 2〜3. 確定予約の処理
  const confirmed = (await api('GET', '/api/booking/admin/requests', { query: { ...q, status: 'confirmed' } })).requests ?? [];
  const lookaheadMs = (config.lookaheadDays ?? 60) * MS.day;
  const window = confirmed.filter(isTarget).filter((b) => {
    const t = new Date(b.starts_at).getTime();
    return t > now.getTime() - MS.hour && t < now.getTime() + lookaheadMs;
  });

  for (const b of window) {
    try {
      const friend = (await api('GET', `/api/friends/${b.friend_id}`)).data;
      if (!friend?.isFollowing) { log(`ブロック中のためスキップ: ${b.id}`); continue; }
      const meta = friend.metadata ?? {};

      // メタデータ更新（予約が変わったときだけ）
      const desired = buildMetadata(b, assets);
      const changed = Object.entries(desired).some(([k, v]) => meta[k] !== v);
      if (changed) {
        await api('PUT', `/api/friends/${b.friend_id}/metadata`, { body: desired });
        Object.assign(meta, desired);
        log(`metadata 更新: ${friend.displayName} → ${desired.diag_date} ${desired.diag_time}`);
      }
      if (confirmedTag && !(friend.tags ?? []).some((t) => t.id === confirmedTag.id)) {
        try { await api('POST', `/api/friends/${b.friend_id}/tags`, { body: { tagId: confirmedTag.id } }); }
        catch (err) { if (!(err instanceof ApiError && err.status === 409)) throw err; }
      }

      const actions = decideActions({ booking: b, meta, now, config });
      const label = `${friend.displayName ?? b.friend_id} / ${desired.diag_date} ${desired.diag_time}`;

      const enroll = async (key, markKey, markValue) => {
        try {
          await api('POST', `/api/scenarios/${scenarioId[key]}/enroll/${b.friend_id}`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            log(`登録待ち（前回分が進行中）: ${config.scenarios[key].name} ${label}`);
            return false;
          }
          throw err;
        }
        await api('PUT', `/api/friends/${b.friend_id}/metadata`, { body: { [markKey]: markValue } });
        summary.enrolled[key]++;
        info(`登録: ${config.scenarios[key].name} ← ${label}`);
        return true;
      };
      const mark = async (markKey, reason) => {
        await api('PUT', `/api/friends/${b.friend_id}/metadata`, { body: { [markKey]: `skipped:${b.id}` } });
        summary.skipped++;
        log(`スキップ(${reason}): ${label}`);
      };

      if (actions.thanks === 'send') await enroll('thanks', 'diag_thanks_sent_for', b.id);
      else if (actions.thanks === 'reschedule') await enroll('reschedule', 'diag_thanks_sent_for', b.id);
      else if (actions.thanks === 'skip_old') await mark('diag_thanks_sent_for', '確定から時間が経過');

      if (actions.prevday === 'send') await enroll('prevday', 'diag_prevday_sent_for', b.id);
      else if (actions.prevday === 'skip_late') await mark('diag_prevday_sent_for', '前日19時を過ぎている');

      if (actions.sameday === 'send') await enroll('sameday', 'diag_sameday_sent_for', b.id);
      else if (actions.sameday === 'skip_past') await mark('diag_sameday_sent_for', '開始時刻を過ぎている');
    } catch (err) {
      summary.errors++;
      console.error(`予約 ${b.id} の処理に失敗: ${err.message}`);
    }
  }
  return summary;
}

/** 任意: 標準リマインド（24時間前・2時間前）を D1 直接更新で止める。wrangler ログイン済みが前提 */
export function cancelBuiltinReminders({ d1Name, workerDir, dryRun, info = console.log }) {
  const sql = "UPDATE booking_reminders SET status='cancelled' WHERE status IN ('pending','failed')";
  const args = ['wrangler', 'd1', 'execute', d1Name, '--remote', '--command', sql];
  if (dryRun) { info(`[dry-run] npx ${args.join(' ')}`); return; }
  execFileSync('npx', args, { cwd: workerDir, stdio: 'inherit' });
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  loadEnv();
  const args = parseArgs();
  const dryRun = args.has('dry-run');
  const verbose = args.has('verbose');
  const config = loadFunnelConfig();
  const assets = loadAssets();
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY'), dryRun });
  try {
    const summary = await runSync({
      api, config, assets,
      accountId: requireEnv('LINE_HARNESS_ACCOUNT_ID'),
      log: verbose ? console.log : () => {},
    });
    if (process.env.LINE_HARNESS_D1_NAME) {
      cancelBuiltinReminders({
        d1Name: process.env.LINE_HARNESS_D1_NAME,
        workerDir: (process.env.LINE_HARNESS_WORKER_DIR || '~/.line-harness/apps/worker').replace(/^~/, process.env.HOME ?? ''),
        dryRun,
      });
    }
    console.log(`${new Date().toISOString()} 承認 ${summary.approved} / 登録 ${JSON.stringify(summary.enrolled)} / スキップ ${summary.skipped} / エラー ${summary.errors}`);
    if (summary.errors > 0) process.exit(2);
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}
