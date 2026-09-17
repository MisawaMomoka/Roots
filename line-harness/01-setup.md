# 01. 環境構築

L Harness を Cloudflare にデプロイし、LINE公式アカウント・Googleカレンダー・Claude Code とつなぐまで。
公式の手順は [Getting-Started](https://github.com/Shudesu/line-harness-oss/blob/main/docs/wiki/Getting-Started.md) と
[導入動画（約20分）](https://youtu.be/DiRuGaeq1sM) が正本。ここでは**この案件で必要なところだけ**を順番に書く。

---

## §1 LINE Developers の準備（30分）

LINE公式アカウントは作成済みの前提。LINE Developers Console で **2つのチャネル** を用意する。

### 1-1. Messaging API チャネル

1. https://developers.line.biz/console/ → プロバイダーを作る（社名でよい）
2. 「Messaging API」チャネルを作成し、公式アカウントと紐づける
3. 控える値

| 項目 | 場所 |
|---|---|
| チャネルシークレット | Basic settings |
| チャネルアクセストークン（長期） | Messaging API タブ → Issue |
| チャネルID | Basic settings |

### 1-2. LINE Login チャネル（必須）

Messaging API だけだと予約ページ（LIFF）が動かず、PCから友だち追加した人の追跡もできない。

1. 同じプロバイダーに「LINE Login」チャネルを作成
2. 「LIFF」タブ → LIFFアプリを追加
   - エンドポイントURL：**あとで** Worker のURLに差し替える（仮で `https://example.com` でよい）
   - Scope：`profile` `openid`
   - サイズ：Full
3. 「LINEログイン設定」タブ
   - 「ウェブアプリでLINEログインを利用する」を ON
   - Callback URL：`https://<worker>.workers.dev/auth/callback`（Worker URL が決まったら追記）
4. 「リンクされたLINE公式アカウント」で公式アカウントを選び、友だち追加オプションを **On (aggressive)**
5. 控える値：LIFF ID、LINE Login チャネルID、チャネルシークレット

### 1-3. LINE Official Account Manager 側

https://manager.line.biz/ で以下を **オフ** にする（L Harness 側で制御するため）。

- 応答設定 → 「応答メッセージ」オフ、「あいさつメッセージ」オフ、「Webhook」オン
- チャット は オン のまま（管理画面の1:1返信と共存できる）

---

## §2 Cloudflare にデプロイ（30分）

```bash
# Node 22+ / pnpm 9+ を確認
node -v && pnpm -v

# セットアップCLI。Cloudflare ログイン → D1作成 → Worker/管理画面デプロイ →
# LINE認証情報の登録 → LIFF自動作成 → 管理者ユーザー作成 まで対話式で進む
npx create-line-harness@latest
```

聞かれること：

| 質問 | この案件での答え |
|---|---|
| プロジェクト名 | `roots-line` のような英小文字（Worker名・管理画面URLになる） |
| Messaging API チャネルシークレット／トークン | §1-1 の値 |
| LINE Login チャネルID／シークレット | §1-2 の値 |
| LIFF ID | §1-2 の値 |
| 管理画面 Owner のメール／パスワード | 運用者のもの |

完了すると次の3つが手に入る。**`.env` に控える**（`.env.example` をコピー）。

| 値 | 例 | 使い道 |
|---|---|---|
| Worker URL | `https://roots-line.<sub>.workers.dev` | API・Webhook・LIFFエンドポイント |
| 管理画面 URL | `https://roots-line-admin.pages.dev` | 日常運用 |
| API Key | `sk-...` | スクリプト・MCP・SDK |

### 2-1. デプロイ後に LINE Developers へ戻って設定

1. Messaging API チャネル → Webhook URL：`https://<worker>/webhook` → Verify → 「Webhookの利用」オン
2. LINE Login チャネル → LIFF のエンドポイントURLを `https://<worker>` に変更
3. LINE Login チャネル → Callback URL に `https://<worker>/auth/callback` を登録

### 2-2. 動作確認

```bash
# .env を読み込んで疎通確認
set -a; source .env; set +a
curl -s -H "Authorization: Bearer $LINE_HARNESS_API_KEY" "$LINE_HARNESS_API_URL/api/friends/count"
# → {"success":true,"data":{"count":0}}
```

自分のスマホで公式アカウントを友だち追加し、管理画面「友だち」に自分が出てくればOK。

### 2-3. アカウントIDを控える

L Harness はマルチアカウント前提なので、予約管理の API は `account_id` が必要。

```bash
curl -s -H "Authorization: Bearer $LINE_HARNESS_API_KEY" "$LINE_HARNESS_API_URL/api/line-accounts" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s).data)console.log(a.id,a.displayName,a.liffId)})'
```

出てきた `id` を `.env` の `LINE_HARNESS_ACCOUNT_ID` に書く。`liffId` も予約ページURLに使う。

---

## §3 Googleカレンダー連携（設置者が1回だけ・30分）

診断会の空き枠を「担当者のGoogleカレンダーの予定あり」から自動で除外するための設定。
詳細は公式の [28-Google-Calendar-and-Webinar-Booking.md](https://github.com/Shudesu/line-harness-oss/blob/main/docs/wiki/28-Google-Calendar-and-Webinar-Booking.md)。

1. Google Cloud Console でプロジェクト作成 → 「Google Calendar API」を有効化
2. OAuth 同意画面：アプリ名 `L Harness`、ユーザータイプは社外Googleアカウントも使うなら「外部」
   - スコープは次の2つだけ
     - `https://www.googleapis.com/auth/calendar.events`
     - `https://www.googleapis.com/auth/calendar.events.freebusy`
   - 「外部」でテスト状態のままだと数日で認可が切れる。本番前に「公開」にする
3. OAuth クライアントID（ウェブアプリケーション）を作成
   - 承認済みリダイレクトURI：`https://<worker>/api/booking/google-calendar/oauth/callback`（末尾スラッシュなし）
4. Worker にシークレットを登録して再デプロイ

```bash
cd ~/.line-harness/apps/worker      # create-line-harness がクローンした場所
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
pnpm deploy
```

---

## §4 管理画面で予約管理を設定（30分）

`pnpm apply --booking` でメニュー・担当者・受付時間は API から作れる（[03-operations.md](03-operations.md) §1）。
**Googleアカウントの接続だけは管理画面で人が押す必要がある。**

1. 管理画面 → 予約管理 → スタッフ → 担当者を選ぶ → 「Googleカレンダー連携」→「Googleアカウントで接続」
2. 診断会を担当する人のGoogleアカウントで許可 → 「接続済み」を確認
3. 予約管理 → メニュー に `個別体質診断会（Zoom・60分）` があり、「予約申込時に付与するタグ」が `診断会_予約申込` になっていることを確認
4. 予約管理 → スタッフ → 受付時間 に、`config/funnel.json` の `availabilityRules` の曜日・時間が入っていることを確認

### 予約ページのURL

友だちに案内する予約ページは次の形。`{LIFF_ID}` は §2-3 の `liffId`。

```
https://liff.line.me/{LIFF_ID}?page=book
```

このURLは `config/messages/welcome-01.txt` の中で `{{metadata.diag_booking_url}}` ではなく
**直接書く**（`apply.mjs` が `__BOOKING_URL__` を `.env` の値で置き換える）。

---

## §5 動画ファイルの置き場所（15分）

L Harness のシナリオは `text` `image` `flex` の3種類で、LINE の「動画メッセージ」型は使えない。
そのため動画は **Flex Message の hero に video を置く** 形で送る（LINEアプリ内でインライン再生される）。

必要なもの（動画1本につき）：

| 項目 | 条件 |
|---|---|
| 動画URL | HTTPS の **mp4**。縦 9:16 推奨。200MB 以下 |
| サムネイルURL | HTTPS の jpg/png。動画と同じ縦横比 |

置き場所の候補（どれでもよい）：

| 方法 | メモ |
|---|---|
| Cloudflare R2（公開バケット） | 無料枠10GB。`create-line-harness` が画像用に `line-harness-images` バケットを作っているので、同じアカウントに `roots-videos` を作って公開URLを付ける |
| Cloudflare Stream | mp4 ダウンロードURLを有効にする必要あり |
| 自社サイト | HTTPS であればよい |

URL が決まったら `config/assets.example.json` を `config/assets.json` にコピーして埋める。

mp4 が用意できない間は `assets.json` の `linkUrl`（YouTube 限定公開など）だけ埋めれば、
`apply.mjs` が「テキスト＋リンク」の形に自動で切り替える。

---

## §6 Claude Code に MCP を接続（10分）

```bash
cp .mcp.json.example .mcp.json     # このディレクトリで Claude Code を開いたときに読み込まれる
```

`.mcp.json` の `LINE_HARNESS_API_URL` `LINE_HARNESS_API_KEY` `LINE_HARNESS_ACCOUNT_ID` を `.env` と同じ値にする。
`.mcp.json` と `.env` は `.gitignore` 済みで、リポジトリには入らない。

接続後、Claude Code で次のように使える。

```
> 友だち数と有効なシナリオを教えて            → account_summary
> 未返信の会話を古い順に見せて                 → list_conversations
> 「診断会_予約確定」タグの人を一覧して         → list_friends
> 三沢さんに「明日よろしくお願いします」と送って → send_message（送信前に確認が入る）
```

MCP ツール一覧は公式の [24-MCP-Server.md](https://github.com/Shudesu/line-harness-oss/blob/main/docs/wiki/24-MCP-Server.md)。
予約管理とリマインドは MCP ツールが無いので、`scripts/` の API 直叩きで扱う。

---

## 完了チェック

- [ ] 友だち追加すると管理画面「友だち」に出る
- [ ] `https://liff.line.me/{LIFF_ID}?page=book` をスマホで開くと予約メニューが出る
- [ ] 担当者の Googleカレンダーが「接続済み」
- [ ] Googleカレンダーに入れた予定の時間帯が予約候補から消える
- [ ] `.env` に API URL / API Key / Account ID の3つが入っている
- [ ] Claude Code から `account_summary` が返ってくる
