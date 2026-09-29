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

- Pi Coding Agent (the extension imports Pi's own packages, which Pi provides).
- Node.js 22.5+ (uses the built-in `node:sqlite`).
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

Custom footer with model, provider, remote-control state, context usage, and live quota:

- **Codex**: 5-hour and weekly remaining percentage with reset countdown (including a separate limit for `gpt-5.3-codex-spark`).
- **Antigravity (Google)**: per-model-family quota groups.
- Refreshes every 60 seconds; colors adapt to truecolor or ANSI-256 terminals.

### ChatGPT Remote Control (`/remote`)

Control this Pi host from the ChatGPT mobile app:

```
/remote status | start | stop | pair | devices | revoke CLIENT_ID
```

- `/remote pair` shows a QR code to scan with ChatGPT, plus a manual pairing code.
- Runs a local `pi-codex-app-server` daemon (auto-starts on session start; set `PI_CODEX_APP_SERVER_AUTOSTART=0` to disable).
- Legacy alias: `/codex-server`.

### Fast mode (`/fast`)

`/fast on|off|status` toggles Codex's `service_tier: "priority"` for Codex models. Persisted in `~/.pi/agent/codex-ish.json`.

### Skill mentions (`$skill-name`)

Type `$` in the editor to autocomplete installed skills. A message mentioning `$some-skill` gets that skill's full `SKILL.md` injected into context, so you can force-load a skill for one request.

### Side conversations (`/btw` or `/side`)

Opens an ephemeral side chat that inherits the main conversation as read-only reference. Ask questions without disrupting or continuing the main thread; the side agent is instructed never to modify anything. Ctrl+C to close, PgUp/PgDn to scroll.

### Editor behavior

- Paste an image from the clipboard: it is saved to `.tmp/images/` and inserted as a markdown link.
- `Shift+Enter` / `Alt+Enter` insert a newline; `Super+Enter` (Cmd+Enter) submits.
- While the agent is running, `Enter` / `Tab` queue a follow-up message instead of steering.
- Command+Enter steers the current run.

## Configuration

| Setting | Location | Notes |
|---|---|---|
| Fast mode | `~/.pi/agent/codex-ish.json` | Written by `/fast` |
| Remote daemon home | `~/.pi/agent/codex-app-server/` | Override with `PI_CODEX_APP_SERVER_HOME` |
| Remote autostart | env | `PI_CODEX_APP_SERVER_AUTOSTART=0` disables |
| Remote listen address | env | `PI_CODEX_APP_SERVER_LISTEN` (default `ws://127.0.0.1:0`) |
| Remote control off | env | `PI_CODEX_REMOTE_CONTROL=0` |

## Dependencies

- `pi-codex-app-server` — the Remote Control daemon (npm).
- `qrcode` — terminal QR codes for pairing (npm).

Pi packages (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) are declared as peer dependencies and supplied by Pi itself.

## Notes and caveats

- Search, image generation, and Remote Control call OpenAI's **ChatGPT backend API** with your subscription login — these are the same endpoints the official Codex client uses, but they are not publicly documented APIs and may change.
- Image generation consumes your Codex usage quota. Cancelling a job only stops local waiting; the request may still complete server-side and count toward usage. Failed jobs are never retried automatically.
- Web content returned by search is untrusted data, not instructions.
- Interactive (TUI) or RPC sessions are required for background image jobs and the side-conversation overlay.

## License

MIT
