# worker-fork — L Harness 本体の固定メッセージを差し替えて配備する

L Harness 本体（Cloudflare Worker `roots-line`）は、予約の「受付しました」「確定しました」や標準リマインドの文言がプログラムに直書きで、管理画面では変えられない。
ここでは **配布済みバンドル（GitHub リリース）にパッチを当てて配備し直す** 仕組みを置く。ソースからのビルドはしない。

## 変えている箇所（`messages.json` で制御）

| 項目 | 設定 | 内容 |
|---|---|---|
| `requested` | 文言 or `""` | 申込直後の「予約リクエストを受け付けました」。`""` なら送らない |
| `approved` | 文言 or `""` | 承認時の「予約が確定しました」。`""` なら送らない |
| `builtinReminders` | `false` | 標準の 24 時間前／2 時間前リマインドを止める（こちらのシナリオで代替） |
| `calendarTitleFromNote` | `true` | 申込メモの 1 行目が `件名: …` ならカレンダーの予定タイトルにする（申込ページが `姓 名さん：流入元｜メニュー名` を書く） |

文言の差し込み：`{menu}` `{staff}` `{datetime}`。改行は `\n`。

## 配備のしかた

1. GitHub の Secrets に `CLOUDFLARE_API_TOKEN` を登録（https://dash.cloudflare.com/profile/api-tokens → テンプレート「Cloudflare Workers を編集する」→ アカウント Retro）。一度だけ。
2. `messages.json` を直して push したあと、Actions タブ → 「deploy line-harness worker (patched)」→ **Run workflow**（本番の Worker を置き換えるので、push だけでは配備しない）。
3. Actions が緑になれば反映済み。Worker の Secret（LINE のトークン等）は配備しても消えない。

## 仕組み

- `version.json` の `bundleUrl` から `bundle.tar.gz` を取得 → `patch.mjs` でアンカー文字列を完全一致で置換 → `wrangler.toml`（create-line-harness が生成したものと同じ）で `wrangler deploy`。
- アンカーが 1 箇所に一致しない場合は **失敗して止まる**（バージョンが変わって黙って壊れるのを防ぐ）。

## L Harness を新しいバージョンに上げたいとき

1. `version.json` の `version` / `bundleUrl` を新しいタグに変える。
2. 新しい `bundle.tar.gz` を手元に落として `node patch.mjs bundle/worker/index.js --check` が通るか確認。通らなければ `patch.mjs` のアンカーを新しいコードに合わせて直す。
3. push して配備。`create-line-harness update`（公式の更新コマンド）は改造版を検出して止まる（409）ので使わない。

## 元に戻したいとき

`messages.json` の `requested` / `approved` を元の文言にし、`builtinReminders: true`、`calendarTitleFromNote: false` にして push する（または `create-line-harness` で公式版を配備し直す）。
