# 講義動画ページ（LINE2 用・2ページ構成）

| ページ | 内容 |
|---|---|
| `index.html` | 視聴期限のカウントダウン → 講義動画（ミュート自動再生・「音の有効化」）→「【先着20名】無料で参加する」ボタン |
| `booking.html` | 日程の選択（L Harness の空き枠カレンダー）→ 情報入力 → 確認 → 送信 |

送信すると次の2つが同時に行われる。

1. フォーム回答が L Harness に保存され、タグ `講義_相談会申込` が付く → お礼＋受付連絡が LINE2 に届く
2. 選んだ日時で **予約リクエスト**が入る → `sync-bookings.mjs` が5分以内に自動承認 → 確定通知・前日・当日2時間前の配信

```
LINE2 配信文 ─ トラッキングリンク ─▶ index.html（動画）─▶ booking.html（カレンダー＋フォーム）─▶ フォーム保存＋予約リクエスト
                  │ 開いた人にタグ「講義_視聴ページを開いた」     │ 本人確認は LIFF のログイン情報
```

担当者（徳原・池端・重田）はお客さまには見えない。同じ時間に複数人が空いていれば、最初の人に割り当てる。

---

## 1. 設定を埋める

### `index.html` の `<script id="config">`

| キー | 内容 |
|---|---|
| `video.youtubeId` | 講義動画（YouTube 限定公開の 11 文字）。**空だと動画は出ず、黄色の注意が表示される** |
| `speedNote` / `ctaLabel` / `ctaNote` | 動画下の注記・ボタン文言 |
| `deadline` | `{"mode":"evergreen","hours":72}` で初回アクセスから 72 時間。`{"mode":"fixed","fixedAt":"2026-10-01T23:59:00+09:00"}` で固定日時 |
| `unlockAfterSeconds` | 0 ならボタンを最初から表示。600 なら 10 分視聴後に表示 |
| `bonus` | 特典動画。`youtubeId` が空のものは出ない |

### `booking.html` の `<script id="config">`

| キー | 内容 |
|---|---|
| `liffId` | このページ用の LIFF ID（`2011653383-ta1zojXE`・設定済み） |
| `accountLiffId` | LINE2 のアカウントに登録してある LIFF ID（`2011653383-oiECpx5P`・設定済み）。空き枠と予約の API がアカウントを特定するのに使う |
| `formId` | L Harness のフォーム ID（設定済み） |
| `menuName` | 予約メニュー名。`config/funnel.lecture.json` の `booking.menu.name` と同じにする |
| `title` / `intro` / `thanksBody` ほか | 見出し・説明文 |

フォームの項目（姓・名・フリガナ・メール・年齢・身長・体重・サポート希望・悩み・痩せたら・本気度・Meet 確認）は
`config/funnel.lecture.json` の `forms.apply.fields` が正本。変えたら `pnpm apply:lecture` で反映すると、ページ側も自動で追従する。

---

## 2. 初回だけの準備

1. **LIFF アプリの登録**：LINE Developers → LINE2 の LINE Login チャネル（2011653383）→ LIFF → 追加（名前 `講義動画ページ`、Full、エンドポイント `https://roots-lecture.pages.dev`、Scope `profile` `openid`、友だち追加オプション On (aggressive)、公開）→ 出た ID を `booking.html` の `liffId` に（設定済み：`2011653383-ta1zojXE`）
2. **Worker の CORS 許可**（これが無いとカレンダーもフォームも読み込めない）

```powershell
cd $HOME\.line-harness\apps\worker
npx wrangler secret put ADMIN_ORIGIN
```

値：`https://roots-line-admin-a711620d.pages.dev,https://roots-lecture.pages.dev`（カンマ区切り・空白なし）

3. `.env.lecture` の `LECTURE_PAGE_URL` を `https://liff.line.me/2011653383-ta1zojXE` にして `pnpm apply:lecture`（配信文のリンク先とフォーム項目を更新）

---

## 3. Cloudflare Pages に置く

```powershell
New-Item -ItemType Directory $HOME\lecture-page -Force | Out-Null
Copy-Item -Path C:\Users\momoi\Roots-repo\line-harness\lecture-page\* -Destination $HOME\lecture-page -Recurse -Force
cd $HOME\lecture-page
npx wrangler pages project create roots-lecture --production-branch main   # 初回のみ
npx wrangler pages deploy . --project-name roots-lecture --branch main
```

`Copy-Item` は必ず `\lecture-page\*`（`*` 付き）で。`*` 無しだと2回目以降は `$HOME\lecture-page\lecture-page\` に入れ子でコピーされ、古いページが配備され続ける。

`thumb.jpg`（LINE1 の誘導カード用）も一緒に上がる。

**配備前の確認**：`Copy-Item` はリポジトリ側のファイルをコピーするので、`index.html` の編集は `C:\Users\momoi\Roots-repo\line-harness\lecture-page\index.html` の方に行う（`$HOME\lecture-page` を直しても次のコピーで上書きされる）。

---

## 4. 動作確認

- スマホの LINE で `https://liff.line.me/2011653383-ta1zojXE` を開く → カウントダウンと動画 → 「音の有効化」で音 → ボタン
- 2ページ目：カレンダーに ○ の日が出る（担当者の受付時間と Google カレンダーの空き）→ 時間を選ぶ → 入力 → 確認 → 送信
- LINE2 に「お申し込みありがとうございます」→ 5分以内に「予約が確定しました」→ 相談会の確定文
- 管理画面（LINE2）→ 予約管理 に予約、友だち → フォーム回答 に内容
- PC で開いた場合は LINE ログイン画面が出る（ログインすれば同じように使える）

| 症状 | 原因 |
|---|---|
| 動画が出ず黄色の注意 | `index.html` の `youtubeId` が空、または古いファイルを配備 |
| カレンダーに ○ が1つも無い | 担当者の受付時間が未設定／Google カレンダー未接続で枠を閉じている／`menuName` 不一致 |
| 「読み込みに失敗しました」 | `ADMIN_ORIGIN` にこのページの URL が入っていない |
| 「LINE のログイン情報を確認できませんでした」 | `liffId` が違う、または LIFF が「開発中」のまま |

---

## Google Meet の URL について

L Harness の予約（サロン型）は Google カレンダーに予定を作るが、Meet のリンクは自動発行しない。
担当者ごとに **固定の Meet リンク**（Google Meet →「新しい会議を作成」→「後で使う会議を作成」）を作り、`config/assets.json` の `staffMeetingUrls` に入れる。当日2時間前の LINE にそのリンクが差し込まれる。

## 申込時のエラーの見分け方

送信時のエラー文の末尾に括弧で原因コードが出る。

| 括弧内 | 意味 | 直し方 |
|---|---|---|
| `form:Unauthorized` / `booking:Unauthorized` | LIFF の ID トークンを Worker が検証できない | ほとんどは **ID トークンの期限切れ**（LIFF はアクセストークン約12時間の間、約1時間で失効する ID トークンを使い回す）。ページ側で期限を見てログインし直す処理を入れてあり、エラー文に `期限切れ` と出る。`aud=` が `2011653383` 以外なら、管理画面 → LINEアカウント → LINE2 の「LINE Login チャネルID」を確認 |
| `form:Friend not found` / `booking:Friend not found` | ログインした LINE ユーザーが L Harness の友だちにいない | LINE Login チャネルと Messaging API チャネルが **同じプロバイダー** にあるか（別だとユーザー ID が食い違う）。管理画面の友だち一覧に自分がいるか |
| `booking:slot_conflict` | 直前に枠が埋まった | 別の枠を選ぶ（画面が自動で戻る） |
| `form:...`（その他） | フォームの必須項目や形式 | 管理画面のフォーム設定を確認 |

## カレンダーのメモと流入元

申込時に `customer_note` として「件名: 姓 名さん｜メニュー名（1 行目）/ [申込者情報] フォーム全項目 / 流入元 / 希望日時」を送る。1 行目は改造版 Worker（`worker-fork/`）がカレンダーの予定タイトルに使い、メモからは除く。L Harness はこれを Google カレンダーの予定メモ（`メモ:` 以降）にそのまま書く。
流入元は URL の `?src=<ref>`（LINE の配信リンクに付く）から取り、`<script id="config">` の `sourceLabels` で表示名に変換する（未登録のコードはそのまま表示）。
経路を増やしたら `sourceLabels` にも 1 行足して配備し直す。

## 予約できる最短時間

L Harness の最短受付時間は 60 分固定で管理画面からは変えられない。代わりに `<script id="config">` の `minLeadHours`（既定 24）で、
「今から N 時間後より前の枠」をカレンダーに出さないようにしている。変えたら配備し直す。

## 「講義ページを開いた」の記録（index.html）

`<script id="config">` の `openedRef`（`lecture_opened`）。LINE アプリ内で開かれたとき、本人の ID トークンと一緒に `/api/liff/link` へ送り、経路 `lecture_opened` のタグ `講義_視聴ページを開いた` を無言で付ける（1 端末 1 回）。
経路は `node scripts/entry-routes.mjs --env=.env.lecture --config=config/funnel.lecture.json` で作る。フォーム送信方式は「診断結果」カードが自動返信されるため使わない。
このタグがある人には、友だち追加 60 分後の「見どころ」メッセージを送らない。
