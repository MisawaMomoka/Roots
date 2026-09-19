# IG Harness セットアップ 進捗メモ（Roots）

秘密情報（トークン・App Secret・API Key）はここに書かない。IG_USER_ID・アプリ ID・URL は公開情報に近いので記録する。

## 環境
- Meta アプリ: **Retro Harness**（会社共通アカウント info@re-tro.net で管理。ログイン時の SMS 認証は 080-xxxx-4997 の持ち主に確認）
- Instagram アプリ名: Retro Harness-IG / Instagram アプリ ID: 1479867973365434
- サーバー（Cloudflare Worker）: `https://ig-harness.re-tro.workers.dev`（会社の Cloudflare アカウント "re-tro"。deploy.sh ではなく公式手順で作られたもの）
- 管理画面: Retro 本番には **無い**（田代さん確認 2026-09-19）。アカウント登録は API（`POST /api/accounts`、owner 権限が必要）で行う
- 認証キー: 田代さんが作業用の **スタッフキー** を発行して渡す（マスターの API Key は共有しない）。`POST /api/accounts` は owner ロール必須なので、スタッフキーのロールは owner にしてもらう
- 田代さん側の手順書: 会社側リポジトリ `ig-harness-oss/docs/multi-account-2026-09-17.md`（公開 upstream には無い）

## Phase A（自分の IG アカウント接続）
| 日付 | 作業 | 状態 |
|---|---|---|
| 2026-09-17 | Meta ステップ1: 必要なアクセス許可を追加 | 完了 |
| 2026-09-17 | Meta ステップ3: Webhook コールバック URL 登録 | 完了（以前から登録済み） |
| 2026-09-17 | アプリの役割 → Instagram テスターに `nami_beauty21` を追加、スマホで承認 | 完了 |
| 2026-09-17 | Meta ステップ2: アカウント追加 → `nami_beauty21`（IG_USER_ID `17841478731401423`） | 完了 |
| 2026-09-17 | トークン生成（本人が安全な場所に保管。チャット・リポジトリには貼らない） | 完了 |
| 2026-09-17 | Webhook サブスクリプション トグル ON | 完了 |
| | アプリの設定 → ベーシックに 3 つの URL・カテゴリ・アイコンを登録 | 未 |
| | `GET /api/accounts` で既存アカウントの有無を確認 → `POST /api/accounts` で nami_beauty21 を登録（追加方式。実行前に本人に確認） | 未（owner ロールのスタッフキー待ち） |
| | `verify.sh` 相当のアカウントレベル購読（POST /{IG_USER_ID}/subscribed_apps） | 未 |
| | Meta「公開」→ 公開する | 未 |
| | 別アカウントから DM を送って受信テスト | 未 |

## Phase B（インフルエンサー連携）
- 未着手。連携する IG アカウントのユーザー名を受け取ってから開始。
- 手順は Phase A と同じ（テスター追加 → 本人がスマホで承認 → 本人ログインでトークン生成 → 管理画面に登録）。
- IG Harness は複数アカウント対応。「追加」なら nami_beauty21 はそのまま動く。Claude Code（MCP）から操作できるのは最初のアカウントのみ。

## 制約メモ
- Claude のクラウド環境からは api.cloudflare.com / graph.instagram.com / *.workers.dev への通信が会社ポリシーで拒否される。コマンド実行が必要な工程は、環境のネットワーク設定（Custom で上記ドメインを許可）か、自分の Mac で行う。
- Meta の新 UI では「アプリモード」トグルは無く、左メニュー「公開」の「未公開/公開」ラベルで確認する。
- Webhook サブスクリプションのトグルは、トークン生成後でないと ON にできない。
- 「開発者の役割が不十分です」エラー = テスター登録前にアカウント追加を押した時に出る。先に「アプリの役割 → 役割 → Instagram テスター」に追加する。
