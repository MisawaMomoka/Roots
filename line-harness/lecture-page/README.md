# 講義動画ページ（LINE2 用・UTAGE 型）

LINE2 の配信文から飛ぶ「動画視聴ページ」。上から順に、

1. 視聴期限のカウントダウン（初回アクセスから 72 時間、または固定日時）
2. 講義動画（ミュートで自動再生 →「🔊 音の有効化」で音が出る）
3. 一定時間（初期値 10 分）視聴すると、その下に **申込フォームがページ内に出る**
4. 送信すると L Harness の友だちに紐づき、タグ `講義_相談会申込` → お礼＋予約案内が LINE に届く

```
LINE2 配信文 ── トラッキングリンク ──▶ このページ（LIFF）──▶ ページ内フォーム送信 ──▶ タグ付与 ──▶ 予約案内
                    │ 開いた人にタグ「講義_視聴ページを開いた」        │ 本人確認は LIFF のログイン情報
```

ページ内でフォームを送るには「誰が送ったか」を LINE 側で確認する必要があるため、**このページ自体を LINE2 の LIFF アプリとして登録する**（下記 §2）。
フォームの項目は L Harness 側（`config/funnel.lecture.json` の `forms.apply.fields`）から自動で読み込むので、項目を変えるときは JSON を直して `pnpm apply:lecture`。

---

## 1. 設定を埋める（`index.html` の `<script id="config">`）

| キー | 内容 |
|---|---|
| `liffId` | §2 で作る **このページ用の LIFF ID**（LINE2 のアンケート用 LIFF とは別） |
| `apiUrl` | Worker の URL（`https://roots-line.re-tro.workers.dev`） |
| `formId` | L Harness のフォーム ID（`pnpm apply:lecture` の出力 `formIds.apply`。設定済み） |
| `video.youtubeId` | 講義動画（YouTube 限定公開の 11 文字）。`vimeoId` / `mp4Url` でも可 |
| `deadline` | `{"mode":"evergreen","hours":72}` で初回アクセスから 72 時間。`{"mode":"fixed","fixedAt":"2026-10-01T23:59:00+09:00"}` で固定日時 |
| `unlockAfterSeconds` | フォームが出るまでの視聴秒数（600 = 10 分）。0 で最初から表示 |
| `bonus` | 特典動画。`youtubeId` が空のものは出ない |
| `submitLabel` ほか | ボタン・見出し・お礼文 |

YouTube は「限定公開」＋「埋め込みを許可」。動画ファイルを直接置く場合、Cloudflare Pages は 1 ファイル 25MB までなので講義動画は置けない（R2 か YouTube）。

---

## 2. LIFF アプリとして登録する（初回だけ）

1. LINE Developers → LINE2 の **LINE Login チャネル（2011653383）** → 「LIFF」タブ → 「追加」
   - LIFF アプリ名：`講義動画ページ`
   - サイズ：Full
   - エンドポイント URL：`https://roots-lecture.pages.dev`（§3 で配備する URL）
   - Scope：`profile` `openid`
   - 友だち追加オプション：On (aggressive)
   - 公開
2. 発行された LIFF ID（`2011653383-xxxxxxxx`）を `index.html` の `liffId` に入れる
3. **Worker の CORS 許可にこのページの URL を足す**（これが無いとフォームが読み込めず、予備リンクだけが出る）

```powershell
cd $HOME\.line-harness\apps\worker
npx wrangler secret put ADMIN_ORIGIN
```

値を聞かれたら、管理画面の URL と このページの URL を **カンマ区切りで1行**に：

```
https://roots-line-admin-a711620d.pages.dev,https://roots-lecture.pages.dev
```

4. `.env.lecture` の `LECTURE_PAGE_URL` を **LIFF の URL** にして、トラッキングリンクの飛び先を更新

```
LECTURE_PAGE_URL=https://liff.line.me/<このページの LIFF ID>
```

```powershell
cd C:\Users\momoi\Roots-repo\line-harness
node scripts/apply.mjs --env=.env.lecture --config=config/funnel.lecture.json
```

---

## 3. Cloudflare Pages に置く

初回はプロジェクト作成から。git 管理外のフォルダにコピーしてから配備する（ブランチ名を拾ってプレビュー扱いになるのを防ぐ）。

```powershell
Copy-Item -Recurse C:\Users\momoi\Roots-repo\line-harness\lecture-page $HOME\lecture-page -Force
cd $HOME\lecture-page
npx wrangler pages project create roots-lecture --production-branch main
npx wrangler pages deploy . --project-name roots-lecture --branch main
```

2 回目以降は `Copy-Item` と `deploy` の 2 行だけ。`thumb.jpg`（LINE1 の誘導カード用サムネイル）も一緒に上がる。

---

## 4. 動作確認

- スマホの LINE で LINE2 の配信文のリンクを開く → カウントダウンと動画が出る → 「音の有効化」で音が出る
- 10 分（`unlockAfterSeconds`）待つか、テスト中は一時的に `0` にして配備 → フォームが出る
- 送信 → 「送信ありがとうございます」→ LINE2 に「アンケートありがとうございます」と予約案内が届く
- 管理画面 → 友だち → 自分にタグ `講義_視聴ページを開いた` `講義_相談会申込`、フォーム回答に内容が入っている
- PC のブラウザで開いた場合は LINE ログイン画面が出る（ログインすれば同じように使える）

**フォームの代わりに「こちら（LINEのアンケート）」のリンクだけが出る場合**：`liffId` が未設定、または §2-3 の `ADMIN_ORIGIN` にこのページの URL が入っていない。

---

## 補足：L Harness の「オートウェビナー」を使わなかった理由

L Harness には動画ページ＋CTA フォーム＋その場で予約まで自動化する「オートウェビナー」機能がある。
ただし次の理由で、今回は自前の1枚ページにした。

- 疑似ライブ専用で、決まった開始時刻にしか視聴できない
- 動画を HLS 形式に変換（ffmpeg）してアップロードする必要がある
- CTA 後のフォロー文面が開発元の用途（AI導入相談）で固定されている
