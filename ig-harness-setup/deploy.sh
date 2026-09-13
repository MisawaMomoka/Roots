#!/usr/bin/env bash
# ============================================================
# IG Harness 非対話デプロイ
#   公式 CLI `npx create-ig-harness` の setup と同じ手順を、ブラウザログインの代わりに
#   CLOUDFLARE_API_TOKEN で実行する。何度実行しても安全（作成済みの資源は再利用）。
#
#   使い方:  cp .env.example .env → 値を埋める → ./deploy.sh [.envのパス]
#   生成した値（API_KEY 等）は .deployed.env に保存される（gitignore 済み）
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="$ROOT/ig-harness"
ENV_FILE="${1:-$HERE/.env}"
STATE_FILE="$HERE/.deployed.env"

log() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die ".env が見つかりません: $ENV_FILE  （cp .env.example .env して埋めてください）"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -f "$STATE_FILE" ] && . "$STATE_FILE"
set +a

for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID IG_APP_SECRET IG_ACCESS_TOKEN IG_USER_ID; do
  [ -n "${!v:-}" ] || die "$v が未設定です（$ENV_FILE）"
done
[[ "$IG_USER_ID" =~ ^[0-9]+$ ]] || die "IG_USER_ID は数字のみです（現在: $IG_USER_ID）"
command -v node >/dev/null || die "Node.js 20+ が必要です"
command -v openssl >/dev/null || die "openssl が必要です"

# ---- 生成値（初回のみ生成、以降は .deployed.env から再利用） ----
: "${RESOURCE_SUFFIX:=$(openssl rand -hex 4)}"
: "${API_KEY:=$(openssl rand -hex 32)}"
: "${IG_VERIFY_TOKEN:=$(openssl rand -hex 16)}"
: "${LINE_HARNESS_LINK_SECRET:=$(openssl rand -hex 32)}"
: "${WORKER_NAME:=ig-harness-$RESOURCE_SUFFIX}"
: "${D1_DATABASE_NAME:=$WORKER_NAME}"
: "${R2_BUCKET_NAME:=$WORKER_NAME-images}"
: "${ADMIN_PROJECT_NAME:=ih-admin-${API_KEY:0:8}}"
D1_DATABASE_ID="${D1_DATABASE_ID:-}"
WORKER_URL="${WORKER_URL:-}"
ADMIN_URL="${ADMIN_URL:-}"

save_state() {
  umask 077
  cat > "$STATE_FILE" <<EOF
# deploy.sh が生成・取得した値。再実行時に再利用される。秘密情報を含むのでコミット禁止。
RESOURCE_SUFFIX=$RESOURCE_SUFFIX
API_KEY=$API_KEY
IG_VERIFY_TOKEN=$IG_VERIFY_TOKEN
LINE_HARNESS_LINK_SECRET=$LINE_HARNESS_LINK_SECRET
WORKER_NAME=$WORKER_NAME
D1_DATABASE_NAME=$D1_DATABASE_NAME
D1_DATABASE_ID=$D1_DATABASE_ID
R2_BUCKET_NAME=$R2_BUCKET_NAME
ADMIN_PROJECT_NAME=$ADMIN_PROJECT_NAME
WORKER_URL=$WORKER_URL
ADMIN_URL=$ADMIN_URL
EOF
}
save_state

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID FORCE_COLOR=0
# apps/worker の wrangler.toml はテンプレートで無効値を含むため、wrangler は必ずリポジトリ直下から実行する
wr() { (cd "$REPO" && npx wrangler "$@"); }
YES50="$(printf 'y\n%.0s' $(seq 1 50))"

# ---- 1. 依存関係 & パッケージビルド ----
log "1/8 依存関係インストール & パッケージビルド"
if [ ! -f "$REPO/pnpm-workspace.yaml" ]; then
  (cd "$ROOT" && git submodule update --init ig-harness)
fi
(cd "$REPO" && npx pnpm install --frozen-lockfile >/dev/null && npx pnpm --filter "./packages/*" build >/dev/null)
ok "ビルド完了"

# ---- 2. Cloudflare 認証 ----
log "2/8 Cloudflare 認証確認"
whoami_out="$(wr whoami 2>&1)" || die "wrangler whoami 失敗:\n$whoami_out"
echo "$whoami_out" | grep -q "$CLOUDFLARE_ACCOUNT_ID" || die "トークンでアカウント $CLOUDFLARE_ACCOUNT_ID にアクセスできません:\n$whoami_out"
ok "アカウント $CLOUDFLARE_ACCOUNT_ID"

# ---- 3. R2 ----
log "3/8 R2 バケット: $R2_BUCKET_NAME"
if out="$(wr r2 bucket create "$R2_BUCKET_NAME" 2>&1)"; then ok "作成"; else
  echo "$out" | grep -qiE "already exists|10006" && ok "既存を再利用" || die "$out"
fi

# ---- 4. D1 + スキーマ ----
log "4/8 D1 データベース: $D1_DATABASE_NAME"
if [ -z "$D1_DATABASE_ID" ]; then
  if out="$(wr d1 create "$D1_DATABASE_NAME" 2>&1)"; then
    D1_DATABASE_ID="$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  else
    echo "$out" | grep -qi "already exists" || die "$out"
  fi
  if [ -z "$D1_DATABASE_ID" ]; then
    D1_DATABASE_ID="$(wr d1 list --json 2>/dev/null | node -e '
      const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const db = list.find(d => d.name === process.argv[1]);
      if (!db) process.exit(1);
      process.stdout.write(db.uuid);' "$D1_DATABASE_NAME")" || die "D1 の ID を取得できません"
  fi
  save_state
fi
ok "database_id = $D1_DATABASE_ID"

d1exec() { printf '%s' "$YES50" | wr d1 execute "$D1_DATABASE_NAME" --remote --file "$1" >/dev/null 2>&1; }
if d1exec packages/db/schema.sql; then ok "schema.sql 適用"; else ok "schema.sql（既存テーブルあり・スキップ）"; fi
for f in "$REPO"/packages/db/migrations/*.sql; do
  rel="packages/db/migrations/$(basename "$f")"
  if d1exec "$rel"; then ok "$(basename "$f")"; else ok "$(basename "$f")（適用済み・スキップ）"; fi
done

# ---- 5. Worker デプロイ ----
log "5/8 Worker デプロイ: $WORKER_NAME"
DEPLOY_TOML="$REPO/apps/worker/wrangler.deploy.toml"
trap 'rm -f "$DEPLOY_TOML"' EXIT
cat > "$DEPLOY_TOML" <<EOF
name = "$WORKER_NAME"
main = "src/index.ts"
compatibility_date = "2024-12-01"
workers_dev = true
account_id = "$CLOUDFLARE_ACCOUNT_ID"

[[d1_databases]]
binding = "DB"
database_name = "$D1_DATABASE_NAME"
database_id = "$D1_DATABASE_ID"

[[r2_buckets]]
binding = "IMAGES"
bucket_name = "$R2_BUCKET_NAME"

[triggers]
crons = ["*/5 * * * *"]
EOF
out="$(cd "$REPO/apps/worker" && npx wrangler deploy --config wrangler.deploy.toml 2>&1)" || die "Worker デプロイ失敗:\n$out"
url="$(echo "$out" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1 || true)"
[ -n "$url" ] && WORKER_URL="$url"
[ -n "$WORKER_URL" ] || die "Worker URL を出力から取得できません:\n$out"
save_state
ok "$WORKER_URL"

# ---- 6. シークレット ----
log "6/8 シークレット設定"
put_secret() { printf '%s' "$2" | wr secret put "$1" --name "$WORKER_NAME" >/dev/null 2>&1 || die "secret put $1 失敗"; ok "$1"; }
put_secret IG_APP_SECRET "$IG_APP_SECRET"
put_secret IG_ACCESS_TOKEN "$IG_ACCESS_TOKEN"
put_secret IG_VERIFY_TOKEN "$IG_VERIFY_TOKEN"
put_secret IG_USER_ID "$IG_USER_ID"
put_secret API_KEY "$API_KEY"
put_secret LINE_HARNESS_LINK_SECRET "$LINE_HARNESS_LINK_SECRET"
# 公式 CLI は設定しないが、Worker はステップ配信/一斉配信のトラッキングリンク生成に WORKER_URL を使う
put_secret WORKER_URL "$WORKER_URL"
if [ -n "${IG_USERNAME:-}" ]; then put_secret IG_USERNAME "$IG_USERNAME"; fi
if [ -n "${CONTACT_EMAIL:-}" ]; then put_secret CONTACT_EMAIL "$CONTACT_EMAIL"; fi

# ---- 7. 管理画面 (Cloudflare Pages) ----
log "7/8 管理画面デプロイ: $ADMIN_PROJECT_NAME"
printf 'NEXT_PUBLIC_API_URL=%s\n' "$WORKER_URL" > "$REPO/apps/web/.env.production"
(cd "$REPO/apps/web" && npx pnpm run build >/dev/null) || die "管理画面のビルド失敗（apps/web で pnpm run build を単体実行して確認）"
wr pages project create "$ADMIN_PROJECT_NAME" --production-branch main >/dev/null 2>&1 || true
out="$(cd "$REPO/apps/web" && npx wrangler pages deploy out --project-name "$ADMIN_PROJECT_NAME" --commit-dirty=true 2>&1)" || die "管理画面デプロイ失敗:\n$out"
ADMIN_URL="https://$ADMIN_PROJECT_NAME.pages.dev"
sub="$(wr pages project list 2>/dev/null | grep -F "$ADMIN_PROJECT_NAME" | grep -oE '[A-Za-z0-9.-]+\.pages\.dev' | head -1 || true)"
[ -n "$sub" ] && ADMIN_URL="https://$sub"
save_state
ok "$ADMIN_URL"

# ---- 8. Claude Code 用 MCP 設定 ----
log "8/8 .mcp.json 生成（Claude Code / Cursor 用）"
MCP_BIN="$REPO/packages/mcp-server/dist/index.js"
[ -f "$MCP_BIN" ] || (cd "$REPO" && npx pnpm --filter @ig-harness/sdk --filter @ig-harness/mcp-server build >/dev/null)
node - "$ROOT/.mcp.json" "$MCP_BIN" "$WORKER_URL" "$API_KEY" <<'EOF'
const fs = require("fs");
const [file, bin, url, key] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["ig-harness"] = {
  command: "node",
  args: [bin],
  env: { IG_HARNESS_API_URL: url, IG_HARNESS_API_KEY: key },
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
EOF
ok "$ROOT/.mcp.json"

# ---- 完了 ----
cat <<EOF

============================================================
 デプロイ完了 🎉   次は Meta for Developers 側の設定です
============================================================

① Webhook（Instagram API ダッシュボード → ステップ3）
   コールバックURL : $WORKER_URL/webhook
   トークンを認証   : $IG_VERIFY_TOKEN
   購読フィールド   : messages, messaging_postbacks, comments, live_comments, mentions

② アプリ公開に必要な URL（アプリの設定 → ベーシック）
   プライバシーポリシーURL : $WORKER_URL/privacy-policy
   データ削除手順URL       : $WORKER_URL/data-deletion
   利用規約URL             : $WORKER_URL/terms-of-service
   ＋ アプリアイコン 1024x1024 PNG、カテゴリ「ビジネス」

③ Webhook 設定後に必ず実行（アカウントレベル購読 + 動作確認）
   ./ig-harness-setup/verify.sh

④ 管理画面 : $ADMIN_URL
   API Key  : $API_KEY   ← ログイン画面で入力（.deployed.env にも保存済み）

⑤ LINE Harness 連携用 共有シークレット（LINE 側の IG_HARNESS_LINK_SECRET に設定）
   $LINE_HARNESS_LINK_SECRET
EOF
