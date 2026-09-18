# 01. 環境構築

L Harness を Cloudflare にデプロイし、LINE公式アカウント・Googleカレンダー・Claude Code とつなぐまで。
公式の手順は [Getting-Started](https://github.com/Shudesu/line-harness-oss/blob/main/docs/wiki/Getting-Started.md) と
[導入動画（約20分）](https://youtu.be/DiRuGaeq1sM) が正本。ここでは**この案件で必要なところだけ**を順番に書く。

---

## §1 LINE Developers の準備（30分）

LINE公式アカウントは作成済みの前提。LINE Developers Console で **2つのチャネル** を用意する。

### 1-1. Messaging API チャネル

1. https://manager.line.biz/ → 公式アカウントを選ぶ → 右上の歯車（設定）→ 「Messaging API」→ プロバイダーを作る（社名でよい）
2. これで Messaging API チャネルが公式アカウントに紐づいた状態で作られる（LINE Developers Console にも同じチャネルが出る）
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
   - エンドポイントURL：**あとで** `https://<worker>?liffId=<LIFF ID>` に差し替える（仮で `https://example.com` でよい）
   - Scope：`profile` `openid`
   - サイズ：Full
3. 「LINEログイン設定」タブ
   - 「ウェブアプリでLINEログインを利用する」を ON
   - Callback URL：`https://<worker>.workers.dev/auth/callback`（Worker URL が決まったら追記）
4. 「リンクされたLINE公式アカウント」で公式アカウントを選び、友だち追加オプションを **On (aggressive)**
5. 控える値：LIFF ID、LINE Login チャネルID、チャネルシークレット

### 1-3. LINE Official Account Manager 側

https://manager.line.biz/ で以下を **オフ** にする（L Harness 側で制御するため）。

- 応答設定 → 「応答メッセージ」オフ、「あいさつメッセージ」オフ、「チャット」オフ、「Webhook」オン
- 1:1 の返信は L Harness の管理画面（チャット）から行う。詳細は §2-5

---

## §2 Cloudflare にデプロイ（30分〜1時間）

### まず、ここで何をするのかを1行で

**L Harness の本体（プログラムとデータベース）を、Cloudflare というサーバー会社の無料枠に置いて動かす**作業。
「Cloudflare にデプロイ」＝「Cloudflare 上に自分専用の L Harness を1つ立てる」という意味。

`npx create-line-harness` という1本のコマンドが、質問に答えていくだけで全部やってくれる。
自分でサーバーを触ったり設定ファイルを書いたりはしない。

### 2-0. 事前に用意するもの

| 用意するもの | 説明 | まだ無ければ |
|---|---|---|
| **Cloudflare アカウント** | サーバー会社のアカウント。無料 | https://dash.cloudflare.com/sign-up でメールアドレス登録 |
| **クレジットカード**（Cloudflare に登録） | 画像置き場（R2）を有効にするのに必要。10GB まで無料なので課金はされない | Cloudflare にログイン → Storage & Databases → R2 → Overview → 「Purchase R2 Plan」でカード登録 |
| **Node.js 22 以上** | パソコンでコマンドを動かすための土台 | https://nodejs.org/ から「LTS」をインストール |
| **ターミナル** | コマンドを打つ黒い画面 | Mac は「ターミナル」アプリ、Windows は「PowerShell」 |
| §1 で控えた5つの値 | Messaging API のチャネルID・シークレット・アクセストークン、LINE Login のチャネルID、LIFF ID | §1 に戻る |

確認コマンド（ターミナルに貼って Enter）：

```bash
node -v
```

`v22.x.x` のように出れば OK。`command not found` なら Node.js が入っていない。

### 2-1. コマンドを打つ場所に移動する

**git 管理されていないフォルダ**（ホームフォルダなど）で実行する。

```bash
cd ~                                  # Mac
cd $HOME                              # Windows PowerShell
```

理由：管理画面（Cloudflare Pages）のデプロイ時に wrangler が「今いるフォルダの git ブランチ名」を拾う。
このリポジトリのブランチ（`claude/...` など `main` 以外）の中で実行すると **プレビュー版として配備され、本番URLが「Nothing is here yet」になる**。

完了後、コマンドを打った場所に Claude Code 用の `.mcp.json` が作られるので、`line-harness` フォルダへ移す（§6）。

### 2-2. セットアップコマンドを実行する

```bash
npx create-line-harness@latest
```

初回は `Ok to proceed? (y)` と聞かれるので `y` + Enter。そこから対話が始まる。
**途中でやめても、もう一度同じコマンドを打てば続きから再開できる**（進み具合は `~/.line-harness/.line-harness-setup.json` に保存される）。

### 2-3. 質問に答えていく（出てくる順）

| 順 | 画面に出ること | 何をするか |
|---|---|---|
| 1 | 環境チェック中… | 何もしない。Node.js の版を確認しているだけ |
| 2 | **Cloudflare にログインが必要です**。ブラウザが開きます | ブラウザで Cloudflare にログインし、「Allow」を押す。ターミナルに戻ると「ログイン完了」と出る |
| 3 | 使用する Cloudflare アカウントを選択（複数ある人だけ） | 矢印キーで選んで Enter |
| 4 | **Step 1. Cloudflare 設定**：R2 Object Storage の有効化 | 2-0 でカード登録が済んでいれば、そのまま Enter |
| 5 | **プロジェクト名**（Worker と D1 の名前に使われます） | `roots-line` のように英小文字とハイフンだけで入力。URL の一部になる |
| 6 | **Step 2-1. Channel ID（数字）** | Messaging API チャネルの「チャネルID」を貼る |
| 7 | **Step 2-2. チャネルシークレット** | Messaging API チャネルの「チャネルシークレット」を貼る（画面には表示されない） |
| 8 | **Step 2-3. チャネルアクセストークン（長期）** | Messaging API 設定タブで「発行」したトークンを貼る |
| 9 | **Step 3-1. チャネル ID（LINE Login）** | LINE Login チャネルの「チャネルID」を貼る（Messaging API とは別の番号） |
| 10 | **Step 3-2. LIFF ID** | `2009554425-4IMBmLQ9` のような「数字-英字」の形。LIFF アプリが「公開済み」になっているか確認 |
| 11 | workers.dev サブドメイン名（初めて Cloudflare を使う人だけ） | `roots` のように短い英小文字。URL が `https://roots-line.roots.workers.dev` のようになる |
| 12 | D1 作成中… R2 作成中… Worker デプロイ中… Admin UI デプロイ中… | 5〜10分待つ。wrangler の英語ログが流れるが読まなくてよい |

### 2-4. 完了画面で控えるもの

最後に「セットアップ完了！」という枠が出る。**この枠の内容をすべてメモ帳にコピーしておく**（API Key は二度と表示されない）。

| 枠に出る項目 | この案件での使い道 | 書き写す先 |
|---|---|---|
| ② Webhook URL `https://<worker>/webhook` | LINE 側に設定する（2-5） | — |
| ③ Callback URL `https://<worker>/auth/callback` | LINE Login チャネルに設定する（2-5） | — |
| ④ LIFF エンドポイント URL `https://<worker>?liffId=…` | LINE Login チャネルの LIFF に設定する（2-5）。**`?liffId=` まで含めて貼る** | — |
| ⑤ 友だち追加 URL `https://<worker>/auth/line?ref=setup` | VSL やLPからの友だち追加はこの形の URL を使う（`ref=vsl` などに変えると流入元が記録される） | LP の担当者へ |
| ⑥ 管理画面 URL `https://<project>-admin.pages.dev` | 日常運用の画面。ログイン時に API Key を入力する | `.env` ではなくブックマーク |
| API Key | スクリプト・MCP・管理画面ログインの合言葉 | `.env` の `LINE_HARNESS_API_KEY` |
| Worker URL（上の URL の `https://…workers.dev` 部分） | API の住所 | `.env` の `LINE_HARNESS_API_URL` |

`.env` の作り方：

```bash
cp .env.example .env
```

をこのフォルダで実行し、テキストエディタで `.env` を開いて上の2つを書き込む。`.env` は git に入らない設定になっている。

同じフォルダに `.mcp.json` も自動で作られている（Claude Code 用。§6 参照）。中に API Key が入っているので、人に送らない。

### 2-5. LINE 側に URL を登録する（完了画面の ①〜④）

完了画面の指示どおりに、LINE 側の設定を4か所変える。

**① LINE Official Account Manager（https://manager.line.biz/）→ 設定 → 応答設定**

| 項目 | 設定 |
|---|---|
| チャット | オフ（1:1 の返信は L Harness の管理画面から行う） |
| あいさつメッセージ | オフ（シナリオ `診断会_友だち追加` が代わりに送る） |
| Webhook | **オン** |
| 応答メッセージ | オフ |

**② LINE Developers Console → Messaging API チャネル → 「Messaging API設定」タブ**

- Webhook URL に `https://<worker>/webhook` を貼って「更新」→「検証」で成功を確認 → 「Webhookの利用」をオン

**③ LINE Developers Console → LINE Login チャネル**

- 「リンクされたLINE公式アカウント」で公式アカウントを選択、友だち追加オプションを **On (aggressive)**
- 「LINEログイン設定」タブ → 「ウェブアプリでLINEログインを利用する」を ON → Callback URL に `https://<worker>/auth/callback`

**④ LINE Developers Console → LINE Login チャネル → 「LIFF」タブ**

- 作ってあった LIFF アプリの「エンドポイントURL」を、完了画面④の `https://<worker>?liffId=<LIFF ID>` に変更（`?liffId=` を省くと予約ページが開かない）

### 2-6. 動いているか確認する

1. スマホで公式アカウントを友だち追加する（完了画面⑤の URL を自分の LINE に送って開くと確実）
2. 管理画面 URL をブラウザで開き、API Key でログイン → 「友だち」に自分が出ていれば **Webhook が通っている**
3. ターミナルで API の疎通確認：

```bash
set -a; source .env; set +a
curl -s -H "Authorization: Bearer $LINE_HARNESS_API_KEY" "$LINE_HARNESS_API_URL/api/friends/count"
# → {"success":true,"data":{"count":1}}
```

### 2-7. アカウントIDを控える

L Harness は複数の公式アカウントを1つの管理画面で扱える設計なので、予約管理の API は「どのアカウントか」を毎回指定する。
自動生成された `.mcp.json` の `LINE_HARNESS_ACCOUNT_ID` に入っていればそれをコピー。空なら次のコマンドで取れる。

```bash
curl -s -H "Authorization: Bearer $LINE_HARNESS_API_KEY" "$LINE_HARNESS_API_URL/api/line-accounts" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s).data)console.log(a.id,a.displayName,a.liffId)})'
```

出てきた1つ目の値（UUID）を `.env` の `LINE_HARNESS_ACCOUNT_ID` に書く。3つ目の `liffId` は予約ページの URL に使う。

### よくあるつまずき

| 症状 | 原因と対処 |
|---|---|
| `npx: command not found` | Node.js が入っていない、またはターミナルを再起動していない |
| ブラウザが開かない（ログイン） | ターミナルに表示された URL を手でブラウザに貼る |
| R2 のところで止まる | Cloudflare にカードが登録されていない。2-0 の手順でカード登録してから Enter |
| `LIFF ID は「チャネルID-ランダム文字列」の形式です` | LINE Login チャネルの ID ではなく、LIFF タブに出ている `数字-英字` を貼る |
| Worker デプロイで `subdomain` のエラー | 2-3 の 11 で聞かれるサブドメイン登録が未完了。https://dash.cloudflare.com → Workers & Pages で「サブドメインを登録」してから再実行 |
| 途中で Ctrl+C した／エラーで止まった | もう一度 `npx create-line-harness@latest`。済んだ手順は飛ばして再開する |
| 管理画面 URL が「Nothing is here yet」 | git ブランチ（`main` 以外）の中で CLI を実行したため、プレビュー版として配備された。完了ログの `Deployment alias URL`（`https://<ブランチ名>.<project>.pages.dev`）は使える。本番URLに直すには `~/.line-harness/.line-harness-setup.json` の `completedSteps` から `"admin"` を消し、git 管理外のフォルダで CLI を再実行する |
| 管理画面にログインできない | 完了画面の API Key を貼る。コピー時に前後の空白が入っていないか確認 |
| 友だち追加しても管理画面に出ない | ②の Webhook URL が未設定か「Webhookの利用」がオフ。①の Webhook もオンか確認 |

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

`npx create-line-harness` を実行したフォルダ（§2-1 ならホームフォルダ）に `.mcp.json` が自動生成されている。
それを `line-harness` フォルダへ移動する。

```bash
mv ~/.mcp.json /path/to/Roots/line-harness/.mcp.json                       # Mac
Move-Item $HOME\.mcp.json C:\path\to\Roots\line-harness\.mcp.json      # Windows PowerShell
```

中身の `LINE_HARNESS_API_URL` `LINE_HARNESS_API_KEY` `LINE_HARNESS_ACCOUNT_ID` が `.env` と同じ値か確認する。
無ければ、ひな形からコピーして値を埋める。

```bash
cp .mcp.json.example .mcp.json     # このディレクトリで Claude Code を開いたときに読み込まれる
```

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
