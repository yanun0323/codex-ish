# pi-codex-ish

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-Click-yellow" alt="English"></a>
  <a href="README-tw.md"><img src="https://img.shields.io/badge/繁體中文-點擊查看-orange" alt="繁體中文"></a>
  <a href="README-cn.md"><img src="https://img.shields.io/badge/简体中文-点击查看-orange" alt="简体中文"></a>
  <a href="README-ja.md"><img src="https://img.shields.io/badge/日本語-クリック-blue" alt="日本語"></a>
  <a href="README-ko.md"><img src="https://img.shields.io/badge/한국어-클릭-yellow" alt="한국어"></a>
</p>

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension that brings the OpenAI Codex / ChatGPT subscription experience into Pi: subscription web search, Codex image generation, a usage-aware statusline, ChatGPT Remote Control, skill mentions, side conversations, and Codex-style editor behavior.

## Install

```bash
pi install git:github.com/yanun0323/codex-ish
```

Restart Pi after installing. Requirements:

- Pi Coding Agent 0.87.1+ (Remote uses the host's Pi SDK).
- Node.js 22.19+ (uses the built-in `node:sqlite`). Remote currently supports macOS and Linux.
- An OpenAI Codex login (`/login` → OpenAI Codex) for search, image generation, and Remote Control. DuckDuckGo search and the statusline work without it.

## Features

### Web search tool (`web_search`)

- **OpenAI Codex Responses models**: the current conversation model uses native web search directly. No second GPT request and no extension-imposed two-minute deadline. Search uses the main conversation context, subscription login, thinking level, and fast-mode setting; cancellation, usage, timeouts, and transport retries are managed by Pi's provider.
- **Every other provider**: uses free DuckDuckGo HTML search — no login or API key. Returns up to 10 titles, snippets, and URLs (pages themselves are not read), with a 30-second timeout and 24 KB output limit. Conversation history is not sent to DuckDuckGo; optional `urls` become hostname `site:` filters. No automatic retries.
- Search is enabled only when `web_search` is active. The extension does not switch models or fall back between search backends. Codex models using a different API must switch to a Codex Responses model.
- **Current Pi limitation**: native search events and structured citation annotations are not retained as tool results. The model is instructed to include explicit source links in its answer, but this is not a citation-rendering guarantee. There is no separate search-progress card or structured source list.
- After updating, use `/reload` or restart Pi to load the new search behavior.

### Codex image generation (`codex_generate_image`, `codex_image_job`, `view_image`)

- Generates or edits images through the Codex subscription login (no API key), matching the standalone Codex Images client (`gpt-image-2.5-flare`, optionally `gpt-image-2.5-sunburst` for precise edits).
- Runs as one background job at a time, saves to `.tmp/generated-images/`, and announces the result back into the session when it finishes.
- `codex_image_job` lists, checks, or stops waiting on jobs; `/codex-images` does the same from the command line.
- `view_image` shows a local image to the current model via Pi's built-in reader without consuming image-generation usage.

### Statusline footer

Custom footer with model, provider, Git branch, remote-control state, context usage, live quota, and response speeds:

- **Codex**: 5-hour and weekly remaining percentage with reset countdown (including a separate limit for `gpt-5.3-codex-spark`).
- **Antigravity (Google)**: per-model-family quota groups.
- **DeepSeek API**: remaining USD balance using the selected model's Pi credentials. Only the official `api.deepseek.com` endpoint is supported; missing USD balances show `n/a`, not a converted CNY amount.
- **Claude Bridge (`pi-claude-bridge`)**: 5-hour and weekly remaining percentage with reset countdown, using the bridge's installed Claude Agent SDK and Claude Code login. An idle helper process reads usage without sending model prompts or scanning transcripts. The SDK usage API is experimental; unsupported versions/logins show `-`. Update the bridge and `/reload` if needed.
- `/statusline` opens ten independent field checkboxes, all on by default: `model-with-thinking`, `provider`, `git-branch`, `remote`, `context-used-percentage`, `quota-reset`, `context-used-tokens`, `context-window-tokens`, `output-speed`, and `output-speed-avg5`. Use ↑/↓ to select, `u` to move the selected field up, `d` to move it down, Enter/Space to toggle, and Esc to close. Changes save immediately; failed saves restore the last saved choices. `/statusline <field> on|off` also works; `/statusline status` lists the saved choices in display order. The old per-provider switches no longer apply.
- Order is stored separately in `statusline.order`. Hidden fields keep their positions; duplicate/unknown IDs are ignored and missing/new fields are appended. An absent or invalid order uses the defaults above. The menu, `/statusline status`, and full/compact footers share the same order. `/statusline move <field> up|down` also works outside interactive mode; `/statusline reset-order` resets only the order, not the display switches. Reordering does not restart quota queries or reset speed history; 5-hour and weekly quotas move together.
- `git-branch` displays only the current Git branch name (for example, `main`) immediately after `provider` by default, with its own display switch. It uses Pi's branch-change notifications to update automatically. Detached HEAD shows `detached`; an unavailable branch or a directory outside a Git repository shows `—`.
- `output-speed` (`last 42.6 tok/s`) and `output-speed-avg5` (`avg5 39.8 tok/s`) appear after `context-window-tokens` by default, in that order, with separate display switches. They show **effective response speed**, not pure server-side generation speed, and update only when a main-thread model response finishes. `last` is the reported output tokens (including thinking, counted once) divided by seconds from Pi's `turn_start` to the matching assistant `message_end`. This includes request preparation, initial waiting, and thinking, but excludes subsequent Pi tool execution and idle time. Thinking summaries and chunk arrival times do not control the clock; non-streamed, single-chunk, buffered, and hidden-thinking replies use the same calculation. `avg5` is the total output tokens of the last five valid responses divided by their total response time, not the arithmetic mean of their rates; fewer than five responses use all available samples. Failed/cancelled responses, missing or invalid positive output-token counts, and nonpositive or nonfinite durations are excluded: `last` shows `—` instead of an older result, while `avg5` keeps its valid history or shows `—` if none exists. Hiding either field does not stop measurement. Samples stay in memory and reset on model, thinking-level, conversation-branch, or session changes and reloads.
- `quota-reset` shows only the **current provider's** balance or remaining quota and reset countdown, refreshed every 60 seconds. Turning it off, switching models, or closing the session cancels queries and closes the Claude helper. Other checkboxes only hide their field; hiding `remote` does not stop Remote Control. Reset countdowns remain in compact layouts; colors adapt to truecolor or ANSI-256 terminals.

### ChatGPT Remote Control (`/remote`)

**Experimental:** a built-in host for sharing Pi conversations between mobile and Mac Codex clients. Automated clients and the Pi SDK are tested; pairing and connection with the real macOS desktop App have also been verified. iOS pairing and basic message delivery have been verified; complete App workflows and on-device background handoff still need verification. `process/spawn` is not supported, so some desktop terminal features may be unavailable.

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` asks for confirmation, then shows a QR code and manual code. Pair both devices with this host and open the same conversation. The OpenAI relay and a ChatGPT-backed Pi login are still required.
- Each conversation has one Pi execution owner. A connected terminal handles its conversation. After it closes, sending from Codex resumes the same saved Pi session in the background, with its history and branch context; merely reading history starts no model request. Reopening that session in Pi returns ownership only when the background worker is idle. If it is busy or the file changed while Pi was opening, wait and reopen the session; Pi will not open a stale writable copy. Interrupted work is never automatically replayed.
- After upgrading, close old Pi windows or run `/reload` in all of them once. A lost socket alone does not allow takeover while its Pi process is alive. Older windows without ownership tracking conservatively block migration. This applies to saved conversations already registered with Remote, not deleted or in-memory sessions. The Mac and the enabled Remote background service must remain running; closing Pi windows is fine, but `/remote stop`, sleep, or shutdown prevents remote use.
- Provides home-directory browsing, folder creation, and shared projects. Only local Pi registration can share a project outside home. Known credential locations are hidden by the file browser, **not sandboxed**: paired devices can use Pi tools with the host user's permissions. Pair only trusted devices.
- The App-facing `~/.codex` is virtual: its parent is the Pi host's home, and it never exposes real Codex credentials. Image uploads use `~/.codex/attachments/<UUID>/...`, backed by `client-files/attachments/` in the private Remote directory. PNG, JPEG, WebP, and GIF are supported, up to 8 MiB each, 128 MiB total, and 256 files/folders each. File writes and deletion are limited to this attachment area; other uploads are not supported. Browsing also accepts `~`, `~/...`, and local file URLs.
- Uses its own background process and an authenticated private Unix socket. No `pi-codex-app-server` package or `codex` executable is needed. Session startup starts the local host unless `PI_CODEX_APP_SERVER_AUTOSTART=0`; first-time relay access requires `/remote start` or `/remote pair`. An enabled host reconnects after restart. `/remote stop` disables and stops it without stopping terminal Pi work.
- Uses a separate state directory. If the old daemon is running, use `/remote stop`, then `/remote pair`; old data and grants are not migrated or deleted. The host remains bound to its original ChatGPT account. To roll back, stop the new host and reinstall the prior package; its old state is untouched.
- Only part of the Codex App Server API is implemented. Codex-only desktop defaults (feature flags, extra instructions, and personality) are declined with a warning; Pi keeps its local settings. Unknown overrides, unsupported methods, and sandbox/approval changes still return errors. Running terminal work is not transferred to a background worker. After a terminal reconnect or branch change, reread the conversation; never blindly resend uncertain work. Check `/remote status` for the last unsupported App method.
- Legacy alias: `/codex-server`. Protocol tests use Codex commit `444da310e108da16aaeb18fd790b0ac464f08aca`.

### Fast mode (`/fast`)

`/fast on|off|status` toggles Codex's `service_tier: "priority"` for Codex models. Persisted in `~/.pi/agent/codex-ish.json`.

### Skill mentions (`$skill-name`)

Type `$` in the editor to autocomplete installed skills. A message mentioning `$some-skill` gets that skill's full `SKILL.md` injected into context, so you can force-load a skill for one request.

### Side conversations (`/btw` or `/side`)

Opens an in-memory, read-only side chat using the main conversation as reference. Only Pi's built-in `read`, `grep`, `find`, and `ls` tools are available; Side runs lookups and returns their results to the model before answering. Shell commands, file-changing tools, and extension tools are not exposed. Each question allows up to 8 model requests and 24 tool calls. Requires TUI mode. Side opens in a full-window overlay so its scrolling does not move the main conversation. PgUp/PgDn scroll; ↑/↓ scroll when the input is empty. Fullscreen mode also supports the mouse wheel and trackpad; regular mode uses keyboard scrolling. Esc or Ctrl+C closes the overlay and cancels pending work; branch changes and session shutdown also cancel it.

### Editor behavior

- Paste an image from the clipboard: it is saved to `.tmp/images/` and inserted as a markdown link.
- `Shift+Enter` / `Alt+Enter` insert a newline; `Super+Enter` (Cmd+Enter) submits.
- While the agent is running, `Enter` / `Tab` queue a follow-up message instead of steering.
- Command+Enter steers the current run.

## Configuration

| Setting | Location | Notes |
|---|---|---|
| Fast mode | `~/.pi/agent/codex-ish.json` | Written by `/fast` |
| Statusline fields and order | `statusline` in `~/.pi/agent/codex-ish.json` | Written by `/statusline`; `statusline.order` stores the order; independent of `/fast` |
| Remote daemon home | `~/.pi/agent/codex-ish-remote/` | Override with `PI_CODEX_ISH_REMOTE_HOME`; keep this directory private |
| Remote autostart | env | `PI_CODEX_APP_SERVER_AUTOSTART=0` disables |
| Remote local connection | `host.sock` inside the Remote home | Private Unix socket; `PI_CODEX_APP_SERVER_LISTEN` is no longer used |
| Remote host name | env | `PI_CODEX_APP_SERVER_HOST_NAME` |
| Remote control off | env | `PI_CODEX_REMOTE_CONTROL=0` |

## Dependencies

- `ws` — the built-in Remote host's WebSocket transport (npm).
- `qrcode` — terminal QR codes for pairing (npm).

Pi packages (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) are declared as peer dependencies and supplied by Pi itself.

Git installs compile the Remote host through `prepare`. For a source checkout, run `npm ci`, `npm run check`, and `npm test`. `npm pack --dry-run` checks that `dist/remote` is included. Tests use temporary directories, fake credentials, and local servers; they do not pair devices or call paid models.

## Notes and caveats

- Search, image generation, and Remote Control call OpenAI's **ChatGPT backend API** with your subscription login — these are the same endpoints the official Codex client uses, but they are not publicly documented APIs and may change.
- Image generation consumes your Codex usage quota. Cancelling a job only stops local waiting; the request may still complete server-side and count toward usage. Failed jobs are never retried automatically.
- Web content returned by search is untrusted data, not instructions.
- Background image jobs require interactive (TUI) or RPC sessions. Side conversations require TUI mode.

## License

MIT. The upstream protocol test fixtures in `tests/fixtures/codex/` retain their Apache-2.0 license and notices.
