# pi-codex-ish

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

[Pi Coding Agent](https://github.com/earendil-works/pi) 的扩展插件，把 OpenAI Codex / ChatGPT 订阅体验带进 Pi：订阅制网页搜索、Codex 图片生成、显示用量的状态栏、ChatGPT Remote Control、skill 提及、侧边对话，以及 Codex 风格的编辑器行为。

## 安装

```bash
pi install git:github.com/yanun0323/codex-ish
```

安装后请重启 Pi。要求：

- Pi Coding Agent（插件会导入 Pi 自己的包，由 Pi 提供）。
- Node.js 22.5+（使用内置的 `node:sqlite`）。
- 搜索、图片生成和 Remote Control 需要 OpenAI Codex 登录（`/login` → OpenAI Codex）。DuckDuckGo 搜索与状态栏无需登录即可使用。

## 功能

### 网页搜索工具（`web_search`）

- **OpenAI Codex 模型**：使用 Codex 订阅的原生网页搜索。返回答案及引用的来源 URL，并跟随当前的思考等级（thinking level）。
- **其他所有模型**：回退到免费的 DuckDuckGo HTML 搜索——无需登录或 API key。最多返回 10 条标题、摘要和 URL（不会读取网页内容本身）。
- 不会发送对话历史。不会自动重试，也不会在两个后端之间互相回退。可选的 `urls` 会交给 Codex 查看，或作为 DuckDuckGo 的 `site:` 筛选条件。

### Codex 图片生成（`codex_generate_image`、`codex_image_job`、`view_image`）

- 通过 Codex 订阅登录生成或编辑图片（无需 API key），对应独立的 Codex Images 客户端（`gpt-image-2.5-flare`，需要精确编辑时可选 `gpt-image-2.5-sunburst`）。
- 每次以一个后台任务运行，保存到 `.tmp/generated-images/`，完成后会在会话中回报结果。
- `codex_image_job` 可列出、查询任务或停止等待；`/codex-images` 命令提供相同功能。
- `view_image` 使用 Pi 内置的读取器把本地图片展示给当前模型，不消耗图片生成额度。

### 状态栏 footer

自定义 footer，显示模型、provider、remote control 状态、context 用量和实时额度：

- **Codex**：5 小时与每周剩余百分比，附带重置倒计时（`gpt-5.3-codex-spark` 有独立额度）。
- **Antigravity（Google）**：按模型家族分组的额度。
- 每 60 秒刷新一次；颜色会自动适配 truecolor 或 ANSI-256 终端。

### ChatGPT Remote Control（`/remote`）

用 ChatGPT 手机 App 控制这台 Pi 主机：

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` 会显示可用 ChatGPT 扫描的二维码，并提供手动配对码。
- 运行本地 `pi-codex-app-server` 守护进程（会话开始时自动启动；设置 `PI_CODEX_APP_SERVER_AUTOSTART=0` 可禁用）。
- 旧版别名：`/codex-server`。

### 快速模式（`/fast`）

`/fast on|off|status` 可切换 Codex 模型的 `service_tier: "priority"`。设置保存在 `~/.pi/agent/codex-ish.json`。

### Skill 提及（`$skill-name`）

在编辑器中输入 `$` 即可自动补全已安装的 skill。消息中提及 `$some-skill` 时，会把该 skill 完整的 `SKILL.md` 注入 context，相当于对单次请求强制加载 skill。

### 侧边对话（`/btw` 或 `/side`）

打开一个临时的侧边对话，继承主对话作为只读参考。可以提问而不打断或延续主线程；侧边 agent 被指示不得修改任何内容。Ctrl+C 关闭，PgUp/PgDn 滚动。

### 编辑器行为

- 从剪贴板粘贴图片：会保存到 `.tmp/images/` 并插入 markdown 链接。
- `Shift+Enter` / `Alt+Enter` 插入换行；`Super+Enter`（Cmd+Enter）提交。
- agent 运行中时，`Enter` / `Tab` 会把消息排队，而不是插入引导。
- Command+Enter 会直接插入当前运行（steer）。

## 配置

| 配置 | 位置 | 说明 |
|---|---|---|
| 快速模式 | `~/.pi/agent/codex-ish.json` | 由 `/fast` 写入 |
| Remote 守护进程主目录 | `~/.pi/agent/codex-app-server/` | 可用 `PI_CODEX_APP_SERVER_HOME` 覆盖 |
| Remote 自动启动 | 环境变量 | `PI_CODEX_APP_SERVER_AUTOSTART=0` 禁用 |
| Remote 监听地址 | 环境变量 | `PI_CODEX_APP_SERVER_LISTEN`（默认 `ws://127.0.0.1:0`） |
| 关闭 Remote control | 环境变量 | `PI_CODEX_REMOTE_CONTROL=0` |

## 依赖

- `pi-codex-app-server` — Remote Control 守护进程（npm）。
- `qrcode` — 配对用的终端二维码（npm）。

Pi 包（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`）声明为 peer dependencies，由 Pi 本身提供。

## 注意事项

- 搜索、图片生成和 Remote Control 都是用你的订阅登录调用 OpenAI 的 **ChatGPT backend API**——这些是官方 Codex 客户端使用的同一组端点，但并非公开文档化的 API，未来可能变动。
- 图片生成会消耗你的 Codex 用量额度。取消任务只是停止本地等待；请求仍可能在服务端完成并计入额度。失败的任务不会自动重试。
- 搜索返回的网页内容是不可信的数据，不是指令。
- 后台图片任务与侧边对话浮层需要交互式（TUI）或 RPC 会话。

## 许可

MIT
