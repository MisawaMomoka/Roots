# 03. 運用手順

前提：[01-setup.md](01-setup.md) が終わり、`.env` に API URL / API Key / Account ID が入っている。

```bash
cd line-harness
cp config/assets.example.json config/assets.json   # 動画URLと担当者のZoom URLを埋める
# 依存パッケージは無い（Node 22 標準機能のみ）。pnpm install は不要
```

---

## §1 定義を反映する（`apply`）

```bash
pnpm apply -- --dry-run      # 何が作られるかを見る
pnpm apply                   # タグ・シナリオを作成／更新
pnpm apply:booking           # 予約メニュー・担当者・受付時間も作成／更新
```

- **何度実行しても同じ結果**になる。名前（タグ名・シナリオ名・メニュー名・担当者名）で既存を探し、無ければ作り、違えば直す
- 文面を直したら `config/messages/*.txt` を編集して `pnpm apply` を打ち直すだけ
- シナリオの `deliveryMode` は作成後に変えられない。変えたいときは管理画面でシナリオを削除してから `apply`
- 担当者の Googleカレンダー接続だけは管理画面で行う（[01-setup.md](01-setup.md) §4）

### 作られるもの

| 種類 | 名前 | 用途 |
|---|---|---|
| タグ | `診断会_予約申込` | メニューの自動タグ。予約リクエスト時に付く |
| タグ | `診断会_予約確定` | 自動承認時にスクリプトが付ける |
| シナリオ | `診断会_友だち追加` | friend_add。予約ページの案内（**文面はドラフト**） |
| シナリオ | `診断会_予約直後` | manual。お礼→動画→当日までの過ごし方 |
| シナリオ | `診断会_日程変更` | manual。2回目以降の確定文 |
| シナリオ | `診断会_前日19時` | manual / absolute_time。前振り→動画→宿題 |
| シナリオ | `診断会_当日2時間前` | manual。Zoom URL・持ち物・担当者 |
| 予約メニュー | `個別体質診断会（Zoom・60分）` | 自動タグ＝`診断会_予約申込` |
| 担当者 | `funnel.json` の `booking.staff` | 提供メニューと受付時間も同時に設定 |

---

## §2 テスト（本番配信の前に必ず）

テスト用の LINE アカウント（自分のスマホでよい）で、一連の流れを **1回通す**。

1. 公式アカウントを友だち追加 → `診断会_友だち追加` の1通が届く
2. 予約ページ `https://liff.line.me/{LIFF_ID}?page=book` を開き、**翌日以降**の枠で予約する
3. 標準通知「予約リクエストを受け付けました」が届く
4. `pnpm sync -- --verbose` を手で実行する
   - 「承認: …」「登録: 診断会_予約直後 ← …」と出る
   - 標準通知「予約が確定しました」 → 1〜2分以内に `診断会_予約直後` の3通が届く
   - Googleカレンダーに予定が入っている
5. 管理画面 → 友だち → 自分 → メタデータに `diag_date` `diag_time` `diag_staff` `diag_meeting_url` `diag_thanks_sent_for` が入っている
6. 前日・当日のテストは日付を待たずに **確認用の予約を2つ作る**
   - 「明日 14:00」の予約 → `pnpm sync` → `診断会_前日19時` に登録される（19:00 に3通届く。19:00 以降に実行すれば即届く）
   - 「今日、2時間後」の予約（受付時間内・60分以上先）→ `pnpm sync` → `診断会_当日2時間前` が即届く
7. 動画が **LINE 内で再生**され、サムネイルが出ることをスマホで確認
8. `03-design-notes.md`（`../presales-education-video/`）の **NGワード一覧** に、届いた文面を照らす

テストで送った分は管理画面 → 友だち → メタデータから `diag_*_sent_for` を消せば再送できる（キーに `null` を入れると削除）。

---

## §3 `sync-bookings.mjs` を定期実行に載せる

5分おきに動かす。**これが止まると予約直後・前日・当日の3セットが止まる**ので、実行場所は落ちにくいものを選ぶ。

### 選択肢A：常時稼働の Mac / サーバーの cron（推奨・最も確実）

```cron
*/5 * * * * cd /path/to/Roots/line-harness && /usr/local/bin/node scripts/sync-bookings.mjs >> /var/log/roots-line-sync.log 2>&1
*/5 * * * * cd /path/to/Roots/line-harness && /usr/local/bin/node scripts/sync-bookings.mjs --env=.env.lecture --config=config/funnel.lecture.json >> /var/log/roots-line-sync-lecture.log 2>&1
```

### 選択肢A'：Windows のタスク スケジューラ（常時起動の PC 限定）

PC がスリープ・シャットダウンしている間は動かない（起動後にまとめて 1 回だけ追いつく）。常時起動できないなら選択肢 B にする。
PowerShell（1 行ずつ）：

```powershell
cd C:\Users\momoi\Roots-repo\line-harness
$dir = (Get-Location).Path
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c node scripts\sync-bookings.mjs --env=.env.lecture --config=config/funnel.lecture.json >> sync-lecture.log 2>&1" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "roots-line-sync-lecture" -Action $action -Trigger $trigger -Settings $settings -Description "LINE2 予約の自動処理（5分ごと）"
```

確認・操作：

```powershell
Start-ScheduledTask -TaskName roots-line-sync-lecture          # 今すぐ 1 回動かす
Get-Content sync-lecture.log -Tail 20                           # 直近のログ
Get-ScheduledTaskInfo -TaskName roots-line-sync-lecture         # 最終実行・次回実行・結果コード（0 が正常）
Unregister-ScheduledTask -TaskName roots-line-sync-lecture -Confirm:$false   # 止める
```

ログ `sync-lecture.log` は `.gitignore` 済み。

### 選択肢B：GitHub Actions（PC 不要・採用中）

ワークフローは `.github/workflows/line-sync-lecture.yml`（リポジトリ直下）。5 分おきに `sync-bookings.mjs --config=config/funnel.lecture.json` を実行する。
GitHub の混雑時は実行が 10 分以上遅れることがある（お礼・リマインドがその分遅れるだけで、抜けはしない）。

1. GitHub → リポジトリ → Settings → Secrets and variables → Actions → **New repository secret** で登録：

   | Name | Value |
   |---|---|
   | `LINE_HARNESS_API_URL` | `https://roots-line.re-tro.workers.dev` |
   | `LINE_HARNESS_API_KEY` | `.env.lecture` の `LINE_HARNESS_API_KEY=` の右側 |
   | `LINE_HARNESS_ACCOUNT_ID` | LINE2 のアカウント ID（`.env.lecture` の `LINE_HARNESS_ACCOUNT_ID=` の右側） |
   | `ASSETS_JSON`（任意） | `config/assets.json` の中身をそのまま（担当者ごとの Meet リンク） |

2. **既定ブランチ**にワークフローがあること（schedule は既定ブランチでしか動かない）。Settings → General → Default branch で確認・変更する。
3. Actions タブ → 「line-harness sync (lecture)」→ **Run workflow** で手動実行し、緑のチェックになるのを確認する。ログの最終行が `承認 n / 登録 {...} / スキップ n / エラー n`。
4. 以後は 5 分おきに自動実行。Actions タブで赤（失敗）が続いたら Secret を疑う。

**schedule が動かないときの確認（実際に起きた）**：schedule は「ワークフローファイルを最後にコミットした GitHub ユーザー」の権限で動く。Claude など GitHub ユーザーに紐づかない名義のコミットが最後だと、いつまでも Scheduled 実行が始まらない。ワークフローファイルは GitHub の画面（または三沢さんのアカウント経由）でコミットし直す。登録後も初回の Scheduled 実行まで 2〜3 時間かかることがある。

注意：既定ブランチを切り替えた直後は schedule が登録されず、次に既定ブランチへ push があるまで定期実行が始まらないことがある。Actions タブに「Scheduled」の実行が 15 分以上出ないときは、何か 1 コミット push する（このファイルの更新でよい）。
また、公開リポジトリでは **60 日間コミットがないと schedule が自動停止**する（Actions タブに警告が出る）。止まったら「Enable workflow」で再開する。
`config/assets.json` は `.gitignore` 済みなので、Meet リンクを変えたら Secret `ASSETS_JSON` も更新する。

### 選択肢B'：Cloudflare の cron から GitHub Actions を起動する（schedule が動かないときの代替・採用中）

GitHub の schedule は「ワークフローファイルを最後にコミットした GitHub ユーザー」の権限で動く仕様があり、登録されないことがある。
その場合は `dispatch-worker/`（Cloudflare Worker）を配備し、5 分おきに GitHub の `workflow_dispatch` API でワークフローを起動する。実行の実体・ログは引き続き GitHub Actions 側。

1. GitHub のトークンを発行：https://github.com/settings/personal-access-tokens/new → Token name 任意（例 `roots-line-sync`）→ Expiration は 1 年 → Repository access「Only select repositories」→ `Roots` → Permissions → Repository permissions → **Actions: Read and write** → Generate token → 表示された `github_pat_…` をコピー（この画面を閉じると二度と見られない）
2. PowerShell（1 行ずつ）：

```powershell
cd C:\Users\momoi\Roots-repo\line-harness\dispatch-worker
npx wrangler secret put GITHUB_TOKEN        # 貼り付けて Enter（画面には表示されない）
npx wrangler deploy
```

3. 5〜10 分後に GitHub の Actions タブを見る。「line-harness sync (lecture)」の実行が 5 分おきに増えていれば OK（Event は `workflow_dispatch`、実行者はトークンの持ち主）。
4. 止めるとき：`npx wrangler delete`（同じフォルダで）。トークンの期限が切れたら 1 → 2 の `secret put` だけやり直す。

### 選択肢C：L Harness プラグイン（Cloudflare Worker の cron）に移植

L Harness には別 Worker として動かす「プラグイン」の仕組みがある（`pnpm plugin:create`）。
`sync-bookings.mjs` の `runSync()` は API クライアントを引数で受け取る作りなので、Worker の `scheduled()` から呼ぶ形に移植できる。
運用が安定してから検討する。

### 監視

- 出力の最終行 `承認 n / 登録 {...} / スキップ n / エラー n` を見る。`エラー` が続くときは API Key か Account ID を疑う
- 終了コード：0 正常 / 1 設定エラー / 2 一部の予約で失敗
- 管理画面 → シナリオ → 各シナリオの「登録者」で、誰がいつ登録されたかを確認できる

---

## §4 日常運用

### 予約の承認・キャンセル・日程変更

| 操作 | やり方 |
|---|---|
| 承認 | 自動（`autoApprove: true`）。手動にしたいときは `funnel.json` を `false` にして管理画面「予約管理 → リクエスト」で承認 |
| キャンセル | 管理画面「予約管理」→ 該当予約 → キャンセル。Googleカレンダーの予定も消える |
| 日程変更 | **キャンセルしてから再予約**（友だちに予約ページから取り直してもらう、または管理画面から代理予約）。再予約分は動画なしの確定文が届き、前日・当日は新しい日程で送られる |
| 当日の飛び込み | 予約ページは60分以内の枠を出さないので、管理画面から代理予約する。前日分はスキップされ、当日分は開始2時間前を過ぎていれば送られない |

### 文面の変更

1. `config/messages/*.txt` を編集（`{{name}}` `{{metadata.diag_date}}` などはそのまま残す）
2. `pnpm apply`
3. 変更前後で `../presales-education-video/03-design-notes.md` の NGワードに照らす

`presales-education-video/` の原文から変えた点：

| 箇所 | 原文 | 変更後 | 理由 |
|---|---|---|---|
| 全通 | 〇〇さん | `{{name}}さん` | LINE 表示名の自動差し込み |
| 予約直後3通目・前日3通目 | ZoomのURLは当日の朝に送ります | ZoomのURLは当日、開始2時間前にお送りします | 実際の送信タイミング（当日リマインド＝2時間前）に合わせた |
| 当日 | 担当は〇〇です | `担当は{{metadata.diag_staff}}です` | 予約の担当者名を差し込み |
| 当日 | （URL） | `{{metadata.diag_meeting_url}}` | 担当者ごとの Zoom URL（`assets.json`） |
| 当日 | 「※持ち物は動画では触れていないので…」の注記 | 削除 | 制作メモであり配信文ではない |

### 担当者を増やす

1. `config/funnel.json` の `booking.staff` に追加、`config/assets.json` の `staffMeetingUrls` に Zoom URL を追加
2. `pnpm apply:booking`
3. 管理画面でその担当者の Googleカレンダーを接続

### 動画を差し替える

`config/assets.json` の URL を変えて `pnpm apply`。ステップの本文が更新される。すでに登録済み（前日待ち）の人にも新しい動画が届く。

---

## §5 Claude Code（MCP）でできること

`.mcp.json` を置いたこのディレクトリで Claude Code を開くと、次のような指示で運用できる。

| 指示の例 | 呼ばれるツール |
|---|---|
| 今週の予約確定者を一覧して | `list_friends`（タグ `診断会_予約確定`） |
| 未返信の会話を古い順に | `list_conversations` |
| ○○さんとの会話を見せて | `get_conversation` |
| ○○さんに「…」と返信して | `send_message`（送信前に確認される） |
| 予約確定者全員に「…」を配信して | `broadcast`（送信前に確認される） |
| 予約直後シナリオの2通目の文面を確認して | `manage_scenarios` |
| 先週の動画リンクのクリック数は？ | `get_link_clicks` |

MCP に無い操作（予約の承認・リマインド）はこのディレクトリの `scripts/` か、管理画面で行う。
Claude Code にこのディレクトリを見せておけば、`sync-bookings.mjs` の実行やログ確認も頼める。

---

## §6 トラブルシューティング

| 症状 | 見るところ |
|---|---|
| 予約直後の3通が届かない | `pnpm sync -- --verbose` の出力。「承認」が出ないなら予約が `requested` で止まっている（`autoApprove` と `menu_name` の一致）。「登録」が出ているのに届かないなら管理画面 → シナリオ → 登録者 → ステータス |
| 前日の3通が 19:00 に来ない | 前日のうちに `sync` が1回でも走ったか（cron のログ）。走っていれば L Harness の Cron（1分おき）が 19:00±5分で送る |
| 動画が再生されず画像だけ出る | mp4 の URL が HTTPS で直接開けるか、200MB 以下か、LINE のバージョン |
| `{{metadata.diag_date}}` がそのまま届く | `sync` がメタデータを書く前にシナリオが動いた。手動でシナリオ登録した場合に起きる。必ず `sync` 経由で登録する |
| 標準リマインドと2通同時に届く | 仕様（[02-flow-design.md](02-flow-design.md) 判断1）。止めるなら `.env` の `LINE_HARNESS_D1_NAME` |
| `HTTP 401` | API Key。`wrangler secret list` で `API_KEY` を確認 |
| `missing_account_id` | `.env` の `LINE_HARNESS_ACCOUNT_ID` |
