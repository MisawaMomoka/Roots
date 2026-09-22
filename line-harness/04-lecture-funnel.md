# 04. LINE2（講義 → 個別相談会）の設計

LINE1（理駆・既存）は「講義の案内だけ」を流し、タップした人を LINE2 に誘導する。
LINE2 で講義動画を見せ、動画ページの下のアンケートから個別相談会に申し込んでもらう。

参考にした亀さんの配信は「毎日1〜2通の教育文 → 末尾に申込ボタン」の型。
違いは、亀さんが個別相談のリンクを直接貼るのに対し、リクさんは **動画視聴ページ → その下のアンケート** で申し込ませる点。

---

## 全体像

```
LINE1（理駆）
  │ 講義の案内文に {{auth_url:<LINE2のチャネルID>}}（タップで LINE2 に友だち追加・同一人物として紐づく）
  ▼
LINE2 友だち追加
  │
  ├─ [D0 即時]   あいさつ＋講義動画ページのリンク      ── シナリオ「講義_友だち追加直後（相対）」#1
  ├─ [D0 +1時間] 見どころ＋アンケート案内                              #2（講義ページを開いた人には送らない）
  ├─ [D0 +1時間] 特典エクササイズ動画2本                  ── シナリオ「講義_特典エクササイズ動画」
  ├─ [D1 08:00]  教育メッセージ（亀さんの朝配信の型）    ── シナリオ「講義_閲覧後未申込フォロー」#1（申込済みなら送らない）
  ├─ [D1 20:00]  受付は明日まで                                        #2（同上）
  └─ [D2 20:00]  本日締切                                              #3（同上）
        │
        ▼ 動画ページ（lecture-page/・LIFF）を開く → タグ「講義_視聴ページを開いた」
        ▼ 視聴期限カウントダウン／自動再生／一定時間視聴で、動画の下にフォームが出る（UTAGE 型）
        ▼ ページ内で送信 → タグ「講義_相談会申込」＋お礼1通（フォームの自動返信）
  ├─ [即時]      予約ページの案内                       ── シナリオ「講義_申込後フォロー」#1（tag_added）
  └─ [24時間後]  未予約なら念押し                                      #2（予約確定済みなら送らない）
        │
        ▼ 予約ページ（LIFF）で日時を選ぶ → 自動承認 → タグ「講義_相談会予約確定」
  ├─ 予約直後：お礼＋日程                              ── sync-bookings.mjs が登録
  ├─ 前日 19:00：宿題
  └─ 当日 2時間前：Zoom URL・担当者
```

---

## LINE1 側に置くもの（`config/funnel.line1.json`）

**LINE1 の Webhook は L Harness に向けない（OFF）。誘導カードは LINE 公式アカウントマネージャーの「あいさつメッセージ」で送る。**

| # | タイミング | 内容 |
|---|---|---|
| 1 | 友だち追加 直後 | あいさつ文（`messages/line1/invite-01.txt` の文面。`{Nickname}` が名前に置き換わる） |
| 2 | 同・直後（同じあいさつメッセージ内） | サムネイル画像のカード（カードタイプメッセージ または リッチメッセージ）。タップ先は `https://roots-line.re-tro.workers.dev/auth/line?account=2011652832` |

### なぜ LINE1 を L Harness で配信しないか（重要）

LINE1 と LINE2 は **同じプロバイダー**にあり、LINE ユーザー ID が同一。L Harness は LINE ユーザー ID ごとに友だちを **1 行**で管理し、その行の「所属アカウント」は **Webhook イベントを最後に受け取ったアカウント** に切り替わる（friends.line_account_id）。
LINE1 の Webhook を L Harness に向けていると、LINE2 の友だちになった後でも LINE1 で何かイベント（メッセージ、再追加など）が起きた瞬間に「LINE1 の友だち」に戻り、

- 申込ページの予約が `friend_not_found`（予約 API は LINE2 の友だちしか探さない）
- フォームのお礼が LINE1 から届く
- LINE2 のステップ配信が「対象アカウントの友だちでない」として一時停止

という不具合になる。LINE1 の Webhook を OFF にすれば L Harness に届くイベントは LINE2 だけになり、行は LINE2 に留まる。
インフルエンサー用リンク（`/auth/line?account=<LINE1>&ref=…`）は Webhook なしでも動く（OAuth 側で友だち行と `ref_code`・タグを作る）。その後 LINE2 を追加すると同じ行が LINE2 所属になり、`ref_code` は最初の経路のまま残る（`{{ref}}` で使える）。

`funnel.line1.json` の誘導シナリオは `"active": false` で停止した定義として残してある（`apply:line1` を実行すると停止状態に揃える）。

### LINE 公式アカウントマネージャーでの設定（LINE1）

1. 設定 → Messaging API →「Webhook の利用」を **オフ**（または LINE Developers → LINE1 の Messaging API チャネル → Webhook設定 → 「Webhookの利用」オフ）。
2. ホーム → あいさつメッセージ → オン。1 通目にテキスト（`invite-01.txt`）、2 通目に **カードタイプメッセージ**（イメージ：`lecture-page/thumb.jpg`、ボタン「講義を受け取る（無料）」→ 上の URL）または **リッチメッセージ**（画像全面タップ → 上の URL）。
3. 応答メッセージはオフのまま。

### 流入経路ごとの友だち追加リンク（ストーリー／リール）

インフルエンサーに渡すリンクを流入元ごとに分け、経路別の友だち追加数と割合を見る。L Harness の「流入経路（entry_routes）」機能を使う。
経路は `config/funnel.line1.json` の `entryRoutes`（今はストーリー用 `ig_story`、リール用 `ig_reel`）。追加したければ 1 行足して再実行する。

```powershell
node scripts/entry-routes.mjs --env=.env.line1 --config=config/funnel.line1.json          # 経路を作成し、配布用リンクを表示
node scripts/entry-routes.mjs --env=.env.line1 --config=config/funnel.line1.json --stats  # 経路別の クリック / 友だち追加 / 割合 / 申込
```

リンクの形は `https://roots-line.re-tro.workers.dev/auth/line?account=<LINE1 の Messaging チャネルID>&ref=ig_story`。
開くと LINE ログイン → LINE1 の友だち追加になり、その人に `流入_IGストーリー` などのタグが付く（管理画面の友だち一覧でも絞り込める）。
通常の友だち追加シナリオ（誘導カード）はそのまま動く。

前提：LINE1 のアカウント設定（管理画面 → LINEアカウント → 編集）に **LINE Login チャネル ID／シークレットと LIFF ID** が入っていること。未設定だとリンクが動かない（スクリプトが警告を出す）。

管理画面での確認：左メニュー「リファラルリンク」に経路が並び、各経路の数字も見られる。

## 判断：動画ページは自前の1枚ページ、申込は L Harness フォーム

| 候補 | 内容 | 採用 |
|---|---|---|
| **A. L Harness オートウェビナー** | 疑似ライブ配信ページ。開始時刻にCTAフォーム → その場で空き枠選択 → Google Meet 発行まで自動 | 見送り。決まった時刻にしか見られない／動画を HLS 変換して上げる必要がある／CTA後のフォロー文面が開発元用途（AI導入相談）で固定 |
| **B. 自前ページ＋L Harness フォーム** | Cloudflare Pages に置く1枚ページを LINE2 の LIFF アプリとして登録。動画の下にフォームをページ内表示し、L Harness のフォーム API に本人確認付きで送信。送信でタグ→シナリオ | **採用**。いつでも見られる、YouTube 限定公開でよい、文面はすべて自分で持てる |

B の「誰が開いたか」は、配信文のリンクを L Harness のトラッキングリンクにすることで取る（タップした人にタグが付く）。
「誰が申し込んだか」は LIFF のフォームが本人を特定する。

将来「毎晩20時に一斉に見せて締切をつくる」運用にしたくなったら A に移行できる（ページと配信文はそのまま流用）。

---

## LINE2 で作られるもの（`pnpm apply:lecture`）

| 種類 | 名前 | 役割 |
|---|---|---|
| タグ | `講義_視聴ページを開いた` | トラッキングリンクをタップした人 |
| タグ | `講義_相談会申込` | アンケートを送った人。申込後フォローのトリガー |
| タグ | `講義_相談会予約確定` | 予約が確定した人（`sync-bookings.mjs` が付ける） |
| フォーム | `個別相談会 申込アンケート` | 名前・悩み・聞きたいこと・都合のよい時間帯。送信で上のタグ＋お礼文 |
| トラッキングリンク | `講義動画ページ` | 飛び先は `.env.lecture` の `LECTURE_PAGE_URL`。タップで視聴タグ |
| シナリオ | `講義_閲覧後未申込フォロー`（旧名 `講義_友だち追加ステップ`） | friend_add / absolute_time。3通。全ステップ「申込済み（講義_相談会申込タグ）なら送らない」 |
| シナリオ | `講義_申込後フォロー` | tag_added（申込タグ）。予約案内＋24時間後の念押し |
| シナリオ | `相談会_予約直後` `相談会_日程変更` `相談会_前日19時` `相談会_当日2時間前` | 予約後。`sync-bookings.mjs` が登録 |
| 予約メニュー・担当者 | `個別相談会（オンライン・60分）`／`リク` | `--booking` 付きで作成 |

「申込済みならスキップ」はステップの条件 `tag_not_exists: 講義_相談会申込`（conditionType / conditionValue = タグ ID）で実現している（L Harness 標準機能）。判定は**配信の瞬間**に行われるので、D1 08:00 の前に申し込んだ人は D1 以降の 3 通を受け取らない。

- 設定ファイルでは各ステップの `skipIfTag: "applied"`。`apply:lecture` で反映される。
- 管理画面側だけ直したいとき（設定を触らずに条件だけ入れて検証する）: `npm run condition:lecture`（= `node scripts/scenario-condition.mjs --env=.env.lecture --scenario=講義_閲覧後未申込フォロー --tag=講義_相談会申込`）。指定したシナリオの全ステップに条件を入れ、他のシナリオには触らない。終わったら (1) 全ステップの条件、(2) タグあり／なしの人数、(3) タグ付きの友だちが全ステップで配信対象外になること、を API で検証して失敗なら非 0 で止まる。`--dry-run` で差分だけ確認できる。
- シナリオ名を変えたときは設定の `renamedFrom` に旧名を書く。`apply.mjs` が旧名のシナリオを見つけて名前だけ付け替える（作り直すと登録済みの人の進行が消えるため）。

---

## 配信タイミングの考え方（亀さんの型との対応）

| 亀さん | LINE2 | ねらい |
|---|---|---|
| 登録直後：講座の案内 | D0 即時：あいさつ＋動画リンク | 熱いうちに動画へ |
| 夕方：見どころ＋期限＋ボタン | D0 21:00：見どころ＋アンケート案内 | 見ていない人を動画へ、見た人を申込へ |
| 朝：長文の教育（失敗談→原因→希望） | D1 08:00：教育メッセージ | 「なぜ今までダメだったか」を言語化して相談の必要性をつくる |
| 期限前日・当日：締切 | D1 20:00／D2 20:00 | 締切で決断を促す。煽らず「考えますが一番もったいない」 |

時刻は `config/funnel.lecture.json` の `deliveryTime` で変えられる。

### 「開いていない人にだけ 1 時間後」の仕組み

- L Harness は 1 つのシナリオで「相対（○分後）」と「時刻指定」を混ぜられないので、シナリオを 2 つに分けている：`welcome`（相対：0 分・60 分）と `drip`（時刻指定：D1 08:00 以降）。どちらも友だち追加で始まる。
- 「開いた」の記録は、講義ページ（`lecture-page/index.html`）が LINE 内で開かれた瞬間に `POST /api/liff/link` へ本人の ID トークンと経路コード `lecture_opened` を送る方式。この経路（entry route）にタグ `講義_視聴ページを開いた` を紐づけてあるので、**メッセージを送らずに**タグだけ付く。60 分後のステップは `skipIfTag: watched` でこのタグがある人を飛ばす。
  - フォーム送信でタグを付ける方式は使わない：L Harness はフォーム送信のたびに必ず何か返信し、返信文が無いと「診断結果」というデモ用カードを自動で送ってしまう。
- 設定手順：`node scripts/entry-routes.mjs --env=.env.lecture --config=config/funnel.lecture.json` で経路を作る（`index.html` の `openedRef` は `lecture_opened` 固定なので貼り付け不要）。
- 注意：deliveryMode は作成後に変更できないため、既存の「講義_友だち追加ステップ」（現在の名前は「講義_閲覧後未申込フォロー」）は時刻指定のまま残し、先頭 2 通を外した。

---

## リクさんから受け取る必要があるもの（文面の【要差し替え】）

| 項目 | 使う場所 |
|---|---|
| 講座名、動画の長さ | `drip-00` `drip-01` `lecture-page` |
| 見どころ 3〜5個 | `drip-01` `lecture-page` の `points` |
| 教育メッセージの中身（失敗談・気づき・希望）8〜15段落 | `drip-02` |
| 締切前の背中押し 3〜5段落 | `drip-04` |
| アンケートの「悩み」選択肢 3〜4個 | `funnel.lecture.json` の `forms.apply.fields[1].options` |
| 動画の URL（YouTube 限定公開 ID か mp4 URL） | `lecture-page/index.html` の `video` |
| 相談会は Zoom か Google Meet か、担当者の固定 URL | `config/assets.json` の `staffMeetingUrls` |

文面は `config/messages/lecture/*.txt`。`{{name}}` `{{form_url:…}}` `__LECTURE_LINK__` `__BOOKING_URL__` はそのまま残す。

---

## 営業担当が複数いる場合

予約は「担当者ごとに受付時間と Google カレンダーを持つ」設計。お客さまは予約ページで **担当者を1人選んでから**日時を選ぶ（「おまかせ」で自動振り分けする機能は無い）。

| 設定 | 場所 |
|---|---|
| 担当者の一覧（名前・表示順） | `config/funnel.lecture.json` の `booking.staff`。1人1行 |
| 受付時間 | 共通なら `booking.availabilityRules`。人によって違うなら、その人の行に `availabilityRules` を書く |
| Zoom などの固定 URL | `config/assets.json` の `staffMeetingUrls`。キーは `staff[].name` と一致させる |
| Google カレンダー接続 | **本人に接続リンクを送る**（下記）。または管理画面 → 予約管理 → スタッフ → 各担当者 →「Googleアカウントで接続」を本人の Google アカウントで |

反映は `pnpm apply:lecture:booking`（担当者の追加・受付時間の更新は何度でも上書きできる）。

### 担当者本人にカレンダー接続をしてもらう（接続リンクの発行）

管理画面にログインさせずに済むよう、担当者ごとの「接続リンク」を発行して本人に送る。

```powershell
node scripts/google-link.mjs --env=.env.lecture                # 全員の接続状態を見る
node scripts/google-link.mjs --env=.env.lecture --staff=徳原   # 徳原さんのリンクを発行
node scripts/google-link.mjs --env=.env.lecture --all          # 未接続の全員分を発行
```

- 出てくるのは `https://roots-line.re-tro.workers.dev/t/XXXXXXX` の短い URL（L Harness のトラッキングリンクで Google の長い URL を包んでいる）。`--long` を付けると元の長い URL
- リンクは L Harness の仕様で **10分**で期限切れになる。送ってすぐ開いてもらう。切れたら同じコマンドで発行し直す（古い短縮リンクは自動で消える）
- **LINE のトーク内ではなく、Chrome や Safari で開いてもらう**（LINE 内ブラウザだと Google が拒否することがある）
- 本人は、そのリンクを開いて **自分の Google アカウント**を選び「許可」を押すだけ。その後、管理画面のログイン画面に飛ばされるが、接続はその時点で完了しているので閉じてよい
- 完了したかは、同じコマンドを打ち直して「接続済み」に変わっているかで確認する
Google 側の OAuth 同意画面が「テスト」状態のうちは、「対象 → テストユーザー」に**担当者3人全員のメールアドレス**を入れておく。

## セットアップ順（LINE2）

1. 公式LINE2・LINE Login チャネル2・LIFF2 を作り、管理画面「LINEアカウント」に追加する（チャットで案内済みの手順）
2. `.env.lecture.example` を `.env.lecture` にコピーし、LINE2 の `LINE_HARNESS_ACCOUNT_ID` と `BOOKING_URL` を書く
3. `lecture-page/README.md` に従って動画ページを Cloudflare Pages に置き、URL を `.env.lecture` の `LECTURE_PAGE_URL` に書く
4. `pnpm apply:lecture -- --dry-run` → `pnpm apply:lecture:booking`
5. 出力の `formIds.apply` を `lecture-page/index.html` の `formUrl` に入れて再デプロイ
6. 管理画面で担当者（リク）の Googleカレンダーを接続
7. テスト：LINE2 を友だち追加 → 動画ページ → アンケート → 予約 → `pnpm sync:lecture -- --verbose`
8. `sync-bookings.mjs` の定期実行に LINE2 用の行を足す（`03-operations.md` §3）

## Google カレンダーの予定（タイトルとメモ）

予約が「確定」になった瞬間に、L Harness が担当者の Google カレンダーへ予定を作る。書式は L Harness 側で固定されている。

| 部分 | 中身 | こちらで変えられるか |
|---|---|---|
| タイトル | `LINE の表示名｜メニュー名`（例 `momoka｜個別診断会`） | メニュー名だけ（`funnel.lecture.json` の `booking.menu.name`。管理画面のメニュー名も同じにする） |
| メモ | `L Harness予約（担当: …）` / `予約ID: …` / `メモ: <申込時の customer_note>` | `customer_note` は申込ページ（`lecture-page/booking.html`）が作る。**フォームの全回答＋流入元＋希望日時**を入れている |

タイトルを「姓 名さん｜メニュー名」にする改造は `worker-fork/`（配布済みバンドルへのパッチ）で対応済み。申込ページがメモの 1 行目に `件名: …` を書き、改造版 Worker がそれを予定タイトルにしてメモからは除く。

### L Harness 本体の固定メッセージ（受付・確定・標準リマインド）

「予約リクエストを受け付けました」「予約が確定しました」「明日のご予約のお知らせ」「あと 2 時間」は本体直書きで管理画面では変えられない。`worker-fork/messages.json` で文言変更・停止ができる（既定：受付・確定は送らない、標準リマインドは停止）。配備は GitHub Actions `deploy-worker.yml` を手動実行。詳細は `worker-fork/README.md`。

### 流入元（どのインフルエンサー／経路から来たか）を申込ページまで引き継ぐ仕組み

1. LINE1 の友だち追加リンク `…/auth/line?account=<LINE1>&ref=ig_story` で追加 → LINE1 の友だちに `ref_code = ig_story`
2. LINE1 の誘導カードのリンクは `{{auth_url:…}}` ではなく `…/auth/line?account=<LINE2>&uid={{uid}}&ref={{ref}}` を自前で組む（`{{auth_url}}` は ref が `cross-link` 固定で流入元が消えるため）→ LINE2 の友だちにも同じ `ref_code`（と `流入_IGストーリー` タグ）が付く
3. LINE2 の講義リンクは `https://liff.line.me/<講義LIFF>?src={{ref}}`（プレースホルダー `__LECTURE_LINK_SRC__`）。配信時に L Harness が `{{ref}}` を展開する
4. 講義ページ → 申込ページへ `?src=` を引き継ぎ、申込時の `customer_note` に `流入元：Instagram ストーリー（ig_story）` と書く。表示名は `booking.html` の `sourceLabels` で変更できる

`routes:line1:stats` の友だち追加数は LINE1 アカウント内だけを数える（ref が LINE2 にも付くため、全体で数えると二重になる）。

