# IG Harness セットアップ手順書（Roots 用）

IG Harness = Cloudflare Workers 上で動く OSS の Instagram DM 自動化ツール（コメント→DM 配布、フォローゲート、ステップ配信、Claude Code から MCP 経由で操作）。
ソフトウェア利用料 0 円、Cloudflare 無料枠で動く。Meta のアプリ審査は不要（自分のアカウントのみ運用する場合）。

> 参照元: 公式ガイド <https://harness-wiki.pages.dev/article/ig-harness-complete-setup-guide> は Claude の実行環境からはネットワーク制限でアクセスできなかったため、
> 同じ内容の元になっている公式リポジトリ内ドキュメント（`ig-harness/docs/QUICKSTART.md`, `ig-harness/docs/SETUP-GUIDE.md`, `ig-harness/README.md`）と
> 公式セットアップ CLI（`ig-harness/packages/create-ig-harness/src/`）のソースを読んで作成した。スクショ付きの画面遷移は公式ガイドを併用すること。

---

## 0. この場所にあるもの

| パス | 内容 |
|---|---|
| `../ig-harness/` | IG Harness 本体（git submodule、upstream `Shudesu/ig-harness-oss` の `b462851` / 2026-09-06 に固定） |
| `README.md` | この手順書 |
| `.env.example` | 集める値の一覧。`cp .env.example .env` して埋める |
| `deploy.sh` | **非対話デプロイ**。公式 CLI `npx create-ig-harness` と同じ手順を Cloudflare API トークンで実行 |
| `verify.sh` | デプロイ後の動作確認 + **アカウントレベル Webhook 購読**（忘れると Webhook が届かない最重要ステップ） |
| `mcp.json.example` | Claude Code 用 MCP 設定のひな形（`deploy.sh` が実物の `.mcp.json` を自動生成する） |

`.env` / `.deployed.env` / `.mcp.json` は秘密情報を含むので `.gitignore` 済み。

## 1. Claude 側で完了済みのこと

- [x] 公式リポジトリの取得と、セットアップ手順・CLI の全ステップの読解
- [x] IG Harness 本体を `ig-harness/` に submodule として固定（コミット `b462851`）
- [x] この環境（Node 22 / pnpm 10）で `pnpm install --frozen-lockfile` → 全パッケージビルド → Worker の型チェック → テスト 149 件 → 管理画面の静的ビルド、すべて成功を確認
- [x] `deploy.sh`（ブラウザログイン不要の非対話版）と `verify.sh` を作成
- [x] 公式 CLI が設定し忘れている `WORKER_URL` シークレットを `deploy.sh` では設定するようにした（ステップ配信・一斉配信のトラッキングリンク生成に必要）

**Claude ができなかったこと**: Cloudflare と Meta のアカウント操作（ブラウザでのログイン、アプリ作成、トークン発行）。これは下の「あなたがやること」。

## 2. あなたがやること

### Part A: アカウントと値の準備（約 15 分）

#### A-1. Cloudflare
1. アカウント作成 <https://dash.cloudflare.com/sign-up>（無料枠で OK。**メール認証まで完了させる**。未認証だと `code: 10034` で失敗）
2. ダッシュボード右サイドバーの **アカウント ID**（32 桁）→ `.env` の `CLOUDFLARE_ACCOUNT_ID`
3. API トークン作成 <https://dash.cloudflare.com/profile/api-tokens> → 「トークンを作成」→「カスタムトークン」
   - アカウント権限（編集）: **Workers スクリプト / Workers R2 ストレージ / D1 / Cloudflare Pages**
   - アカウント権限（読み取り）: **アカウント設定**
   - ユーザー権限（読み取り）: **ユーザー詳細 / メンバーシップ**
   - → `.env` の `CLOUDFLARE_API_TOKEN`
   - ※ 自分の Mac で公式 CLI を使う場合（ルート A）はトークン不要。ブラウザログインで代替できる

#### A-2. Instagram
- **プロアカウント**（ビジネス or クリエイター）になっていること。個人アカウントなら Instagram アプリ → 設定 → アカウントの種類とツール → プロアカウントに切り替え
- ManyChat 等の DM ツールを使ったことがあるなら、**先に完全に切断**しておく（後述「罠」参照）

#### A-3. Meta for Developers（アプリ作成 → トークン発行）
1. <https://developers.facebook.com> → マイアプリ → **アプリを作成**
2. ユースケース: **「Instagramでメッセージとコンテンツを管理」** を選ぶ（「その他」ではない）
3. アプリ名は任意（例: `roots-ig-harness`）、ビジネスは自分のもの → 作成。Instagram API ダッシュボードが開く
4. 左メニュー **アプリの設定 → ベーシック** で **Instagram アプリシークレット** を「表示」してコピー → `.env` の `IG_APP_SECRET`
5. Instagram API ダッシュボード **ステップ2「Instagram テスターの役割を割り当て」** → 自分の IG プロアカウントを追加
6. **スマホの Instagram アプリ** → 設定 → ウェブサイトのアクセス許可 → テスター招待 → **承認**
7. ダッシュボードに戻り **「トークンを生成」** → コピー → `.env` の `IG_ACCESS_TOKEN`
8. 同じ画面、テスターに追加したアカウントの横に出る **数字** → `.env` の `IG_USER_ID`
9. 同じ画面の **「Webhook サブスクリプション」トグルを ON**

### Part B: デプロイ（どちらか一方、約 5 分）

#### ルート A: 自分の Mac で公式 CLI を使う（ブラウザログイン方式・公式推奨）
```bash
npx create-ig-harness
```
Node.js 20 以上が必要。ブラウザで Cloudflare にログイン → A-3 で集めた値を聞かれるので入力（App ID は「アプリの設定 → ベーシック」の Instagram アプリ ID）→ 自動で D1 / R2 / Worker / 管理画面がデプロイされる。
最後に表示される **Callback URL / Verify Token / 各種 URL / API Key** をメモ。
→ Part C へ。ただし `verify.sh` を使うなら、CLI が表示した値で `.deployed.env` を手書きする必要があるので、**このリポジトリで完結させたいならルート B 推奨**。

#### ルート B: このリポジトリの `deploy.sh`（非対話・API トークン方式）
```bash
git submodule update --init            # ig-harness/ を取得（初回のみ）
cd ig-harness-setup
cp .env.example .env                   # A で集めた 5 つの値を埋める
./deploy.sh
```
途中で失敗しても再実行すれば続きから進む（作成済み資源は再利用）。
終了時に **Meta コンソールに貼る値**（Callback URL、Verify Token、プライバシーポリシー URL 等）が表示される。`.deployed.env` にも保存される。

> Claude に実行させたい場合: Claude Code のクラウド環境設定で `.env` と同じ名前の環境変数を登録し、
> 「`ig-harness-setup/deploy.sh` を `.env` なしで環境変数から実行して」と依頼すれば実行できる（スクリプトは `.env` の存在を前提にしているので、その際は `env > ig-harness-setup/.env` 相当の一時ファイルを Claude が作る）。
> チャットに秘密情報を直接貼らないこと。

### Part C: Meta コンソールで Webhook とアプリ公開（約 5 分）

`deploy.sh` の最後に出た値を使う。

1. **Webhook（ステップ3）**
   - コールバック URL: `https://<worker>/webhook`
   - トークンを認証: `IG_VERIFY_TOKEN`（`.deployed.env` の値）
   - 「認証して保存」→ 成功すれば Worker が正しく応答している
   - サブスクリプション登録: `messages`, `messaging_postbacks`, `comments`, `live_comments`, `mentions` をすべて
2. **アカウントレベル購読 + 動作確認（最重要）**
   ```bash
   cd ig-harness-setup && ./verify.sh
   ```
   Meta コンソールの設定だけでは Webhook は届かない。`verify.sh` が Graph API で `POST /{IG_USER_ID}/subscribed_apps` を実行し、`{"success":true}` を確認する
3. **アプリ公開に必要な設定（アプリの設定 → ベーシック）**
   - プライバシーポリシー URL: `https://<worker>/privacy-policy`
   - データ削除手順 URL: `https://<worker>/data-deletion`
   - 利用規約 URL: `https://<worker>/terms-of-service`
   - アプリアイコン: 1024×1024 PNG
   - カテゴリ: ビジネス
   - 「URL が無効」と言われたら Meta 側のキャッシュ。数分待つか、一度保存してやり直す
4. **公開**: 画面上部の「開発 → 公開（ライブ）」トグルを ON。「自分のビジネスのためにのみ構築する場合はアプリレビュー不要」
5. **ルーティング設定**（ManyChat 等を使ったことがある場合は必須）: Instagram API ダッシュボード → ルーティング設定 → 自分のアプリを **プライマリレシーバー** に

### Part D: 最終動作確認

1. 別の Instagram アカウントから自分のプロアカウントへ DM を送る
2. `./verify.sh` の「5/5 フォロワー」に送信者が出る → Webhook 経路完成
3. 管理画面 `https://ih-admin-xxxx.pages.dev` を開き、`API_KEY` でログイン（`.deployed.env` 参照）
4. 管理画面で **コメントルール** or **エンゲージメントゲート** を 1 つ作り、自分の投稿にテストコメントして DM が届くことを確認

## 3. Claude Code から操作する（MCP）

`deploy.sh` がリポジトリ直下に `.mcp.json` を生成する（ルート A の場合は CLI が「MCP 設定を追加しますか？」で同じものを作る）。
Claude Code をこのリポジトリで起動すると `ig-harness` MCP サーバーが読み込まれ、次のような指示が自然言語で通る。

- 「フォロワー数を教えて」
- 「投稿 X に『欲しい』とコメントした人に特典 URL を DM するゲートを作って」
- 「タグ『診断会予約』の人に明日 19 時に一斉配信を予約して」

配布物の文面は `../presales-education-video/` の LINE 配信文と同じトーン・NG ワード基準（`03-design-notes.md`）で作ると一貫する。

## 4. 罠と対処（公式 SETUP-GUIDE より）

| 症状 | 原因 | 対処 |
|---|---|---|
| Webhook が届かない | アカウントレベル購読の未登録 | `./verify.sh`（3/5 で `success:true` を確認） |
| Webhook が届かない | アプリが開発モードのまま | Part C-4 で公開 |
| Webhook が届かない | ステップ2 の「Webhook サブスクリプション」トグルが OFF | A-3-9 |
| `standby` イベントしか来ない | ManyChat 等が **プライマリレシーバー** | ManyChat の IG 連携を完全削除（ManyChat 設定 + Instagram アプリ「接続済みアプリ」+ Facebook「ビジネス統合」の 3 箇所）→ ルーティング設定で自アプリをプライマリに → `./verify.sh` で購読し直し |
| DM 送信で `2534014`（ユーザーが見つからない） | standby で受けた IGSID はスコープが違う | 上と同じ（プライマリレシーバー化） |
| DM 送信で `2534037`（スレッド所有者ではない） | ルーティング設定未完了 | Part C-5 |
| フォローされただけでは自動 DM が送れない | Instagram API の仕様（全リージョン共通）。相手が先に DM を送るまで 24 時間ウィンドウが開かない | **コメント → DM** をトリガーにする（IG Harness の主戦場） |
| コメント返信が「親コメント直下のスレッド」にならない | 本物のスレッド返信は Advanced Access（Meta 審査）が必要 | IG Harness はトップレベル＋@mention 方式で Standard Access のまま動く。仕様として受け入れる |
| `code: 10034` | Cloudflare のメール未認証 | 確認メールを開いて認証 |
| `too many databases` | D1 無料枠の上限 | 古い D1 を削除 or 有料プラン |
| トークン失効 | 60 日期限 | Worker の cron（5 分毎）が自動更新する。`GET /api/health` の残日数で監視。失効したら Meta で再発行 → `.env` 更新 → `deploy.sh` 再実行 |
| D1 無料枠の日次読み書き上限 | 上限到達でクエリがエラーになる（超過課金ではなく停止） | 運用が伸びたら Workers Paid（$5/月）へ |

## 5. アップデート（upstream の新バージョン追従）

```bash
cd ig-harness && git fetch && git checkout <new-tag-or-commit> && cd ..
git add ig-harness && git commit -m "ig-harness を vX.Y.Z に更新"
cd ig-harness-setup && ./deploy.sh      # マイグレーション適用 + Worker / 管理画面の再デプロイ
```

## 6. 参考リンク

- 公式スクショ付きガイド: <https://harness-wiki.pages.dev/article/ig-harness-complete-setup-guide>
- 公式動画: <https://youtu.be/xzEanXQtlO0>
- リポジトリ: <https://github.com/Shudesu/ig-harness-oss>
- 詳細ガイド（罠の全記録）: `../ig-harness/docs/SETUP-GUIDE.md`
- 最短手順: `../ig-harness/docs/QUICKSTART.md`
- API リファレンス: `../ig-harness/docs/API.md`
- MCP サーバー: <https://www.npmjs.com/package/@ig-harness/mcp-server>
