// 共通ユーティリティ: .env 読み込み・L Harness API クライアント・JST 日時変換・設定ファイル読み込み
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = join(ROOT_DIR, 'config');
export const MESSAGES_DIR = join(CONFIG_DIR, 'messages');

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

// ---------- .env ----------

/** ROOT_DIR/.env を読み、process.env に無いキーだけ足す（既存の環境変数が優先） */
export function loadEnv(file = join(ROOT_DIR, '.env')) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です。.env.example を .env にコピーして埋めてください`);
  return v;
}

// ---------- API client ----------

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * L Harness API クライアントを作る。
 * 返る関数: api(method, path, { body?, query? }) → パース済み JSON
 * dryRun=true のとき GET 以外は実行せずログだけ出して null を返す。
 */
export function createApi({ apiUrl, apiKey, dryRun = false, log = console.log, fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, '');
  return async function api(method, path, { body, query } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    if (dryRun && method !== 'GET') {
      log(`[dry-run] ${method} ${url.pathname}${url.search}${body ? ' ' + JSON.stringify(body) : ''}`);
      return null;
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) throw new ApiError(method, path, res.status, parsed);
    return parsed;
  };
}

// ---------- JST ----------

/** UTC の Date/ISO 文字列を JST の各部に分解する */
export function toJstParts(input) {
  const d = new Date(new Date(input).getTime() + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD"（JST） */
export function jstDateString(input) {
  const p = toJstParts(input);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** "9月20日（土）" */
export function jstDateLabel(input) {
  const p = toJstParts(input);
  return `${p.m}月${p.d}日（${WEEKDAYS_JA[p.weekday]}）`;
}

/** "14:00" */
export function jstTimeLabel(input) {
  const p = toJstParts(input);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}

/** JST の日付文字列 "YYYY-MM-DD" と "HH:MM" から UTC の Date を作る */
export function jstDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS);
}

/** JST 日付文字列に日数を足す */
export function addDaysJst(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

// ---------- config ----------

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadFunnelConfig() {
  return loadJson(join(CONFIG_DIR, 'funnel.json'));
}

/** assets.json が無ければ null（apply はリンク無しで警告、sync は会議URL空で続行） */
export function loadAssets() {
  const path = join(CONFIG_DIR, 'assets.json');
  return existsSync(path) ? loadJson(path) : null;
}

export function readMessageFile(name) {
  return readFileSync(join(MESSAGES_DIR, name), 'utf8').replace(/\s+$/, '');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) values[a.slice(2, eq)] = a.slice(eq + 1);
    else flags.add(a.slice(2));
  }
  return { has: (f) => flags.has(f), get: (k) => values[k] };
}
