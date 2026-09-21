#!/usr/bin/env node
// config/funnel*.json を L Harness に反映する。何度実行しても同じ状態に収束する（名前で照合）。
//
//   node scripts/apply.mjs                                   config/funnel.json（LINE1・診断会）
//   node scripts/apply.mjs --config=config/funnel.lecture.json   LINE2・講義 → 相談会
//   node scripts/apply.mjs --env=.env.line1 --config=config/funnel.line1.json   LINE1・LINE2 への誘導
//   node scripts/apply.mjs --booking                          予約メニュー・担当者・受付時間も反映（LINE_HARNESS_ACCOUNT_ID 必須）
//   node scripts/apply.mjs --dry-run                          書き込みせず、実行予定の API 呼び出しを表示
//   node scripts/apply.mjs --env=.env.lecture ...             接続情報を別ファイルから読む（LINE2 用）
//
// 反映順: タグ → フォーム → トラッキングリンク → シナリオ → （--booking）予約
// 文面中のプレースホルダー:
//   __BOOKING_URL__        .env の BOOKING_URL
//   __LECTURE_LINK__       トラッキングリンク "lecturePage" の配信用 URL
//   __LECTURE_LINK_SRC__   講義ページ直リンク + ?src={{ref}}（流入元を申込ページまで引き継ぐ。配信時に L Harness が ref を展開）
//   __API_URL__            Worker の URL（LINE_HARNESS_API_URL）
//   __LECTURE_PAGE_URL__   .env の LECTURE_PAGE_URL（トラッキングリンクの飛び先）
//   __FORM_ID_<key>__      作成したフォームの ID（{{form_url:__FORM_ID_apply__}} のように使う）
//   __LINE2_CHANNEL_ID__ / __THUMB_URL__ / __THUMB_ASPECT__   .env.line1 の値（LINE1 の誘導 Flex 用）
//   __BONUS1_URL__ / __BONUS2_URL__   .env.lecture の特典動画 URL（YouTube 限定公開など）
import {
  loadEnv, requireEnv, createApi, loadFunnelConfig, loadAssets, readMessageFile, parseArgs, ApiError,
  ROOT_DIR,
} from './lib.mjs';
import { resolve } from 'node:path';

// ---------- 文面の組み立て（純粋関数・テスト対象） ----------

const PLACEHOLDER_RE = /__([A-Za-z][A-Za-z0-9_]*?)__/g;

/** 文面中の __X__ を ctx.placeholders で置き換える。未定義なら理由付きで失敗 */
export function fillPlaceholders(content, ctx, where) {
  return content.replace(PLACEHOLDER_RE, (m, key) => {
    const v = ctx.placeholders?.[key];
    if (v === undefined || v === null || v === '') {
      throw new Error(`${where}: プレースホルダー ${m} の値がありません（.env か apply の前段で作られる値です）`);
    }
    return v;
  });
}

/**
 * 設定上のステップ → API に送る { messageType, messageContent } を作る。
 * video ステップは assets の mp4Url があれば Flex(hero video)、無ければ linkUrl 付きテキスト。
 */
export function buildStepContent(step, ctx) {
  const dir = ctx.messagesDir;
  if (step.type === 'text') {
    const content = readMessageFile(step.file, dir);
    return { messageType: 'text', messageContent: fillPlaceholders(content, ctx, step.file) };
  }
  if (step.type === 'flex') {
    const json = fillPlaceholders(readMessageFile(step.file, dir), ctx, step.file);
    return { messageType: 'flex', messageContent: JSON.stringify(JSON.parse(json)) };
  }
  if (step.type === 'video') {
    const asset = ctx.assets?.[step.asset];
    if (asset?.mp4Url && asset?.previewUrl) {
      const template = readMessageFile('video.flex.json');
      const json = template
        .replaceAll('__VIDEO_URL__', asset.mp4Url)
        .replaceAll('__PREVIEW_URL__', asset.previewUrl)
        .replaceAll('__ASPECT_RATIO__', asset.aspectRatio || '9:16')
        .replaceAll('__TITLE__', step.title)
        .replaceAll('__CAPTION__', step.caption);
      return { messageType: 'flex', messageContent: JSON.stringify(JSON.parse(json)) };
    }
    if (asset?.linkUrl) {
      const content = readMessageFile(step.fallbackFile, dir).replaceAll('__LINK_URL__', asset.linkUrl);
      return { messageType: 'text', messageContent: fillPlaceholders(content, ctx, step.fallbackFile) };
    }
    throw new Error(
      `動画アセット "${step.asset}" が config/assets.json にありません（mp4Url+previewUrl か linkUrl のどちらかが必要）`,
    );
  }
  throw new Error(`未知のステップ type: ${step.type}`);
}

/** シナリオ定義 → API 用ステップ配列（stepOrder 1始まり、skipIfTag は tag_not_exists 条件に変換） */
export function buildStepPayloads(scenario, ctx) {
  return scenario.steps.map((step, i) => {
    const content = buildStepContent(step, ctx);
    const base = { stepOrder: i + 1, ...content };
    if (step.skipIfTag) {
      const tagId = ctx.tagIds?.[step.skipIfTag];
      if (!tagId) throw new Error(`${scenario.name} #${i + 1}: skipIfTag "${step.skipIfTag}" が tags に定義されていません`);
      base.conditionType = 'tag_not_exists';
      base.conditionValue = tagId;
    }
    if ((scenario.deliveryMode ?? 'relative') === 'absolute_time') {
      return { ...base, offsetDays: step.offsetDays ?? 0, deliveryTime: step.deliveryTime };
    }
    return { ...base, delayMinutes: step.delayMinutes ?? 0 };
  });
}

function stepDiffers(existing, desired, deliveryMode) {
  if (existing.messageType !== desired.messageType) return true;
  if (existing.messageContent !== desired.messageContent) return true;
  if ((existing.conditionType ?? null) !== (desired.conditionType ?? null)) return true;
  if ((existing.conditionValue ?? null) !== (desired.conditionValue ?? null)) return true;
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

export async function ensureForms(api, forms, ctx, log) {
  const ids = {};
  if (!forms) return ids;
  const existing = (await api('GET', '/api/forms')).data ?? [];
  for (const [key, def] of Object.entries(forms)) {
    const body = {
      name: def.name,
      description: def.description ?? null,
      fields: def.fields,
      onSubmitTagId: def.onSubmitTag ? ctx.tagIds[def.onSubmitTag] ?? null : null,
      onSubmitMessageType: def.onSubmitMessageFile ? 'text' : null,
      onSubmitMessageContent: def.onSubmitMessageFile
        ? fillPlaceholders(readMessageFile(def.onSubmitMessageFile, ctx.messagesDir), ctx, def.onSubmitMessageFile)
        : null,
      saveToMetadata: def.saveToMetadata ?? true,
      isActive: true,
    };
    const found = existing.find((f) => f.name === def.name);
    if (!found) {
      const created = await api('POST', '/api/forms', { body });
      ids[key] = created?.data?.id ?? '(dry-run)';
      log(`form + ${def.name}`);
    } else {
      await api('PUT', `/api/forms/${found.id}`, { body });
      ids[key] = found.id;
      log(`form ~ ${def.name}`);
    }
  }
  return ids;
}

export async function ensureTrackedLinks(api, links, ctx, log) {
  const urls = {};
  if (!links) return urls;
  const existing = (await api('GET', '/api/tracked-links')).data ?? [];
  for (const [key, def] of Object.entries(links)) {
    const originalUrl = fillPlaceholders(def.originalUrl, ctx, `trackedLinks.${key}`);
    const tagId = def.tag ? ctx.tagIds[def.tag] ?? null : null;
    const found = existing.find((l) => l.name === def.name);
    if (!found) {
      const created = await api('POST', '/api/tracked-links', {
        body: { name: def.name, originalUrl, tagId, ...(ctx.lineAccountId ? { lineAccountId: ctx.lineAccountId } : {}) },
      });
      urls[key] = created?.data?.trackingUrl ?? '(dry-run)';
      log(`link + ${def.name} → ${originalUrl}`);
    } else {
      if (found.originalUrl !== originalUrl || (found.tagId ?? null) !== tagId) {
        await api('PATCH', `/api/tracked-links/${found.id}`, { body: { originalUrl, tagId } });
        log(`link ~ ${def.name} → ${originalUrl}`);
      } else {
        log(`link = ${def.name}`);
      }
      urls[key] = found.trackingUrl;
    }
  }
  return urls;
}

export async function ensureScenario(api, key, scenario, ctx, log) {
  const { lineAccountId } = ctx;
  const list = (await api('GET', '/api/scenarios')).data;
  let found = list.find((s) => s.name === scenario.name);
  const desiredSteps = buildStepPayloads(scenario, ctx);
  const triggerTagId = scenario.triggerTag ? ctx.tagIds[scenario.triggerTag] : undefined;
  if (scenario.triggerType === 'tag_added' && !triggerTagId) {
    throw new Error(`${scenario.name}: triggerType tag_added には triggerTag（tags の key）が必要です`);
  }

  if (!found) {
    const created = await api('POST', '/api/scenarios', {
      body: {
        name: scenario.name,
        description: scenario.description,
        triggerType: scenario.triggerType,
        ...(triggerTagId ? { triggerTagId } : {}),
        deliveryMode: scenario.deliveryMode ?? 'relative',
        isActive: scenario.active !== false,
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
    const wantActive = scenario.active !== false; // 設定の "active": false で停止（既定は有効）
    const needsUpdate =
      found.triggerType !== scenario.triggerType ||
      Boolean(found.isActive) !== wantActive ||
      (triggerTagId && found.triggerTagId !== triggerTagId);
    if (needsUpdate) {
      await api('PUT', `/api/scenarios/${found.id}`, {
        body: {
          triggerType: scenario.triggerType,
          ...(triggerTagId ? { triggerTagId } : {}),
          isActive: wantActive,
          description: scenario.description,
        },
      });
      log(`scenario ~ ${scenario.name} (trigger/active を更新)`);
    } else {
      log(`scenario = ${scenario.name}`);
    }
    if ((found.deliveryMode ?? 'relative') !== (scenario.deliveryMode ?? 'relative')) {
      throw new Error(
        `シナリオ「${scenario.name}」の deliveryMode は作成後に変更できません（現在 ${found.deliveryMode}）。` +
        `管理画面でシナリオを削除するか、設定の name を変えて作り直してください`,
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
    // 担当者ごとの受付時間（staff[].availabilityRules）があればそれを、無ければ共通の booking.availabilityRules を使う
    await api('PUT', `/api/booking/admin/staff/${staff.id}/availability-rules`, {
      query: q, body: { rules: s.availabilityRules ?? booking.availabilityRules },
    });
    log(`  menus/availability ~ ${s.name}`);
  }
}

export async function applyAll({ api, config, assets, env = {}, lineAccountId, withBooking, log }) {
  const ctx = {
    assets,
    lineAccountId,
    messagesDir: config.messagesDir ?? null,
    tagIds: {},
    placeholders: {
      API_URL: env.LINE_HARNESS_API_URL ? env.LINE_HARNESS_API_URL.replace(/\/+$/, '') : undefined,
      BOOKING_URL: env.BOOKING_URL,
      LECTURE_PAGE_URL: env.LECTURE_PAGE_URL,
      // 講義ページの直リンクに流入元（LINE1 の ref）を付けて渡す。申込ページがカレンダーのメモに「流入元」を書くために使う
      LECTURE_LINK_SRC: env.LECTURE_PAGE_URL ? `${env.LECTURE_PAGE_URL}?src={{ref}}` : undefined,
      LINE2_CHANNEL_ID: env.LINE2_CHANNEL_ID,
      THUMB_URL: env.THUMB_URL,
      THUMB_ASPECT: env.THUMB_ASPECT || '16:9',
      BONUS1_URL: env.BONUS1_URL,
      BONUS2_URL: env.BONUS2_URL,
    },
  };
  ctx.tagIds = await ensureTags(api, config.tags, log);

  const formIds = await ensureForms(api, config.forms, ctx, log);
  for (const [key, id] of Object.entries(formIds)) ctx.placeholders[`FORM_ID_${key}`] = id;

  const linkUrls = await ensureTrackedLinks(api, config.trackedLinks, ctx, log);
  if (linkUrls.lecturePage) ctx.placeholders.LECTURE_LINK = linkUrls.lecturePage;

  const scenarioIds = {};
  for (const [key, scenario] of Object.entries(config.scenarios)) {
    const r = await ensureScenario(api, key, scenario, ctx, log);
    scenarioIds[key] = r.id;
  }
  if (withBooking) {
    if (!lineAccountId) throw new Error('--booking には LINE_HARNESS_ACCOUNT_ID が必要です（01-setup.md §2-7）');
    await ensureBooking(api, config.booking, ctx.tagIds, lineAccountId, log);
  }
  return { tagIds: ctx.tagIds, formIds, trackedLinkUrls: linkUrls, scenarioIds };
}

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = parseArgs();
  loadEnv(args.get('env') ? resolve(ROOT_DIR, args.get('env')) : undefined);
  const dryRun = args.has('dry-run');
  const config = loadFunnelConfig(args.get('config'));
  const assets = loadAssets();
  const usesVideo = Object.values(config.scenarios).some((s) => s.steps.some((st) => st.type === 'video'));
  if (usesVideo && !assets) console.warn('注意: config/assets.json がありません。動画ステップは失敗します（assets.example.json をコピーしてください）');
  const api = createApi({ apiUrl: requireEnv('LINE_HARNESS_API_URL'), apiKey: requireEnv('LINE_HARNESS_API_KEY'), dryRun });
  console.log(`設定: ${config.$file}`);
  try {
    const result = await applyAll({
      api, config, assets,
      env: process.env,
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
