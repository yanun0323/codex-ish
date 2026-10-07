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

- Pi Coding Agent 0.87.1+（Remote 使用主机上的 Pi SDK）。
- Node.js 22.19+（使用内置的 `node:sqlite`）。Remote 目前支持 macOS 和 Linux。
- 搜索、图片生成和 Remote Control 需要 OpenAI Codex 登录（`/login` → OpenAI Codex）。DuckDuckGo 搜索与状态栏无需登录即可使用。

## 功能

### 网页搜索工具（`web_search`）

- **OpenAI Codex Responses 模型**：由当前对话的模型直接使用原生网页搜索。不再另发一个 GPT 请求，也不再受扩展插件的两分钟期限限制。搜索沿用主对话的内容、订阅登录、思考等级和快速模式；取消、用量、超时及连接重试由 Pi 的 provider 处理。
- **其他所有 provider**：使用免费的 DuckDuckGo HTML 搜索——无需登录或 API key。最多返回 10 条标题、摘要和 URL（不会读取网页内容本身），超时为 30 秒，输出上限为 24 KB。不会把对话历史发给 DuckDuckGo；可选的 `urls` 会转换成域名的 `site:` 筛选条件。不会自动重试。
- 仅在启用 `web_search` 时提供搜索。扩展插件不会切换模型，也不会在搜索后端之间回退。使用其他 API 的 Codex 模型需要改选 Codex Responses 模型。
- **当前 Pi 的限制**：原生搜索事件和结构化引用标记不会保留为工具结果。我们会指示模型在答案中直接附上来源链接，但不保证引用一定正确显示。目前没有独立的搜索进度卡片或结构化来源列表。
- 更新后请执行 `/reload` 或重启 Pi，加载新的搜索方式。

### Codex 图片生成（`codex_generate_image`、`codex_image_job`、`view_image`）

- 通过 Codex 订阅登录生成或编辑图片（无需 API key），对应独立的 Codex Images 客户端（`gpt-image-2.5-flare`，需要精确编辑时可选 `gpt-image-2.5-sunburst`）。
- 每次以一个后台任务运行，保存到 `.tmp/generated-images/`，完成后会在会话中回报结果。
- `codex_image_job` 可列出、查询任务或停止等待；`/codex-images` 命令提供相同功能。
- `view_image` 使用 Pi 内置的读取器把本地图片展示给当前模型，不消耗图片生成额度。

### 状态栏 footer

自定义 footer，显示模型、provider、remote control 状态、context 用量和实时额度：

- **Codex**：5 小时与每周剩余百分比，附带重置倒计时（`gpt-5.3-codex-spark` 有独立额度）。
- **Antigravity（Google）**：按模型家族分组的额度。
- **DeepSeek API**：使用当前模型在 Pi 中的凭证，显示 USD 剩余额度。仅支持官方 `api.deepseek.com`；没有 USD 余额时显示 `n/a`，不会自行换算人民币。
- **Claude Bridge（`pi-claude-bridge`）**：通过 bridge 已安装的 Claude Agent SDK 与 Claude Code 登录，显示 5 小时和每周剩余百分比、重置倒计时。后台辅助进程仅查询额度，不发送模型提示，也不扫描对话记录。SDK 的额度接口仍属实验功能；版本或登录方式不支持时显示 `-`，必要时请更新 bridge 并执行 `/reload`。
- 仅显示、查询**当前使用的 provider**。四个来源默认均开启；通过 `/statusline` 菜单分别开关，或运行 `/statusline <codex|antigravity|deepseek|claude-bridge> on|off`；`/statusline status` 可查看已保存的选项。
- 开启时每 60 秒刷新；关闭显示、切换模型或结束会话时，会取消查询并关闭 Claude 辅助进程。精简显示仍保留重置倒计时；颜色会自动适配 truecolor 或 ANSI-256 终端。

### ChatGPT Remote Control（`/remote`）

**实验功能：**内置 Remote 主机，让手机和 Mac 的 Codex 客户端共享 Pi 对话。已用模拟客户端和 Pi SDK 测试，也已验证真实 macOS 桌面 App 的配对与连接。已验证 iOS 配对和基本消息发送；App 完整操作及手机上的后台接管流程仍待验证。暂不支持 `process/spawn`，部分桌面终端功能可能无法使用。

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` 会先请求确认，再显示二维码和手动配对码。两台设备配对同一主机并打开同一对话。仍需要 OpenAI 的中继服务，以及 Pi 的 ChatGPT 订阅登录。
- 每个对话只有一个 Pi 执行进程。Pi 窗口打开时由原来的 Pi 处理；关闭后，从 Codex 发送消息会在后台接管同一份已保存的 Pi 对话，保留历史和分支内容。只看历史不会调用模型。重新在 Pi 打开时，只有后台任务空闲才会交回；如果仍在运行，或 Pi 打开期间记录有更新，请稍后重新打开，避免用旧内容继续写入。中断的任务不会自动重做。
- 更新后，请先关闭旧 Pi 窗口，或在所有旧窗口各运行一次 `/reload`。Pi 进程仍在运行时，单纯断线不会允许后台接管；没有执行者记录的旧窗口也会暂时阻止接管。适用于已注册到 Remote 且有保存文件的对话，不包括已删除或仅存在内存中的对话。Mac 和已启用的 Remote 后台服务必须持续运行；可以关闭 Pi 窗口，但 `/remote stop`、睡眠或关机后无法远程使用。
- 提供主目录浏览、文件夹创建和共享项目。只有本地 Pi 可以注册主目录以外的项目。文件浏览器会隐藏已知的凭证位置，但**这不是沙箱**：已配对设备能以主机用户的权限使用 Pi 工具。请只配对可信设备。
- App 看到的 `~/.codex` 是虚拟目录，上一级就是 Pi 主机的主目录，不会暴露真实的 Codex 凭证。图片上传使用 `~/.codex/attachments/<UUID>/...`，实际保存在私有 Remote 目录的 `client-files/attachments/`。支持 PNG、JPEG、WebP、GIF，单张上限 8 MiB、总量 128 MiB，文件与文件夹各最多 256 个。文件写入和删除仅限附件区，暂不支持其他文件上传。浏览也支持 `~`、`~/...` 和本地 file URL。
- 使用内置后台服务和需要验证的私有 Unix socket，不再需要 `pi-codex-app-server` 或 `codex` 可执行文件。Pi 会话开始时启动本地服务，除非设置 `PI_CODEX_APP_SERVER_AUTOSTART=0`；首次连接中继服务需执行 `/remote start` 或 `/remote pair`。启用后，主机重启会自动重连。`/remote stop` 禁用并停止服务，但不会停止终端中的 Pi 工作。
- 使用独立的状态目录。若旧服务仍在运行，请先 `/remote stop`，再 `/remote pair`；不会迁移或删除旧数据与配对。主机绑定原来的 ChatGPT 账号。若要回退，先停止新服务，再安装先前版本；旧数据仍保留。
- 只实现部分 Codex App Server 功能。Codex 桌面版自动附带的专用配置（功能开关、附加指令与个性）不会生效，并会显示提示；Pi 保留本地配置。未知的配置覆盖、不支持的方法，以及沙箱或审批策略变更仍会明确报错。正在运行的终端工作不会转移给后台进程。终端重连或切换分支后，请重新读取对话；不要盲目重发执行状态不明的工作。`/remote status` 会显示最后一个不支持的 App 请求。
- 旧版别名：`/codex-server`。协议测试固定使用 Codex commit `444da310e108da16aaeb18fd790b0ac464f08aca`。

### 快速模式（`/fast`）

`/fast on|off|status` 可切换 Codex 模型的 `service_tier: "priority"`。设置保存在 `~/.pi/agent/codex-ish.json`。

### Skill 提及（`$skill-name`）

在编辑器中输入 `$` 即可自动补全已安装的 skill。消息中提及 `$some-skill` 时，会把该 skill 完整的 `SKILL.md` 注入 context，相当于对单次请求强制加载 skill。

### 侧边对话（`/btw` 或 `/side`）

打开仅保留在内存中的只读侧边对话，以主对话作为参考。只提供 Pi 内置的 `read`、`grep`、`find`、`ls` 工具；Side 会执行查询，再将结果交回模型继续回答。不提供 shell、修改文件或扩展插件工具。每次提问最多进行 8 次模型请求和 24 次工具调用。需要 TUI 模式。Side 会以覆盖整个窗口的方式打开，滚动不会带动主对话。PgUp/PgDn 可滚动；输入框为空时也可用 ↑/↓。全屏模式还支持鼠标滚轮与触控板；普通模式请用键盘滚动。Esc 或 Ctrl+C 关闭并取消正在进行的任务；切换分支或结束会话也会取消。

### 编辑器行为

- 从剪贴板粘贴图片：会保存到 `.tmp/images/` 并插入 markdown 链接。
- `Shift+Enter` / `Alt+Enter` 插入换行；`Super+Enter`（Cmd+Enter）提交。
- agent 运行中时，`Enter` / `Tab` 会把消息排队，而不是插入引导。
- Command+Enter 会直接插入当前运行（steer）。

## 配置

| 配置 | 位置 | 说明 |
|---|---|---|
| 快速模式 | `~/.pi/agent/codex-ish.json` | 由 `/fast` 写入 |
| 状态栏 provider 显示 | `~/.pi/agent/codex-ish.json` 中的 `statusline` | 由 `/statusline` 写入，不影响 `/fast` |
| Remote 服务目录 | `~/.pi/agent/codex-ish-remote/` | 可用 `PI_CODEX_ISH_REMOTE_HOME` 覆盖；请保持目录私密 |
| Remote 自动启动 | 环境变量 | `PI_CODEX_APP_SERVER_AUTOSTART=0` 禁用 |
| Remote 本地连接 | Remote 目录内的 `host.sock` | 私有 Unix socket；不再使用 `PI_CODEX_APP_SERVER_LISTEN` |
| Remote 主机名称 | 环境变量 | `PI_CODEX_APP_SERVER_HOST_NAME` |
| 关闭 Remote control | 环境变量 | `PI_CODEX_REMOTE_CONTROL=0` |

## 依赖

- `ws` — 内置 Remote 主机的 WebSocket 连接（npm）。
- `qrcode` — 配对用的终端二维码（npm）。

Pi 包（`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui`、`typebox`）声明为 peer dependencies，由 Pi 本身提供。

通过 Git 安装时，`prepare` 会编译 Remote 主机。使用源码开发时，请执行 `npm ci`、`npm run check` 和 `npm test`；`npm pack --dry-run` 可检查是否包含 `dist/remote`。测试使用临时目录、假凭证和本地服务器，不会配对真实设备或调用付费模型。

## 注意事项

- 搜索、图片生成和 Remote Control 都是用你的订阅登录调用 OpenAI 的 **ChatGPT backend API**——这些是官方 Codex 客户端使用的同一组端点，但并非公开文档化的 API，未来可能变动。
- 图片生成会消耗你的 Codex 用量额度。取消任务只是停止本地等待；请求仍可能在服务端完成并计入额度。失败的任务不会自动重试。
- 搜索返回的网页内容是不可信的数据，不是指令。
- 后台图片任务需要交互式（TUI）或 RPC 会话。侧边对话需要 TUI 模式。

## 许可

MIT。`tests/fixtures/codex/` 的上游协议测试数据保留原有的 Apache-2.0 许可和声明。
