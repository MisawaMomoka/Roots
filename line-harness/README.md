# L Harness で公式LINEを構築する（体質診断VSL → 個別体質診断会）

株式会社ルーツ／ゆうなりさん案件の公式LINEを、OSSのLINE CRM
[L Harness（line-harness-oss）](https://github.com/Shudesu/line-harness-oss) の上に構築するための一式。

`../presales-education-video/` にある配信文・台本を、そのまま L Harness の
「予約管理・シナリオ・API」に載せるところまでを扱う。

## L Harness で何が置き換わるか

| 今までのやり方（Lステップ等を想定） | L Harness での置き場所 |
|---|---|
| 友だち追加時のあいさつ | シナリオ（トリガー `friend_add`） |
| 診断会の日程予約 | 予約管理（LIFF予約ページ ＋ Googleカレンダー空き連動） |
| 予約直後の3通（お礼→動画→当日までの過ごし方） | シナリオ `診断会_予約直後`（予約確定時に登録） |
| 前日19:00の3通（前振り→動画→宿題） | シナリオ `診断会_前日19時`（前日に登録、19:00に配信） |
| 当日2時間前のリマインド | シナリオ `診断会_当日2時間前`（2時間前に登録、即配信） |
| 〇〇さん／〇月〇日／担当者名の差し込み | `{{name}}` `{{metadata.diag_date}}` など友だちメタデータ |
| 1:1の返信・未返信の監視 | 管理画面のチャット／Conversation Inbox（Claude Code からも可） |

「予約 → 3つのシナリオ登録」の橋渡しだけは L Harness 本体に無いので、
`scripts/sync-bookings.mjs`（5分おきに動かす小さなスクリプト）が担当する。
理由と代替案の比較は [02-flow-design.md](02-flow-design.md)。

## 進め方（この順番で）

| # | やること | 資料 | 所要 |
|---|---|---|---|
| 1 | LINE Developers・Cloudflare を準備して `npx create-line-harness` でデプロイ | [01-setup.md](01-setup.md) §1〜§3 | 約1時間 |
| 2 | 管理画面で予約管理（メニュー・担当者・受付時間・Googleカレンダー）を設定 | [01-setup.md](01-setup.md) §4 | 30分 |
| 3 | 動画ファイルとサムネイルをアップロードしてURLを `config/assets.json` に書く | [01-setup.md](01-setup.md) §5 | 15分 |
| 4 | `pnpm apply` でタグ・シナリオ・予約メニューを作成 | [03-operations.md](03-operations.md) §1 | 5分 |
| 5 | テスト用LINEで予約→3セットが届くことを確認 | [03-operations.md](03-operations.md) §2 | 30分 |
| 6 | `sync-bookings.mjs` を5分おきの定期実行に載せる | [03-operations.md](03-operations.md) §3 | 15分 |
| 7 | Claude Code に MCP を接続して日常運用へ | [01-setup.md](01-setup.md) §6 | 10分 |

## ファイル一覧

| ファイル | 内容 |
|---|---|
| [`01-setup.md`](01-setup.md) | 環境構築の手順（LINE Developers / Cloudflare / Googleカレンダー / MCP） |
| [`02-flow-design.md`](02-flow-design.md) | 配信設計。どの機能に何を載せるか、タイムライン、制約と判断理由 |
| [`03-operations.md`](03-operations.md) | 運用手順。適用・テスト・文面変更・日程変更・監視・Claude Code での操作例 |
| [`04-lecture-funnel.md`](04-lecture-funnel.md) | **LINE2（リクさん・講義 → 個別相談会）の設計。** LINE1 からの誘導、動画ページ、アンケート、配信タイミング |
| [`lecture-page/`](lecture-page/) | LINE2 用の動画視聴ページ（動画＋申込ボタン）。Cloudflare Pages に置く |
| [`config/funnel.lecture.json`](config/funnel.lecture.json) / [`config/messages/lecture/`](config/messages/lecture/) | LINE2 の定義と配信文（【要差し替え】箇所あり） |
| [`config/funnel.json`](config/funnel.json) | LINE1（ゆうなりさん・診断会）のタグ・シナリオ・予約メニュー・担当者の定義 |
| [`config/messages/`](config/messages/) | 配信文の本体。`presales-education-video/` の文面を L Harness 変数に置き換えたもの |
| [`config/assets.example.json`](config/assets.example.json) | 動画URL・サムネイルURL・担当者ごとのZoom URL のひな形 |
| [`scripts/apply.mjs`](scripts/apply.mjs) | 定義を L Harness に反映（何度実行しても同じ結果になる） |
| [`scripts/sync-bookings.mjs`](scripts/sync-bookings.mjs) | 予約 → 承認 → 予約直後／前日／当日のシナリオ登録（定期実行） |
| [`scripts/test/`](scripts/test/) | モックAPIでスクリプトの判断ロジックを検証する `node --test` |
| [`.env.example`](.env.example) / [`.mcp.json.example`](.mcp.json.example) | 接続情報と Claude Code MCP 設定のひな形 |

## 2つの公式LINE

| | LINE1（理駆・既存） | LINE2（新規） |
|---|---|---|
| 役割 | 講義の案内だけ流し、LINE2 へ誘導 | 講義動画 → アンケート → 個別相談会 |
| 設定 | `config/funnel.line1.json`（LINE2 への誘導のみ） | `config/funnel.lecture.json` |
| 接続情報 | `.env.line1` | `.env.lecture` |
| コマンド | `pnpm apply:line1` / `pnpm routes:line1`（流入経路リンク） | `pnpm apply:lecture` / `pnpm sync:lecture` |

`config/funnel.json` と `.env` は、当初想定していた診断会ファネル（ゆうなりさん案件）の設定。今回の LINE1／LINE2 では使わない。

## 前提

- L Harness v0.24 系（2026年9月時点の `main`）。API の形はこのバージョンで確認済み
- Node.js 22 以上、pnpm 9 以上
- 費用：L Harness 本体は無料。Cloudflare 無料枠で動く。LINE公式アカウントのメッセージ通数課金は別

## 次のタスク

1. `01-setup.md` の §1 から順に進めて、管理画面にログインできるところまで行く
2. 動画2本（予約直後・前日）を書き出して R2 か Cloudflare Stream に置き、`config/assets.json` を作る
3. `pnpm apply` → テスト予約 → 3セット受信を確認する

- `worker-fork/` … L Harness 本体の固定メッセージ（予約受付・確定・標準リマインド）とカレンダーのタイトルを差し替えて配備する（GitHub Actions `deploy-worker.yml` を手動実行）。手順は `worker-fork/README.md`。
