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
- 60 秒ごとに更新。色は truecolor または ANSI-256 ターミナルに自動対応します。

### ChatGPT Remote Control（`/remote`）

**実験的機能：**モバイルと Mac の Codex クライアントで Pi の会話を共有する内蔵 Remote ホストです。模擬クライアントと Pi SDK でテスト済みで、実際の macOS デスクトップアプリとのペアリングと接続も確認済みです。モバイルクライアントとアプリの一連の操作は未検証です。`process/spawn` は未対応のため、一部のデスクトップ端末機能は利用できない場合があります。

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` は確認後に QR コードと手動コードを表示します。両方の端末を同じホストにペアリングし、同じ会話を開きます。OpenAI の中継サービスと、Pi の ChatGPT サブスクリプションログインは引き続き必要です。
- 各会話を実行する Pi は 1 つだけです。両方に同じメッセージと更新を配信し、実行中の入力はフォローアップに入れます。ターミナルの会話は元の Pi が実行し、切断しても別の実行プロセスを作らず、保存済みの履歴は引き続き閲覧できます。送信を再開するには Pi でその会話を開き、`/remote start` を実行してください。リモートで作成した会話はバックグラウンドの Pi が実行します。
- ホームディレクトリの閲覧、フォルダー作成、共有プロジェクトに対応する API を提供します。ホーム外のプロジェクトを登録できるのはローカルの Pi だけです。ファイルブラウザーは既知の認証情報を非表示にしますが、**サンドボックスではありません**。ペアリングした端末はホストユーザーの権限で Pi のツールを使えます。信頼する端末のみペアリングしてください。
- 内蔵バックグラウンドサービスと認証付きの非公開 Unix socket を使い、`pi-codex-app-server` や `codex` 実行ファイルは不要です。Pi のセッション開始時にローカルサービスを起動します（`PI_CODEX_APP_SERVER_AUTOSTART=0` で無効化）。初回の中継接続は `/remote start` または `/remote pair` で有効化し、以後はホスト再起動時に再接続します。`/remote stop` はサービスを無効化して停止しますが、ターミナルの Pi は止めません。
- 状態は別のディレクトリに保存します。旧サービスが動いている場合は `/remote stop`、次に `/remote pair` を実行してください。旧データやペアリングは移行も削除もしません。ホストは元の ChatGPT アカウントに紐づきます。元に戻す場合は新サービスを停止して旧版を再インストールしてください。旧データは保持されます。
- Codex App Server API の一部のみ実装しています。Codex デスクトップが自動送信する専用設定（機能フラグ、追加指示、パーソナリティー）は適用せず、警告を表示します。Pi のローカル設定を維持し、不明な設定上書き、未対応のメソッド、サンドボックスや承認ポリシーの変更は引き続きエラーを返します。実行中のターミナル処理をバックグラウンドへ引き継ぐことはできません。再接続やブランチ変更後は会話を読み直し、結果が不明な処理を無条件に再送しないでください。最後の未対応リクエストは `/remote status` で確認できます。
- 旧名：`/codex-server`。プロトコルテストは Codex commit `444da310e108da16aaeb18fd790b0ac464f08aca` に固定しています。

### 高速モード（`/fast`）

`/fast on|off|status` で Codex モデルの `service_tier: "priority"` を切り替えます。設定は `~/.pi/agent/codex-ish.json` に保存されます。

### スキル言及（`$skill-name`）

エディタで `$` を入力するとインストール済みのスキルが自動補完されます。`$some-skill` に言及したメッセージでは、そのスキルの `SKILL.md` 全体がコンテキストに注入され、1 回のリクエストに対してスキルを強制読み込みできます。

### サイド会話（`/btw` または `/side`）

メインの会話を読み取り専用の参照として引き継ぐ、一時的なサイドチャットを開きます。メインのスレッドを中断せずに質問でき、サイドのエージェントは何かを変更しないよう指示されています。Ctrl+C で閉じ、PgUp/PgDn でスクロールします。

### エディタの操作

- クリップボードから画像を貼り付け：`.tmp/images/` に保存され、Markdown リンクとして挿入されます。
- `Shift+Enter` / `Alt+Enter` で改行、`Super+Enter`（Cmd+Enter）で送信。
- エージェント実行中は `Enter` / `Tab` で、割り込みではなくフォローアップメッセージをキューに入れられます。
- Command+Enter は現在のターンに割り込み（steer）ます。

## 設定

| 設定 | 場所 | 備考 |
|---|---|---|
| 高速モード | `~/.pi/agent/codex-ish.json` | `/fast` が書き込み |
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
- バックグラウンドの画像ジョブとサイド会話のオーバーレイには、対話型（TUI）または RPC セッションが必要です。

## ライセンス

MIT。`tests/fixtures/codex/` の上流プロトコルテストデータには、元の Apache-2.0 ライセンスと通知を保持しています。
