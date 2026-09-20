# 講義動画ページ（LINE2 用）

LINE2 の配信文から飛ぶ「動画視聴ページ」。動画の下に「個別相談会に申し込む」ボタンがあり、
L Harness のアンケートフォーム（LIFF）へ飛ぶ。フォーム送信でタグ `講義_相談会申込` が付き、
予約ページの案内（シナリオ `講義_申込後フォロー`）が自動で届く。

```
LINE2 配信文 ── トラッキングリンク ──▶ このページ（動画）──▶ LIFF アンケート ──▶ タグ付与 ──▶ 予約案内
                    │ 開いた人にタグ「講義_視聴ページを開いた」
```

## 1. 設定を埋める

`index.html` の `<script id="config">` の JSON だけ編集する。

| キー | 内容 |
|---|---|
| `title` / `speaker` / `durationLabel` | 見出し。`durationLabel` は「約35分」など |
| `video.youtubeId` | YouTube の限定公開動画なら `https://youtu.be/XXXX` の `XXXX` |
| `video.vimeoId` | Vimeo なら数字ID |
| `video.mp4Url` | 自前ホスティング（R2 など）の mp4 URL。縦動画なら `"portrait": true` も追加 |
| `formUrl` | `https://liff.line.me/<LINE2 の LIFF ID>?page=form&id=<フォームID>`。フォームIDは `pnpm apply -- --config=config/funnel.lecture.json` の出力に出る |
| `points` | 見どころ。空配列にすると欄ごと消える |
| `bonus` | 特典動画（エクササイズ動画2本など）。`youtubeId` などが空のものは表示されない。全部空なら欄ごと消える |

YouTube は「限定公開」にし、「埋め込みを許可」をオンにする。
動画ファイルを直接置く場合、Cloudflare Pages は 1ファイル 25MB までなので講義動画は置けない。R2（公開バケット）か YouTube を使う。

`thumb.jpg`（1600×900・16:9）は LINE1 の誘導カードに使うサムネイル。このフォルダごと配備すると
`https://roots-lecture.pages.dev/thumb.jpg` で参照できる（`.env.line1` の `THUMB_URL`）。

## 2. Cloudflare Pages に置く（初回）

同じ Cloudflare アカウント（Retro）に、管理画面とは別の Pages プロジェクトを作る。
git 管理外のフォルダから実行しないとプレビュー扱いになるので、フォルダをコピーしてから配備する。

```powershell
# Windows PowerShell
Copy-Item -Recurse C:\Users\momoi\Roots-repo\line-harness\lecture-page $HOME\lecture-page -Force
cd $HOME\lecture-page
npx wrangler pages project create roots-lecture --production-branch main
npx wrangler pages deploy . --project-name roots-lecture --branch main
```

```bash
# Mac
cp -r /path/to/Roots/line-harness/lecture-page ~/lecture-page
cd ~/lecture-page
npx wrangler pages project create roots-lecture --production-branch main
npx wrangler pages deploy . --project-name roots-lecture --branch main
```

出力の `https://roots-lecture.pages.dev` がページ URL。`.env` の `LECTURE_PAGE_URL` に書く。
2回目以降は `deploy` の1行だけでよい。

## 3. 動作確認

- スマホの LINE で LINE2 のトラッキングリンクを開く → 動画が再生できる → ボタンでアンケートが開く
- 送信後、LINE2 に「アンケートありがとうございます」と予約案内の2通が届く
- 管理画面 → 友だち → 自分にタグ `講義_視聴ページを開いた` と `講義_相談会申込` が付いている

## 補足：L Harness の「オートウェビナー」を使わなかった理由

L Harness には動画ページ＋CTA フォーム＋その場で予約まで自動化する「オートウェビナー」機能がある。
ただし次の理由で、今回は自前の1枚ページにした。

- 疑似ライブ専用で、決まった開始時刻にしか視聴できない（見逃した人は次回まで待つ）
- 動画を HLS 形式に変換（ffmpeg）してアップロードする必要がある
- CTA 後のフォロー文面が L Harness 開発元の用途（AI導入相談）で固定されており、差し替えられない

「決まった時刻に一斉に見せて締切をつくる」運用に切り替えたくなったら、そのときに移行する。
