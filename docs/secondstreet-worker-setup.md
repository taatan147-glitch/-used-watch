# セカスト取得経路の接続手順

## 確認できた結果

2026年11月28日14:14（日本時間）に開始されたGitHub Actionsの通知なしテストが成功した。

- 実行：[46111216075](https://github.com/taatan147-glitch/-used-watch/actions/runs/46111216075)、main `f8c5bf73f82559fcd21d3e45b57e781af3e56c52`、結論 `success`。
- RRLは商品60件、価格を取得できた商品60件。先頭2商品の49,390円・17,490円と公式の商品URLを確認。
- LAITINENとdonnie brascoは検索結果ページを受信して0件。0件の理由は在庫やルールの絞り込み条件も関係するため、この結果だけで在庫なしとは断定しない。
- 3件とも `workerColo: IAD`。これは受信拠点の表示で、配置後の処理拠点とは別に扱う。
- `notificationSent: false`。テストはDiscord送信やseen.json更新を行わない。

本番反映後の初回巡回も確認済み。11月28日14:40:22〜15:48:26（日本時間）の[実行46113157203](https://github.com/taatan147-glitch/-used-watch/actions/runs/46113157203)はsuccessで、全562ルールを処理し、全サイト合計270件を通知した。セカストは186ルール、新着123件・値下げ39件の計162件を通知し、取得・Discord送信エラーは0件。既読データのコミットもsuccess。利用者からも実際のDiscord通知を確認したと報告があった。

## 処理の分担

GitHub Actionsが既存の設定APIからルールを読み、セカストのキーワードだけを取得用Workerへ送る。取得用Workerは公式オンラインストアのHTMLを返し、GitHub内のブラウザで商品名・価格・URLを静的に読み取る。通知判定と既読キーの形式は既存のwatch.jsを使う。

取得用Workerでブラウザは起動しない。商品名・価格のDOM解析はGitHubに置き、WorkerのCPU負荷を抑える。

## 使用するファイル

| ファイル | 役割 |
| --- | --- |
| `tools/secondstreet-worker.mjs` | Cloudflareの取得用Workerに貼るコード |
| `.github/workflows/check-secondstreet-worker.yml` | 通知なしで3キーワードの取得と価格を確認 |
| `watch.js` | 本番接続版。確認が済んでから既存ファイルに反映 |
| `.github/workflows/watch.yml` | 本番の実行環境に追加Secretを渡す版 |

## 1. 取得用Workerを更新する

Cloudflareでテスト用の **chase-secondstreet-check** を開き、Edit codeでコード全体を `tools/secondstreet-worker.mjs` の内容に置き換えてDeployする。既存のブランド管理Workerのコードは、この作業の対象にしない。

取得用WorkerのSettings → Variables and Secretsで、次を追加する。

| Type | Variable name | Value |
| --- | --- | --- |
| Secret | `WATCH_TOKEN` | 新規に作った32文字以上のランダムな半角英数字 |

作った値は次のGitHub設定にも使う。値をチャットや公開リポジトリへ貼らない。

取得先を変更する設定はない。送信できるのは検索キーワードだけで、公式の検索URLと確認通信先に限定する。1キーワードにつき最大3リクエスト、25秒、各応答3MiBまで。

## 2. GitHubに同じ値を設定する

リポジトリのSettings → Secrets and variables → Actions → New repository secretで、次を追加する。

| Name | Secret |
| --- | --- |
| `SECONDSTREET_TOKEN` | Cloudflareの `WATCH_TOKEN` に入れたものと同じ値 |

既存の `WORKER_URL` と `DISCORD_WEBHOOK_URL` は引き続き使う。

## 3. 通知なしで接続を確認する

`.github/workflows/check-secondstreet-worker.yml` を追加し、Actionsの **セカスト本番接続確認（通知なし）** を手動実行する。

この時点では既存のwatch.jsとwatch.ymlをそのまま使える。確認用ワークフローはwatch.jsの自動起動部分を外した一時コピーから検索関数だけを使い、Discord送信とseen.jsonの更新を実行しない。

RRL（除外・上限価格なし）と、登録済みの別のセカストルールを最大2つ確認する。先頭のRRLで商品と価格が取れること、各商品のタイトル・価格・公式URLが自然であることを確認する。別ルールが0件の場合は、そのルールの除外条件や価格上限も確認する。

`workerColo` は `request.cf.colo` に基づく受信拠点の表示。配置設定を使う場合は実際の処理拠点と異なる可能性がある。手動診断の `placement` が `remote-NRT` 等なら、そちらも確認する。PCからの手動診断とGitHubからの要求で経路が変わる可能性があるため、GitHubからの接続を別途確認する。

### 2026年11月27日21:33の接続確認結果

ユーザーはCloudflareの `WATCH_TOKEN` とGitHubの `SECONDSTREET_TOKEN` の登録、取得用Workerの更新、確認用ワークフローの追加・実行を完了したと回答し、結果の画像を共有した。

- 実行：`45999616393`、ソース `19eeddf5a648c55402cc7272e824cb7a64b01ed9`。
- RRL、LAITINEN、もう1つの登録ルールで、いずれも `workerColo: DFW`。
- 3件とも `中継HTTP 502 / access_denied / 取得先HTTP 403`。
- 接続キーはWorkerに受け入れられている。502はWorkerが取得先の403を伝えているもので、キーの再登録を要求する根拠はない。
- `notificationSent: false`。本番の取得・通知の復旧は未確認。

同日21:42（日本時間）、こちらの環境から公開の固定RRL診断を1回実行し、DFW経由でHTTP 403・379バイトのAccess Deniedを再現した。PCからの先の成功とは時刻も経路も異なるため、所在地や出口IPだけを確定原因とは扱わない。

### 2026年11月28日13時台の同時間帯比較

診断表示の更新後、ユーザーのPCで13:26:23（日本時間）に固定RRL診断を実行した。

- `workerColo: NRT`、`placement: default`。
- HTTP 200の確認ページ2,350バイト、確認通信16バイト、再検索の商品HTML858,283バイト。
- 商品カード60件、商品リンク60件、`product_html_received`。

同日13:28:32にこちらの環境から同じ取得用Workerへ固定RRL診断を1回実行すると、`workerColo: DFW`、`placement: default`、初回検索HTTP 403・381バイト、`access_denied`だった。

約2分の間隔でNRTの成功とDFWの拒否が観測された。経路・出口IP等が影響する可能性が高いが、地域だけが唯一の原因と確定したものではない。商品価格の実取得、GitHubからの3キーワード確認、定期巡回とDiscord通知は引き続き未確認。

### 東京付近への配置を使った別Workerでの検証

既存の利用者のWorkerには変更を加えず、認証情報を分離した検証用の一時アカウントで、明示的な配置ヒント `placement.region: aws:ap-northeast-1` を指定して同じ取得コードを配置した。一時アカウントは検証専用であり、利用者の監視先に採用しない。

- 設定APIは `placement: { mode: targeted, region: aws:ap-northeast-1 }` の保存を確認できた。
- 13:35:06（日本時間）、受信拠点DFWからの固定RRL診断でHTTP 200・商品HTML858,282バイト・商品カードとリンク各60件を取得。
- 別の固定通信確認では受信拠点DFW、Cloudflareのtraceの応答拠点NRTだった。`cf-placement` ヘッダーは付かなかった。ヘッダー未付与や `request.cf.colo: DFW` だけで配置失敗と判定しない。
- 13:39:05、認証付き `/fetch` からもRRLの商品HTML858,282バイトを取得。
- 13:41:38、その実際のHTMLを準備したwatch.jsの関数・実ブラウザで静的に解析し、60件すべての商品名・価格・公式URLを取得した。先頭3価格は49,390円、17,490円、32,890円で、HTMLの表示価格と一致した。
- Discord送信・seen.json更新は行っていない。利用者のGitHubからの3キーワード確認と本番監視は、引き続き未確認。

実HTMLの価格は `<p class="itemCard_price">¥49,390</p>` にあり、旧セレクターだけでは60件とも0円になった。準備したwatch.jsに `.itemCard_price` のフォールバックを追加した。確認用ワークフローも一時コピーに同じ修正を加え、利用者の既存watch.jsを実行せずに確認する。従来のmeta価格・priceNum形式は残す。

配置設定は処理を東京付近のCloudflare拠点へ寄せるもので、AWSでサーバーを借りる設定ではない。単なる `mode: smart` は応答時間を最適化するため、東京での処理や取得成功を保証しない。利用者の有料プランへの切り替えや新規契約は行っていない。

公式CLI Wrangler 4.169.0の `init --from-dash chase-secondstreet-check` は既存コードと設定を `chase-secondstreet-check/wrangler.jsonc` 等へ取得する。現在のCLIはこの設定ファイルをJSONとして生成する。既存設定を取り込んでから `placement` を地域指定へ変更し、`keep_vars: true` でダッシュボード側の変数を維持してdeployする。認証は利用者のWindowsで `npx --yes wrangler@4.169.0 login` による公式OAuthを使う。利用者の認証情報をチャットへ貼らせない。

利用者は11月28日にWindowsで公式OAuthを完了し、`Successfully logged in.` と許可画面を共有した。スコープは `account:read user:read workers_scripts:write workers_routes:write zone:read`。ログインの再実行やAPIトークンの新規作成は不要。取得用Workerへの配置設定の保存はまだ未確認。

次にWindowsの同じコマンドプロンプトで実行する1行。取得に成功した場合だけ設定を変更し、変更に成功した場合だけdeployする。Worker名を検査し、元の設定ファイルを `.backup` へ保存する。

```cmd
npx --yes wrangler@4.169.0 init --from-dash chase-secondstreet-check && node -e "const f=require('fs'),p='chase-secondstreet-check/wrangler.jsonc',c=JSON.parse(f.readFileSync(p,'utf8'));if(c.name!=='chase-secondstreet-check')throw Error('Worker name mismatch');f.copyFileSync(p,p+'.backup');c.placement={region:'aws:ap-northeast-1'};c.keep_vars=true;f.writeFileSync(p,JSON.stringify(c,null,2));" && npx --yes wrangler@4.169.0 deploy --config chase-secondstreet-check/wrangler.jsonc
```

### 2026年11月28日14:09：恒久Workerで取得を確認

利用者の実行ではinitがcreate-cloudflare 2.75.2へ委譲され、既存Workerの取得は完了した。deployの自動認証は全権限を要求したため、確認中に認証待ちが時間切れとなった。取得済みのフォルダへ移動し、同じ5スコープを明示してloginした直後にdeployする形で成功した。再取得やキー再登録は不要だった。

- 恒久Worker：`https://chase-secondstreet-check.brand-searcher-lancher.workers.dev`。
- 利用者の成功表示：`Deployed chase-secondstreet-check triggers`。
- バージョン：`7908b3cf-15c4-407c-8f00-1ff90670b52e`。
- 14:09:25（日本時間）にこちらから固定RRL診断を1回呼び、受信拠点DFWでHTTP 200、商品HTML858,282バイト、商品カード・商品リンク各60件、`product_html_received`を確認した。先の同じDFW受信での403から取得成功へ変わった。
- `workerColo: DFW`、`placement: default`だったが、これらだけで実行拠点や配置成否を断定しない。
- この時点でも利用者のGitHubからの3キーワード・本番の定期監視とDiscord通知は未確認。

利用者はmainのwatch.jsに検証済みの価格フォールバック1行を先行反映し、その検索関数を利用する既存の確認用ワークフローを実行した。結果は冒頭のとおり成功。価格修正済みのmainは `f8c5bf73f82559fcd21d3e45b57e781af3e56c52`。監視本体のトリガーはscheduleと手動のみ。通知なしのcheckでは元のwatch.jsのmainを実行しない。

```js
const priceNumEl = card.querySelector("[class*=priceNum], [class*=price-num]") || card.querySelector(".itemCard_price");
```

この1行の反映により、すでに利用者が追加済みのcheck-secondstreet-worker.ymlをそのまま使えている。確認用ワークフローの差し替えは不要。本番反映では、取得経路をWorkerへつなぐwatch.jsとwatch.ymlの追加環境変数を変更する。この接続版は価格修正済みmainを基に準備し、メルカリ・トレファクの検索、除外・上限価格、新着・値下げ・既読更新、Discord送信関数が同じであることを確認した。

参考：[Cloudflare Workersの配置設定](https://developers.cloudflare.com/workers/configuration/placement/)

## 4. 本番に接続する

3の結果を確認してから、準備したwatch.jsとwatch.ymlを反映する。追加した取得用WorkerとSecretを使用する以外、監視ルールの管理先・通知先・既読データの形式は同じ。

セカストの検索が3回連続で失敗した場合は、その巡回の残りのセカストルールを停止し、件数をログに出す。次の巡回では改めて試す。メルカリとトレファクの検索は続ける。各失敗で90秒待つ処理は、この接続版では使用しない。

連続失敗による停止が発生した巡回は、既読保存まで完了したうえでジョブを失敗として終了する。本番ワークフローの `if: always()` による既読コミット処理は引き続き実行される。

## 無料枠の概算と限界

公式のWorkers Free枠は、1日100,000リクエスト、1要求あたりCPU時間10ms、外向きサブリクエスト50件。ネットワーク待機はCPU時間に含まれない。

現在の全562ルールをすべてセカストと仮定しても、3時間ごと・1日8巡回なら監視からWorkerへの要求は4,496件/日。取得先への通信は最大13,488件/日となる。実際にはメルカリ・トレファクも含むため、この概算は上限側の計算。他のWorkerの利用量もアカウントの枠に含まれる。

Browser Runの時間枠は使用しない。実行時間・CPU上限・失敗率は全巡回でも確認する。継続的に取得できることや将来のサイト変更への対応を、単発の成功だけで保証しない。GitHubのscheduleの遅延と、途中キャンセル時に未保存の既読情報が失われる既知の挙動は、この変更では解消していない。

参考：[Cloudflare Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)

## 開発時の確認

模擬の公式応答で確認ページの処理、Cookieの引き継ぎ、確認拒否時の停止、リクエスト数とサイズの上限を検証する。実ブラウザを使った静的HTMLの解析で、商品名・価格・URL・除外条件・価格上限・重複商品の除去を検証する。

これらの模擬データによる検証を、実際の商品価格やDiscord通知の復旧確認とは扱わない。

## ブランドの追加・編集

登録先は従来の[ブランド管理画面](https://white-disk-c888.brand-searcher-lancher.workers.dev/)を使う。

1. ブランド追加・編集で「このブランドを監視対象にする」と「セカスト」をチェックする。他のサイトも必要なら選ぶ。
2. 「保存」を押す。
3. PCでは「監視通知」欄の「監視ブランドをWorkerへ同期」を押す。スマホでは「監視設定」の「Workerへ同期」を押す。
4. 同期完了を確認すると、次に開始する巡回から反映される。実行中の巡回は開始時に取得したルールで続く。

保存はブラウザ内のブランドデータを更新する操作。サーバーの監視ルールへの反映には、同期ボタンの操作が必要。管理画面のWorker URLは従来の設定APIのものを使う。取得用Workerへの置き換えや、ブランド追加ごとのGitHub編集は不要。

新規ブランドの初期値は監視OFF・セカストOFFなので、ブランド名の保存だけでセカストも自動的に監視対象になるとは案内しない。
