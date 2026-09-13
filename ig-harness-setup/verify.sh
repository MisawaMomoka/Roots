#!/usr/bin/env bash
# ============================================================
# IG Harness 動作確認 + アカウントレベル Webhook 購読
#   deploy.sh 完了 → Meta コンソールで Webhook 設定 → このスクリプト
#   何度実行しても安全。
#
#   使い方: ./verify.sh [.envのパス]
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-$HERE/.env}"
STATE_FILE="$HERE/.deployed.env"
GRAPH="https://graph.instagram.com/v25.0"
FIELDS="messages,messaging_postbacks,comments,mentions"

ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
ng()   { printf '  \033[1;31m✖\033[0m %s\n' "$*"; FAIL=1; }
warn() { printf '  \033[1;33m！\033[0m %s\n' "$*"; }
log()  { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
FAIL=0

[ -f "$ENV_FILE" ] || { echo ".env が見つかりません: $ENV_FILE"; exit 1; }
[ -f "$STATE_FILE" ] || { echo ".deployed.env が見つかりません。先に deploy.sh を実行してください"; exit 1; }
set -a; . "$ENV_FILE"; . "$STATE_FILE"; set +a
for v in IG_ACCESS_TOKEN IG_USER_ID IG_VERIFY_TOKEN API_KEY WORKER_URL; do
  [ -n "${!v:-}" ] || { echo "$v が未設定です"; exit 1; }
done

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(JSON.stringify(j,null,2))}catch{console.log(s)}})'; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }

# ---- 1. Worker の Webhook 検証（hub.challenge） ----
log "1/5 Worker Webhook 検証  $WORKER_URL/webhook"
challenge="ping-$RANDOM"
res="$(curl -sS --max-time 20 "$WORKER_URL/webhook?hub.mode=subscribe&hub.verify_token=$IG_VERIFY_TOKEN&hub.challenge=$challenge" || true)"
if [ "$res" = "$challenge" ]; then ok "hub.challenge が返った（Verify Token 一致）"; else ng "応答: '$res'  （IG_VERIFY_TOKEN が Worker のシークレットと違う、または Worker 未デプロイ）"; fi

# ---- 2. トークンとアカウント ID ----
log "2/5 Instagram アクセストークン確認"
me="$(curl -sS --max-time 20 "$GRAPH/me?fields=id,user_id,username,account_type&access_token=$IG_ACCESS_TOKEN" || true)"
echo "$me" | json | sed 's/^/     /'
if [ -n "$(echo "$me" | jget error.message)" ]; then
  ng "トークンが無効です。Meta ダッシュボード → ステップ2 → 「トークンを生成」で再発行し .env の IG_ACCESS_TOKEN を更新"
else
  id="$(echo "$me" | jget id)"; uid="$(echo "$me" | jget user_id)"
  if [ "$id" = "$IG_USER_ID" ] || [ "$uid" = "$IG_USER_ID" ]; then ok "IG_USER_ID=$IG_USER_ID がトークンのアカウントと一致"; else warn "IG_USER_ID=$IG_USER_ID が id=$id / user_id=$uid のどちらとも一致しません。Meta ダッシュボードのステップ2に表示される数字を確認してください"; fi
fi

# ---- 3. アカウントレベル Webhook 購読（最重要・忘れると Webhook が届かない） ----
log "3/5 アカウントレベル Webhook 購読  POST /$IG_USER_ID/subscribed_apps"
sub="$(curl -sS --max-time 20 -X POST "$GRAPH/$IG_USER_ID/subscribed_apps?subscribed_fields=$FIELDS&access_token=$IG_ACCESS_TOKEN" || true)"
if [ "$(echo "$sub" | jget success)" = "true" ]; then ok "購読登録 {\"success\":true}"; else ng "購読登録に失敗: $sub"; fi
cur="$(curl -sS --max-time 20 "$GRAPH/$IG_USER_ID/subscribed_apps?access_token=$IG_ACCESS_TOKEN" || true)"
echo "$cur" | json | sed 's/^/     /'

# ---- 4. Worker API ヘルス ----
log "4/5 Worker API  GET /api/health"
health="$(curl -sS --max-time 20 -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/health" || true)"
code="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/health" || echo 000)"
if [ "$code" = "200" ]; then ok "200 OK"; else ng "HTTP $code（API_KEY 不一致 or Worker 異常）"; fi
echo "$health" | json | head -40 | sed 's/^/     /'

# ---- 5. フォロワー一覧（Webhook で DM を受けると増える） ----
log "5/5 フォロワー  GET /api/friends?limit=5"
curl -sS --max-time 20 -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/friends?limit=5" | json | head -40 | sed 's/^/     /'

cat <<EOF

------------------------------------------------------------
$( [ "$FAIL" = 0 ] && echo "✅ すべて通りました。" || echo "⚠️  失敗した項目があります。上の ✖ を確認してください。" )

次の手動テスト:
  1. 別の Instagram アカウントから自分のプロアカウントに DM を送る
  2. もう一度 ./verify.sh → 5/5 に送信者が並べば Webhook 経路は完成
  3. 届かない場合の切り分けは README.md「罠と対処」
------------------------------------------------------------
EOF
exit "$FAIL"
