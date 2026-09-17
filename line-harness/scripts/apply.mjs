#!/usr/bin/env node
// config/funnel.json を L Harness に反映する。何度実行しても同じ状態に収束する（名前で照合）。
//
//   node scripts/apply.mjs               タグ・シナリオを反映
//   node scripts/apply.mjs --booking     予約メニュー・担当者・受付時間も反映（LINE_HARNESS_ACCOUNT_ID 必須）
//   node scripts/apply.mjs --dry-run     書き込みせず、実行予定の API 呼び出しを表示
import {
  loadEnv, requireEnv, createApi, loadFunnelConfig, loadAssets, readMessageFile, parseArgs, ApiError,
} from './lib.mjs';

// ---------- ステップ本文の組み立て（純粋関数・テスト対象） ----------

/**
 * 設定上のステップ → API に送る { messageType, messageContent } を作る。
 * video ステップは assets の mp4Url があれば Flex(hero video)、無ければ linkUrl 付きテキスト。
 */
export function buildStepContent(step, { assets, bookingUrl }) {
  if (step.type === 'text') {
    let content = readMessageFile(step.file);
    if (content.includes('__BOOKING_URL__')) {
      if (!bookingUrl) throw new Error(`${step.file} は __BOOKING_URL__ を使うので .env の BOOKING_URL が必要です`);
      content = content.replaceAll('__BOOKING_URL__', bookingUrl);
    }
    return { messageType: 'text', messageContent: content };
  }
  if (step.type === 'video') {
    const asset = assets?.[step.asset];
    if (asset?.mp4Url && asset?.previewUrl) {
      const template = readMessageFile('video.flex.json');
      const json = template
        .replaceAll('__VIDEO_URL__', asset.mp4Url)
        .replaceAll('__PREVIEW_URL__', asset.previewUrl)
        .replaceAll('__ASPECT_RATIO__', asset.aspectRatio || '9:16')
        .replaceAll('__TITLE__', step.title)
        .replaceAll('__CAPTION__', step.caption);
      JSON.parse(json); // 置換で JSON が壊れていないことを確認
      return { messageType: 'flex', messageContent: JSON.stringify(JSON.parse(json)) };
    }
    if (asset?.linkUrl) {
      const content = readMessageFile(step.fallbackFile).replaceAll('__LINK_URL__', asset.linkUrl);
      return { messageType: 'text', messageContent: content };
    }
    throw new Error(
      `動画アセット "${step.asset}" が config/assets.json にありません（mp4Url+previewUrl か linkUrl のどちらかが必要）`,
    );
  }
  throw new Error(`未知のステップ type: ${step.type}`);
}

/** シナリオ定義 → API 用ステップ配列（stepOrder 1始まり） */
export function buildStepPayloads(scenario, ctx) {
  return scenario.steps.map((step, i) => {
    const content = buildStepContent(step, ctx);
    const base = { stepOrder: i + 1, ...content };
    if (scenario.deliveryMode === 'absolute_time') {
      return { ...base, offsetDays: step.offsetDays ?? 0, deliveryTime: step.deliveryTime };
    }
    return { ...base, delayMinutes: step.delayMinutes ?? 0 };
  });
}

function stepDiffers(existing, desired, deliveryMode) {
  if (existing.messageType !== desired.messageType) return true;
  if (existing.messageContent !== desired.messageContent) return true;
  if (deliveryMode === 'absolute_time') {
    return existing.offsetDays !== desired.offsetDays || existing.deliveryTime !== desired.deliveryTime;
  }
  return existing.delayMinutes !== desired.delayMinutes;
}

// ---------- 反映 ----------

export async function ensureTags(api, tags, log) {
  const existing = (await api('GET', '/api/tags')).data;
  const byName = new Map(existing.map((t) => [t.name, t]));
  const ids = {};
  for (const tag of tags) {
    const found = byName.get(tag.name);
    if (found) {
      ids[tag.key] = found.id;
      log(`tag  = ${tag.name}`);
    } else {
      const created = await api('POST', '/api/tags', { body: { name: tag.name, color: tag.color } });
      ids[tag.key] = created?.data?.id ?? '(dry-run)';
      log(`tag  + ${tag.name}`);
    }
  }
  return ids;
}

export async function ensureScenario(api, key, scenario, ctx, log) {
  const { lineAccountId } = ctx;
  const list = (await api('GET', '/api/scenarios')).data;
  let found = list.find((s) => s.name === scenario.name);
  const desiredSteps = buildStepPayloads(scenario, ctx);

  if (!found) {
    const created = await api('POST', '/api/scenarios', {
      body: {
        name: scenario.name,
        description: scenario.description,
        triggerType: scenario.triggerType,
        deliveryMode: scenario.deliveryMode ?? 'relative',
        isActive: true,
        ...(lineAccountId ? { lineAccountId } : {}),
      },
    });
    log(`scenario + ${scenario.name}`);
    if (!created) { // dry-run
      for (const s of desiredSteps) log(`  step + #${s.stepOrder} (${s.messageType})`);
      return { key, id: '(dry-run)' };
    }
    found = created.data;
  } else {
    if (found.triggerType !== scenario.triggerType || !found.isActive) {
      await api('PUT', `/api/scenarios/${found.id}`, {
        body: { triggerType: scenario.triggerType, isActive: true, description: scenario.description },
      });
      log(`scenario ~ ${scenario.name} (trigger/active を更新)`);
    } else {
      log(`scenario = ${scenario.name}`);
    }
    if ((found.deliveryMode ?? 'relative') !== (scenario.deliveryMode ?? 'relative')) {
      throw new Error(
        `シナリオ「${scenario.name}」の deliveryMode は作成後に変更できません（現在 ${found.deliveryMode}）。` +
        `管理画面でシナリオを削除するか、funnel.json の name を変えて作り直してください`,
      );
    }
  }

  const detail = (await api('GET', `/api/scenarios/${found.id}`)).data;
  const existingSteps = [...(detail.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder);
  const mode = scenario.deliveryMode ?? 'relative';

  for (let i = 0; i < desiredSteps.length; i++) {
    const desired = desiredSteps[i];
    const current = existingSteps[i];
    const { stepOrder: _o, ...fields } = desired;
    if (!current) {
      await api('POST', `/api/scenarios/${found.id}/steps`, { body: desired });
      log(`  step + #${desired.stepOrder} (${desired.messageType})`);
    } else if (stepDiffers(current, desired, mode)) {
      await api('PUT', `/api/scenarios/${found.id}/steps/${current.id}`, { body: fields });
      log(`  step ~ #${desired.stepOrder} (${desired.messageType})`);
    } else {
      log(`  step = #${desired.stepOrder}`);
    }
  }
  for (const extra of existingSteps.slice(desiredSteps.length)) {
    await api('DELETE', `/api/scenarios/${found.id}/steps/${extra.id}`);
    log(`  step - #${extra.stepOrder}`);
  }
  return { key, id: found.id };
}

export async function ensureBooking(api, booking, tagIds, accountId, log) {
  const q = { account_id: accountId };

  // メニュー
  const menus = (await api('GET', '/api/booking/admin/menus', { query: q })).menus;
  let menu = menus.find((m) => m.name === booking.menu.name);
  const autoTagId = booking.menu.auto_tag ? tagIds[booking.menu.auto_tag] : null;
  const menuBody = {
    name: booking.menu.name,
    category_label: booking.menu.category_label ?? null,
    description: booking.menu.description ?? null,
    duration_minutes: booking.menu.duration_minutes,
    buffer_after_minutes: booking.menu.buffer_after_minutes ?? 0,
    base_price: booking.menu.base_price ?? 0,
    sort_order: booking.menu.sort_order ?? 0,
    is_active: true,
    auto_tag_id: autoTagId,
  };
  if (!menu) {
    const created = await api('POST', '/api/booking/admin/menus', { query: q, body: menuBody });
    menu = { id: created?.id ?? '(dry-run)', ...menuBody };
    log(`menu + ${booking.menu.name}`);
  } else {
    await api('PUT', `/api/booking/admin/menus/${menu.id}`, { query: q, body: menuBody });
    log(`menu ~ ${booking.menu.name}`);
  }

  // 担当者・提供メニュー・受付時間
  const staffList = (await api('GET', '/api/booking/admin/staff', { query: q })).staff ?? [];
  for (const s of booking.staff) {
    let staff = staffList.find((x) => x.name === s.name);
    if (!staff) {
      const created = await api('POST', '/api/booking/admin/staff', {
        query: q,
        body: { name: s.name, display_name: s.display_name ?? s.name, role: s.role ?? null, sort_order: s.sort_order ?? 0 },
      });
      staff = { id: created?.id ?? '(dry-run)' };
      log(`staff + ${s.name}`);
    } else {
      log(`staff = ${s.name}`);
    }
    await api('PUT', `/api/booking/admin/staff/${staff.id}/menus`, {
      query: q, body: { menus: [{ menu_id: menu.id, is_offered: true }] },
    });
    await api('PUT', `/api/booking/admin/staff/${staff.id}/availability-rules`, {
      query: q, body: { rules: booking.availabilityRules },
    });
    log(`  menus/availability ~ ${s.name}`);
  }
}

export async function applyAll({ api, config, assets, bookingUrl, lineAccountId, withBooking, log }) {
  const tagIds = await ensureTags(api, config.tags, log);
  const ctx = { assets, bookingUrl, lineAccountId };
  const scenarioIds = {};
  for (const [key, scenario] of Object.entries(config.scenarios)) {
    const r = await ensureScenario(api, key, scenario, ctx, log);
    scenarioIds[key] = r.id;
  }
  if (withBooking) {
    if (!lineAccountId) throw new Error('--booking には LINE_HARNESS_ACCOUNT_ID が必要です（01-setup.md §2-3）');
    await ensureBooking(api, config.booking, tagIds, lineAccountId, log);
  }
  return { tagIds, scenarioIds };
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  loadEnv();
  const args = parseArgs();
  const dryRun = args.has('dry-run');
  const config = loadFunnelConfig();
  const assets = loadAssets();
  if (!assets) console.warn('注意: config/assets.json がありません。動画ステップは失敗します（assets.example.json をコピーしてください）');
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY'), dryRun });
  try {
    const result = await applyAll({
      api, config, assets,
      bookingUrl: process.env.BOOKING_URL,
      lineAccountId: process.env.LINE_HARNESS_ACCOUNT_ID || null,
      withBooking: args.has('booking'),
      log: console.log,
    });
    console.log('\n完了' + (dryRun ? '（dry-run: 何も書き込んでいません）' : ''));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof ApiError) console.error(`API エラー: ${err.message}`);
    else console.error(`エラー: ${err.message}`);
    process.exit(1);
  }
}
