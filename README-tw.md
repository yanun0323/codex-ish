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

- Pi Coding Agent 0.87.1+（Remote 使用主機上的 Pi SDK）。
- Node.js 22.19+（使用內建的 `node:sqlite`）。Remote 目前支援 macOS 與 Linux。
- 若要使用搜尋、圖片生成與 Remote Control，需要 OpenAI Codex 登入（`/login` → OpenAI Codex）。DuckDuckGo 搜尋與狀態列不需要登入也能使用。

## 功能

### 網頁搜尋工具（`web_search`）

- **OpenAI Codex Responses 模型**：由目前對話的模型直接使用原生網頁搜尋。不再另發一個 GPT 請求，也不再受擴充套件的兩分鐘期限限制。搜尋沿用主對話的內容、訂閱登入、思考等級與快速模式；取消、用量、逾時和連線重試由 Pi 的 provider 處理。
- **其他所有 provider**：使用免費的 DuckDuckGo HTML 搜尋——不需要登入或 API key。最多回傳 10 筆標題、摘要與 URL（不會讀取網頁內容本身），期限為 30 秒，輸出上限為 24 KB。不會把對話歷史傳給 DuckDuckGo；選擇性的 `urls` 會轉成網域的 `site:` 篩選條件。不會自動重試。
- 只有啟用 `web_search` 時才提供搜尋。擴充套件不會切換模型，也不會在搜尋後端之間退回。使用其他 API 的 Codex 模型需改選 Codex Responses 模型。
- **目前 Pi 的限制**：原生搜尋事件與結構化引用標記不會保留為工具結果。我們會指示模型在答案中直接附上來源連結，但不保證引用一定正確顯示。目前沒有獨立的搜尋進度卡片或結構化來源清單。
- 更新後請執行 `/reload` 或重新啟動 Pi，載入新的搜尋方式。

### Codex 圖片生成（`codex_generate_image`、`codex_image_job`、`view_image`）

- 透過 Codex 訂閱登入生成或編輯圖片（不需要 API key），對應獨立的 Codex Images 用戶端（`gpt-image-2.5-flare`，需要精準編輯時可選 `gpt-image-2.5-sunburst`）。
- 每次以一個背景工作執行，存檔到 `.tmp/generated-images/`，完成後會在工作階段中回報結果。
- `codex_image_job` 可列出、查詢工作或停止等待；`/codex-images` 指令提供相同功能。
- `view_image` 用 Pi 內建的讀取器把本機圖片顯示給目前的模型，不消耗圖片生成額度。

### 狀態列 footer

自訂 footer，顯示模型、provider、Git 分支、remote control 狀態、context 用量、即時額度與回覆速度：

- **Codex**：5 小時與每週剩餘百分比，附重置倒數（`gpt-5.3-codex-spark` 有獨立額度）。
- **Antigravity（Google）**：依模型家族分組的額度。
- **DeepSeek API**：使用目前模型在 Pi 的憑證，顯示 USD 剩餘額度。只支援官方 `api.deepseek.com`；若沒有 USD 餘額，顯示 `n/a`，不會自行換算人民幣。
- **Claude Bridge（`pi-claude-bridge`）**：透過 bridge 已安裝的 Claude Agent SDK 與 Claude Code 登入，顯示 5 小時與每週剩餘百分比、重置倒數。背景輔助程序只查額度，不發送模型提示，也不掃描對話紀錄。SDK 的額度介面仍屬實驗功能；版本或登入方式不支援時顯示 `-`，必要時請更新 bridge 並執行 `/reload`。
- `/statusline` 會開啟十個獨立的欄位勾選項，預設皆開啟：`model-with-thinking`、`provider`、`git-branch`、`remote`、`context-used-percentage`、`quota-reset`、`context-used-tokens`、`context-window-tokens`、`output-speed`、`output-speed-avg5`。用 ↑/↓ 選取、`u` 將選取欄位往上移、`d` 往下移、Enter/空白鍵切換顯示、Esc 關閉。變更會立即儲存；儲存失敗會還原為最後成功儲存的設定。也可執行 `/statusline <field> on|off`，或用 `/statusline status` 依顯示順序查看設定。舊版依 provider 分別開關的設定不再生效。
- 順序另存於 `statusline.order`。隱藏欄位會保留位置；重複或未知的欄位名稱會忽略，遺漏或新增的欄位會補到最後。未設定順序或格式無效時，沿用上述預設順序。選單、`/statusline status` 與完整／精簡狀態列使用同一份順序。也可用 `/statusline move <field> up|down` 移動欄位，非互動模式也適用；`/statusline reset-order` 只恢復預設順序，不改顯示開關。排序不會重新查額度或清空速度紀錄；5 小時與每週額度仍一起移動。
- `git-branch` 只顯示目前的 Git 分支名稱（例如 `main`），預設緊接在 `provider` 後面，並有獨立的顯示開關。會沿用 Pi 的分支變更通知自動更新。Detached HEAD 顯示 `detached`；無法取得分支或目錄不在 Git 儲存庫內時，顯示 `—`。
- `output-speed`（`last 42.6 tok/s`）與 `output-speed-avg5`（`avg5 39.8 tok/s`）預設依序放在 `context-window-tokens` 後面，各有獨立的顯示開關。顯示的是**有效回覆速度**，不是伺服器內部的純生成速度，只在主對話的每次模型回覆完成後更新。`last` 以回報的輸出 token（包含思考，且只計算一次）除以從 Pi 的 `turn_start` 到對應 assistant `message_end` 的秒數。包含請求準備、初始等待與思考，不含後續 Pi 工具執行及閒置時間。思考摘要和片段到達時間不影響計時；沒有串流、只有一段、分批送達或未公開思考內容的回覆，都使用相同算法。`avg5` 是最近五次有效回覆的總輸出 token 除以總回覆時間，不是各次速度的算術平均；不足五次就使用已有的樣本。失敗、取消、缺少有效正數輸出 token，或耗時不是正數、不是有限值的回覆不納入：`last` 顯示 `—`，不沿用舊結果；`avg5` 保留有效紀錄，沒有紀錄時顯示 `—`。隱藏任一欄位都不會停止計算。樣本只保留在記憶體，切換模型、思考級別、對話分支、工作階段或重新載入時會清空。
- `quota-reset` 只顯示**目前 provider** 的餘額或剩餘額度與重置倒數，每 60 秒更新。關閉此欄位、切換模型或結束工作階段時，會取消查詢並關閉 Claude 輔助程序。其他勾選項只影響欄位顯示；隱藏 `remote` 不會停止 Remote Control。精簡顯示仍保留重置倒數；顏色會自動適應 truecolor 或 ANSI-256 終端機。

### ChatGPT Remote Control（`/remote`）

**實驗功能：**內建 Remote 主機，讓手機與 Mac 的 Codex 用戶端共用 Pi 對話。已用模擬用戶端與 Pi SDK 測試，也已驗證真正 macOS 桌面 App 的配對與連線。已驗證 iOS 配對與基本訊息傳送；App 完整操作及手機上的背景接手流程仍待驗證。尚不支援 `process/spawn`，部分桌面終端功能可能無法使用。

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` 會先詢問確認，再顯示 QR code 與手動配對碼。兩台裝置配對同一台主機、開啟同一個對話。仍需要 OpenAI 的轉接服務，以及 Pi 的 ChatGPT 訂閱登入。
- 每個對話只有一個 Pi 執行程序。Pi 視窗開著時由原本的 Pi 處理；關閉後，從 Codex 送出訊息會在背景接手同一份已儲存的 Pi 對話，保留歷史與分支內容。只看歷史不會呼叫模型。重新在 Pi 開啟時，只有背景工作閒置才會交回；若仍在執行，或 Pi 開啟期間紀錄有更新，請稍後重新開啟，避免用舊內容繼續寫入。中斷的工作不會自動重做。
- 更新後，請先關閉舊 Pi 視窗，或在所有舊視窗各執行一次 `/reload`。Pi 程序還活著時，單純斷線不會允許背景接手；沒有執行者紀錄的舊視窗也會暫時擋下接手。適用於已登記到 Remote、且有儲存檔案的對話，不包含已刪除或只存在記憶體的對話。Mac 與已啟用的 Remote 背景服務必須持續運作；可以關閉 Pi 視窗，但 `/remote stop`、睡眠或關機後就無法遠端使用。
- 提供家目錄瀏覽、建立資料夾與共用專案。只有本機 Pi 可以登記家目錄以外的專案。檔案瀏覽器會隱藏已知的憑證位置，但**這不是沙箱**：已配對的裝置能以主機使用者的權限操作 Pi 工具。請只配對信任的裝置。
- App 看到的 `~/.codex` 是虛擬目錄，上層就是 Pi 主機的家目錄，不會暴露真正的 Codex 憑證。圖片上傳使用 `~/.codex/attachments/<UUID>/...`，實際存放於私人 Remote 目錄的 `client-files/attachments/`。支援 PNG、JPEG、WebP、GIF，單張上限 8 MiB、總量 128 MiB，檔案與資料夾各最多 256 個。檔案寫入與刪除只限附件區，暫不支援其他檔案上傳。瀏覽也支援 `~`、`~/...` 與本機 file URL。
- 使用內建背景服務與需要驗證的私人 Unix socket，不再需要 `pi-codex-app-server` 或 `codex` 執行檔。Pi 工作階段開始時會啟動本機服務，除非設定 `PI_CODEX_APP_SERVER_AUTOSTART=0`；首次連接轉接服務需執行 `/remote start` 或 `/remote pair`。啟用後，主機重新啟動會自動連回。`/remote stop` 會停用並停止服務，但不會停止終端機中的 Pi 工作。
- 使用獨立的狀態目錄。若舊服務仍在執行，請先 `/remote stop`，再 `/remote pair`；不會搬移或刪除舊資料與配對。主機綁定原本的 ChatGPT 帳號。若要退回舊版，先停止新服務，再安裝先前版本；舊版資料仍保留。
- 只實作部分 Codex App Server 功能。Codex 桌面版自動帶入的專用設定（功能旗標、附加指令與個性）不會套用，並會顯示提示；Pi 保留本機設定。未知的設定覆寫、不支援的方法，以及沙箱或審核政策變更仍會明確回報錯誤。進行中的終端機工作不會移交給背景程序。終端機重新連線或切換分支後，請重新讀取對話；不要盲目重送執行狀態不明的工作。`/remote status` 會顯示最後一個不支援的 App 請求。
- 舊版別名：`/codex-server`。協定測試固定使用 Codex commit `444da310e108da16aaeb18fd790b0ac464f08aca`。

### 快速模式（`/fast`）

`/fast on|off|status` 可切換 Codex 模型的 `service_tier: "priority"`。設定會存到 `~/.pi/agent/codex-ish.json`。

### Skill 提及（`$skill-name`）

在編輯器輸入 `$` 即可自動補全已安裝的 skill。訊息中提及 `$some-skill` 時，會把該 skill 完整的 `SKILL.md` 注入 context，等於對單一則請求強制載入 skill。

### 側邊對話（`/btw` 或 `/side`）

開啟只保留在記憶體中的唯讀側邊對話，以主對話作為參考。只提供 Pi 內建的 `read`、`grep`、`find`、`ls` 工具；Side 會執行查詢，再把結果交回模型繼續回答。不提供 shell、修改檔案或擴充套件工具。每次提問最多進行 8 次模型請求與 24 次工具呼叫。需要 TUI 模式。Side 會以覆蓋整個視窗的方式開啟，捲動不會帶動主對話。PgUp/PgDn 可捲動；輸入框空白時也可用 ↑/↓。全螢幕模式另支援滑鼠滾輪與觸控板；一般模式請用鍵盤捲動。Esc 或 Ctrl+C 關閉並取消進行中的工作；切換分支或結束工作階段也會取消。

### 編輯器行為

- 從剪貼簿貼上圖片：會存到 `.tmp/images/` 並插入 markdown 連結。
- `Shift+Enter` / `Alt+Enter` 插入換行；`Super+Enter`（Cmd+Enter）送出。
- agent 執行中時，`Enter` / `Tab` 會把訊息排隊（queue），而不是插入干擾。
- Command+Enter 會直接插入目前執行（steer）。

## 設定

| 設定 | 位置 | 說明 |
|---|---|---|
| 快速模式 | `~/.pi/agent/codex-ish.json` | 由 `/fast` 寫入 |
| 狀態列欄位與順序 | `~/.pi/agent/codex-ish.json` 的 `statusline` | 由 `/statusline` 寫入；`statusline.order` 儲存順序，不影響 `/fast` |
| Remote 服務目錄 | `~/.pi/agent/codex-ish-remote/` | 可用 `PI_CODEX_ISH_REMOTE_HOME` 覆寫；請保持目錄私密 |
| Remote 自動啟動 | 環境變數 | `PI_CODEX_APP_SERVER_AUTOSTART=0` 停用 |
| Remote 本機連線 | Remote 目錄內的 `host.sock` | 私人 Unix socket；不再使用 `PI_CODEX_APP_SERVER_LISTEN` |
| Remote 主機名稱 | 環境變數 | `PI_CODEX_APP_SERVER_HOST_NAME` |
| 關閉 Remote control | 環境變數 | `PI_CODEX_REMOTE_CONTROL=0` |

## 相依套件

- `ws` — 內建 Remote 主機的 WebSocket 連線（npm）。
- `qrcode` — 配對用的終端機 QR code（npm）。

Pi 套件（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`）宣告為 peer dependencies，由 Pi 本身提供。

透過 Git 安裝時，`prepare` 會編譯 Remote 主機。使用原始碼開發時，請執行 `npm ci`、`npm run check` 與 `npm test`；`npm pack --dry-run` 可檢查是否包含 `dist/remote`。測試使用臨時目錄、假憑證與本機伺服器，不會配對真實裝置或呼叫付費模型。

## 注意事項

- 搜尋、圖片生成與 Remote Control 都是用你的訂閱登入呼叫 OpenAI 的 **ChatGPT backend API**——這些是官方 Codex 用戶端使用的同一組 endpoint，但並非公開文件的 API，未來可能變動。
- 圖片生成會消耗你的 Codex 用量額度。取消工作只是停止本機等待；請求仍可能在伺服器端完成並計入額度。失敗的工作不會自動重試。
- 搜尋回傳的網頁內容是不受信任的資料，不是指令。
- 背景圖片工作需要互動式（TUI）或 RPC 工作階段。側邊對話需要 TUI 模式。

## 授權

MIT。`tests/fixtures/codex/` 的上游協定測試資料保留原有的 Apache-2.0 授權與聲明。
