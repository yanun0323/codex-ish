# pi-codex-ish

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

[Pi Coding Agent](https://github.com/earendil-works/pi) の拡張機能で、OpenAI Codex / ChatGPT サブスクライプの体験を Pi に持ち込みます。サブスクライプの Web 検索、Codex 画像生成、使用量を表示するステータスライン、ChatGPT Remote Control、スキル言及、サイド会話、Codex スタイルのエディタ操作を備えています。

## インストール

```bash
pi install git:github.com/yanun0323/codex-ish
```

インストール後は Pi を再起動してください。必要条件：

- Pi Coding Agent 0.87.1+（Remote はホストの Pi SDK を使用）。
- Node.js 22.19+（内蔵の `node:sqlite` を使用）。Remote は現在 macOS と Linux に対応しています。
- 検索・画像生成・Remote Control には OpenAI Codex のログイン（`/login` → OpenAI Codex）が必要です。DuckDuckGo 検索とステータスラインはログインなしでも動作します。

## 機能

### Web 検索ツール（`web_search`）

- **OpenAI Codex Responses モデル**：現在の会話のモデルがネイティブ Web 検索を直接使用します。別の GPT リクエストは送らず、拡張機能による 2 分の制限もありません。メインの会話内容、サブスクライプのログイン、thinking level、高速モードをそのまま使い、キャンセル・使用量・タイムアウト・通信の再試行は Pi のプロバイダーが管理します。
- **それ以外のすべてのプロバイダー**：無料の DuckDuckGo HTML 検索を使用します。ログインや API key は不要です。最大 10 件のタイトル・抜粋・URL を返し（ページ自体は読み込みません）、タイムアウトは 30 秒、出力上限は 24 KB です。会話履歴は DuckDuckGo に送信せず、任意の `urls` はホスト名の `site:` フィルターになります。自動再試行はしません。
- `web_search` が有効な場合のみ検索を提供します。拡張機能はモデルの切り替えや検索バックエンド間のフォールバックを行いません。別の API を使う Codex モデルでは、Codex Responses モデルへの切り替えが必要です。
- **現在の Pi の制限**：ネイティブ検索イベントや構造化された引用注釈はツール結果として保存されません。回答に出典への明示的なリンクを含めるようモデルに指示しますが、引用の表示を保証するものではありません。独立した検索進捗カードや構造化された出典一覧はありません。
- 更新後は `/reload` または Pi の再起動で新しい検索方式を読み込んでください。

### Codex 画像生成（`codex_generate_image`、`codex_image_job`、`view_image`）

- Codex サブスクライプのログイン経由で画像の生成・編集を行います（API key 不要）。独立した Codex Images クライアントと同等で、`gpt-image-2.5-flare` を既定とし、精密な編集には `gpt-image-2.5-sunburst` を選択できます。
- バックグラウンドジョブは同時に 1 件だけ実行され、`.tmp/generated-images/` に保存され、完了するとセッション内で結果を通知します。
- `codex_image_job` はジョブの一覧・確認・待機停止ができ、`/codex-images` コマンドでも同じ操作が可能です。
- `view_image` は Pi 内蔵のリーダーでローカル画像を現在のモデルに表示します。画像生成の使用量消費はありません。

### ステータスライン（フッター）

モデル、プロバイダー、リモート制御の状態、コンテキスト使用量、リアルタイムの quota を表示するカスタムフッターです。

- **Codex**：5 時間と週単位の残り率をリセットカウントダウン付きで表示（`gpt-5.3-codex-spark` は別の上限）。
- **Antigravity（Google）**：モデルファミリー別の quota グループ。
- **DeepSeek API**：選択中のモデルの Pi 認証情報で USD 残高を表示します。公式の `api.deepseek.com` のみ対応し、USD 残高がなければ `n/a` を表示します。人民元からの換算はしません。
- **Claude Bridge（`pi-claude-bridge`）**：bridge にインストールされた Claude Agent SDK と Claude Code のログインを使い、5 時間・週単位の残り率とリセットまでの時間を表示します。待機中の補助プロセスが使用量だけを読み取り、モデルへのプロンプト送信や会話履歴の走査は行いません。SDK の使用量 API は実験的機能のため、非対応のバージョンやログイン方式では `-` を表示します。必要に応じて bridge を更新し、`/reload` を実行してください。
- `/statusline` は 7 項目の独立したチェックボックスを開きます。初期状態はすべて有効です：`model-with-thinking`、`provider`、`remote`、`context-used-percentage`、`quota-reset`、`context-used-tokens`、`context-window-tokens`。↑/↓ で選択、Enter/Space で切り替え、Esc で閉じます。変更はその都度保存されます。`/statusline <field> on|off` でも切り替えられ、`/statusline status` で設定を確認できます。旧版のプロバイダー別スイッチは適用されません。
- `quota-reset` は**現在のプロバイダー**の残高、または残り率とリセットまでの時間だけを表示し、60 秒ごとに更新します。この項目を無効にしたとき、モデルの切り替え時、セッション終了時には問い合わせをキャンセルし、Claude の補助プロセスを終了します。他のチェックボックスは表示だけを切り替え、`remote` を非表示にしても Remote Control は停止しません。コンパクト表示でもリセットまでの時間を保持し、色は truecolor または ANSI-256 ターミナルに自動対応します。

### ChatGPT Remote Control（`/remote`）

**実験的機能：**モバイルと Mac の Codex クライアントで Pi の会話を共有する内蔵 Remote ホストです。模擬クライアントと Pi SDK でテスト済みで、実際の macOS デスクトップアプリとのペアリングと接続も確認済みです。iOS のペアリングと基本的なメッセージ送信は確認済みです。アプリ全体の操作と実機でのバックグラウンド引き継ぎは引き続き検証が必要です。`process/spawn` は未対応のため、一部のデスクトップ端末機能は利用できない場合があります。

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` は確認後に QR コードと手動コードを表示します。両方の端末を同じホストにペアリングし、同じ会話を開きます。OpenAI の中継サービスと、Pi の ChatGPT サブスクリプションログインは引き続き必要です。
- 各会話を実行する Pi は 1 つだけです。Pi ウィンドウが開いている間は元の Pi が処理し、閉じた後は Codex からの送信時に同じ保存済みセッションをバックグラウンドで再開します。履歴とブランチの内容を維持し、履歴を見るだけではモデルを呼び出しません。Pi で開き直す際は、バックグラウンドが待機中の場合のみ実行を返します。処理中、または Pi の起動中に記録が更新された場合は、後で開き直してください。古い内容での書き込みや、中断した処理の自動再実行は行いません。
- 更新後は古い Pi ウィンドウを閉じるか、すべてのウィンドウで一度 `/reload` を実行してください。Pi プロセスが生きている限り、通信の切断だけでは引き継ぎません。所有情報のない旧ウィンドウも安全のため移行を一時的に止めます。対象は Remote に登録済みで保存ファイルのある会話です。削除済みやメモリ内だけの会話は対象外です。Mac と有効な Remote サービスを動かし続けてください。Pi ウィンドウは閉じられますが、`/remote stop`、スリープ、シャットダウン後はリモート操作できません。
- ホームディレクトリの閲覧、フォルダー作成、共有プロジェクトに対応する API を提供します。ホーム外のプロジェクトを登録できるのはローカルの Pi だけです。ファイルブラウザーは既知の認証情報を非表示にしますが、**サンドボックスではありません**。ペアリングした端末はホストユーザーの権限で Pi のツールを使えます。信頼する端末のみペアリングしてください。
- App に見える `~/.codex` は仮想ディレクトリです。親は Pi ホストのホームで、実際の Codex 認証情報は公開しません。画像は `~/.codex/attachments/<UUID>/...` にアップロードし、実体は非公開 Remote ディレクトリの `client-files/attachments/` に保存します。PNG、JPEG、WebP、GIF に対応し、1 枚 8 MiB、合計 128 MiB、ファイルとフォルダーはそれぞれ最大 256 個です。ファイルの書き込みと削除は添付領域だけに限定し、その他のファイルのアップロードは未対応です。閲覧では `~`、`~/...`、ローカルの file URL も使えます。
- 内蔵バックグラウンドサービスと認証付きの非公開 Unix socket を使い、`pi-codex-app-server` や `codex` 実行ファイルは不要です。Pi のセッション開始時にローカルサービスを起動します（`PI_CODEX_APP_SERVER_AUTOSTART=0` で無効化）。初回の中継接続は `/remote start` または `/remote pair` で有効化し、以後はホスト再起動時に再接続します。`/remote stop` はサービスを無効化して停止しますが、ターミナルの Pi は止めません。
- 状態は別のディレクトリに保存します。旧サービスが動いている場合は `/remote stop`、次に `/remote pair` を実行してください。旧データやペアリングは移行も削除もしません。ホストは元の ChatGPT アカウントに紐づきます。元に戻す場合は新サービスを停止して旧版を再インストールしてください。旧データは保持されます。
- Codex App Server API の一部のみ実装しています。Codex デスクトップが自動送信する専用設定（機能フラグ、追加指示、パーソナリティー）は適用せず、警告を表示します。Pi のローカル設定を維持し、不明な設定上書き、未対応のメソッド、サンドボックスや承認ポリシーの変更は引き続きエラーを返します。実行中のターミナル処理をバックグラウンドへ引き継ぐことはできません。再接続やブランチ変更後は会話を読み直し、結果が不明な処理を無条件に再送しないでください。最後の未対応リクエストは `/remote status` で確認できます。
- 旧名：`/codex-server`。プロトコルテストは Codex commit `444da310e108da16aaeb18fd790b0ac464f08aca` に固定しています。

### 高速モード（`/fast`）

`/fast on|off|status` で Codex モデルの `service_tier: "priority"` を切り替えます。設定は `~/.pi/agent/codex-ish.json` に保存されます。

### スキル言及（`$skill-name`）

エディタで `$` を入力するとインストール済みのスキルが自動補完されます。`$some-skill` に言及したメッセージでは、そのスキルの `SKILL.md` 全体がコンテキストに注入され、1 回のリクエストに対してスキルを強制読み込みできます。

### サイド会話（`/btw` または `/side`）

メインの会話を参照する、メモリ内だけの読み取り専用サイドチャットを開きます。使えるツールは Pi 内蔵の `read`、`grep`、`find`、`ls` のみです。Side は調査を実行し、その結果をモデルに渡して回答を続けます。シェル、ファイルを変更するツール、拡張機能のツールは提供しません。質問ごとにモデルへのリクエストは最大 8 回、ツール呼び出しは最大 24 回です。TUI モードが必要です。Side はウィンドウ全体を覆うオーバーレイとして開き、スクロールしてもメインの会話は動きません。PgUp/PgDn、または入力欄が空のときの ↑/↓ でスクロールできます。フルスクリーンモードではマウスホイールとトラックパッドにも対応し、通常モードではキーボードを使います。Esc または Ctrl+C で閉じると実行中の処理をキャンセルします。ブランチ変更やセッション終了時もキャンセルします。

### エディタの操作

- クリップボードから画像を貼り付け：`.tmp/images/` に保存され、Markdown リンクとして挿入されます。
- `Shift+Enter` / `Alt+Enter` で改行、`Super+Enter`（Cmd+Enter）で送信。
- エージェント実行中は `Enter` / `Tab` で、割り込みではなくフォローアップメッセージをキューに入れられます。
- Command+Enter は現在のターンに割り込み（steer）ます。

## 設定

| 設定 | 場所 | 備考 |
|---|---|---|
| 高速モード | `~/.pi/agent/codex-ish.json` | `/fast` が書き込み |
| ステータスラインの表示項目 | `~/.pi/agent/codex-ish.json` の `statusline` | `/statusline` が保存。`/fast` とは独立 |
| Remote の状態ディレクトリ | `~/.pi/agent/codex-ish-remote/` | `PI_CODEX_ISH_REMOTE_HOME` で上書き。非公開に保ってください |
| リモートの自動起動 | 環境変数 | `PI_CODEX_APP_SERVER_AUTOSTART=0` で無効 |
| Remote のローカル接続 | Remote ディレクトリ内の `host.sock` | 非公開 Unix socket。`PI_CODEX_APP_SERVER_LISTEN` は使いません |
| Remote のホスト名 | 環境変数 | `PI_CODEX_APP_SERVER_HOST_NAME` |
| Remote Control の無効化 | 環境変数 | `PI_CODEX_REMOTE_CONTROL=0` |

## 依存パッケージ

- `ws` — 内蔵 Remote ホストの WebSocket 通信（npm）。
- `qrcode` — ペアリング用のターミナル QR コード（npm）。

Pi パッケージ（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`）は peer dependencies として宣言されており、Pi 自体が提供します。

Git からのインストールでは `prepare` が Remote ホストをコンパイルします。ソースから開発する場合は `npm ci`、`npm run check`、`npm test` を実行してください。`npm pack --dry-run` で `dist/remote` の同梱を確認できます。テストは一時ディレクトリ、模擬認証情報、ローカルサーバーを使い、実際の端末のペアリングや有料モデルの呼び出しは行いません。

## 注意事項

- 検索・画像生成・Remote Control は、サブスクライプのログインで OpenAI の **ChatGPT backend API** を呼び出します——公式 Codex クライアントと同じエンドポイントですが、公開されたドキュメントのない API であり、変更される可能性があります。
- 画像生成は Codex の使用量 quota を消費します。ジョブのキャンセルはローカルでの待機を停止するだけで、リクエストはサーバー側で完了し使用量にカウントされる可能性があります。失敗したジョブが自動リトライされることはありません。
- 検索が返す Web コンテンツは信頼できないデータであり、指示ではありません。
- バックグラウンドの画像ジョブには対話型（TUI）または RPC セッションが必要です。サイド会話には TUI モードが必要です。

## ライセンス

MIT。`tests/fixtures/codex/` の上流プロトコルテストデータには、元の Apache-2.0 ライセンスと通知を保持しています。
