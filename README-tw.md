# pi-codex-ish

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

[Pi Coding Agent](https://github.com/earendil-works/pi) 的擴充套件，把 OpenAI Codex / ChatGPT 訂閱體驗帶進 Pi：訂閱制網頁搜尋、Codex 圖片生成、顯示用量的狀態列、ChatGPT Remote Control、skill 提及、側邊對話，以及 Codex 風格的編輯器行為。

## 安裝

```bash
pi install git:github.com/yanun0323/codex-ish
```

安裝後請重新啟動 Pi。需求：

- Pi Coding Agent（擴充套件會匯入 Pi 自己的套件，由 Pi 提供）。
- Node.js 22.5+（使用內建的 `node:sqlite`）。
- 若要使用搜尋、圖片生成與 Remote Control，需要 OpenAI Codex 登入（`/login` → OpenAI Codex）。DuckDuckGo 搜尋與狀態列不需要登入也能使用。

## 功能

### 網頁搜尋工具（`web_search`）

- **OpenAI Codex 模型**：使用 Codex 訂閱的原生網頁搜尋。回傳答案與引用的來源 URL，並跟隨目前的思考等級（thinking level）。
- **其他所有模型**：退回免費的 DuckDuckGo HTML 搜尋——不需要登入或 API key。最多回傳 10 筆標題、摘要與 URL（不會讀取網頁內容本身）。
- 不會送出對話歷史。不會自動重試，也不會在兩個後端之間退回。選擇性的 `urls` 會交給 Codex 檢視，或作為 DuckDuckGo 的 `site:` 篩選條件。

### Codex 圖片生成（`codex_generate_image`、`codex_image_job`、`view_image`）

- 透過 Codex 訂閱登入生成或編輯圖片（不需要 API key），對應獨立的 Codex Images 用戶端（`gpt-image-2.5-flare`，需要精準編輯時可選 `gpt-image-2.5-sunburst`）。
- 每次以一個背景工作執行，存檔到 `.tmp/generated-images/`，完成後會在工作階段中回報結果。
- `codex_image_job` 可列出、查詢工作或停止等待；`/codex-images` 指令提供相同功能。
- `view_image` 用 Pi 內建的讀取器把本機圖片顯示給目前的模型，不消耗圖片生成額度。

### 狀態列 footer

自訂 footer，顯示模型、provider、remote control 狀態、context 用量與即時額度：

- **Codex**：5 小時與每週剩餘百分比，附重置倒數（`gpt-5.3-codex-spark` 有獨立額度）。
- **Antigravity（Google）**：依模型家族分組的額度。
- 每 60 秒更新一次；顏色會自動適應 truecolor 或 ANSI-256 終端機。

### ChatGPT Remote Control（`/remote`）

用 ChatGPT 手機 App 控制這台 Pi 主機：

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` 會顯示可用 ChatGPT 掃描的 QR code，並提供手動配對碼。
- 執行本機 `pi-codex-app-server` daemon（工作階段開始時自動啟動；設定 `PI_CODEX_APP_SERVER_AUTOSTART=0` 可停用）。
- 別名（舊版）：`/codex-server`。

### 快速模式（`/fast`）

`/fast on|off|status` 可切換 Codex 模型的 `service_tier: "priority"`。設定會存到 `~/.pi/agent/codex-ish.json`。

### Skill 提及（`$skill-name`）

在編輯器輸入 `$` 即可自動補全已安裝的 skill。訊息中提及 `$some-skill` 時，會把該 skill 完整的 `SKILL.md` 注入 context，等於對單一則請求強制載入 skill。

### 側邊對話（`/btw` 或 `/side`）

開啟一個臨時的側邊對話，繼承主對話作為唯讀參考。可以提問而不打斷或延續主執行緒；側邊 agent 被指示不得修改任何內容。Ctrl+C 關閉，PgUp/PgDn 捲動。

### 編輯器行為

- 從剪貼簿貼上圖片：會存到 `.tmp/images/` 並插入 markdown 連結。
- `Shift+Enter` / `Alt+Enter` 插入換行；`Super+Enter`（Cmd+Enter）送出。
- agent 執行中時，`Enter` / `Tab` 會把訊息排隊（queue），而不是插入干擾。
- Command+Enter 會直接插入目前執行（steer）。

## 設定

| 設定 | 位置 | 說明 |
|---|---|---|
| 快速模式 | `~/.pi/agent/codex-ish.json` | 由 `/fast` 寫入 |
| Remote daemon 主目錄 | `~/.pi/agent/codex-app-server/` | 可用 `PI_CODEX_APP_SERVER_HOME` 覆寫 |
| Remote 自動啟動 | 環境變數 | `PI_CODEX_APP_SERVER_AUTOSTART=0` 停用 |
| Remote 監聽位址 | 環境變數 | `PI_CODEX_APP_SERVER_LISTEN`（預設 `ws://127.0.0.1:0`） |
| 關閉 Remote control | 環境變數 | `PI_CODEX_REMOTE_CONTROL=0` |

## 相依套件

- `pi-codex-app-server` — Remote Control daemon（npm）。
- `qrcode` — 配對用的終端機 QR code（npm）。

Pi 套件（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`）宣告為 peer dependencies，由 Pi 本身提供。

## 注意事項

- 搜尋、圖片生成與 Remote Control 都是用你的訂閱登入呼叫 OpenAI 的 **ChatGPT backend API**——這些是官方 Codex 用戶端使用的同一組 endpoint，但並非公開文件的 API，未來可能變動。
- 圖片生成會消耗你的 Codex 用量額度。取消工作只是停止本機等待；請求仍可能在伺服器端完成並計入額度。失敗的工作不會自動重試。
- 搜尋回傳的網頁內容是不受信任的資料，不是指令。
- 背景圖片工作與側邊對話 overlay 需要互動式（TUI）或 RPC 工作階段。

## 授權

MIT
