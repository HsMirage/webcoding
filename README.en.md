# Webcoding

Webcoding is a lightweight browser workspace for Claude Code, Codex, and Pi, designed to keep each agent close to its native CLI workflow while sharing the same web shell.

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/ae974fcd-b6a7-4bdf-8553-bfcf2e7038a4" alt="Screenshot 1" width="30%" />
  <img src="https://github.com/user-attachments/assets/eb0291c1-2b38-4379-9a07-8eecc6c87d8f" alt="Screenshot 2" width="30%" />
  <img src="https://github.com/user-attachments/assets/09cec007-a949-44cf-9f2a-88c1eda60082" alt="Screenshot 3" width="30%" />
</p>

## Features

- **Lightweight runtime**: low backend overhead, browser-based control panel.
- **Multi-agent sessions**: create Claude, Codex, or Pi sessions on the same backend core.
- **Agent-isolated views**: switching Claude / Codex / Pi only shows that agent's sessions, recent state, settings, and import entry points.
- **Agent-specific settings**: each agent keeps its own model, provider, permission mode, and runtime adapter.
- **Native reasoning controls**: `/effort` controls Claude/Codex effort and Pi thinking level using current CLI/model capabilities; Pi also keeps the familiar `/thinking` alias.
- **Persistent Claude stream**: reuses one bidirectional `stream-json` process per Web session with partial thinking, hook events, images, native resume, browser approvals, user questions, and MCP elicitation.
- **Codex App Server**: native thread start/resume/fork, same-turn steering, interrupt, browser approvals, user questions, and MCP elicitation.
- **Bidirectional Pi RPC**: persistent Pi sessions with extension dialogs, status/widgets, composer prefills, native steer/follow-up queues, abort, model and thinking-level discovery, and command discovery.
- **Multi-session management**: create, switch, rename, and delete sessions, including cleanup of the matching native thread or Web-managed session storage.
- **Local history import**: import Claude projects, Codex rollouts, and the active branch of Pi JSONL sessions with tools, thinking, usage, and cost.
- **Native forks**: Codex `/fork` duplicates the current thread; Pi `/fork` lets you search user-message history and restores the selected prompt as an editable draft.
- **Native session resume**: Claude, Codex, and Pi persist their own native session IDs and restore context on later turns.
- **Background task support**: the selected agent keeps running after browser disconnect; reconnect restores streaming state and pending interactions.
- **Multi-channel notifications**: PushPlus / Telegram / ServerChan / Feishu bot / QQ (Qmsg), configurable in Web UI.
- **Persistent runtimes**: each CLI uses its native bidirectional protocol with idle and capacity-based cleanup.
- **Multi-API switching**: configure multiple API profiles and switch between them instantly from the UI.
- **Password-based auth**: initial password generation, forced first-login reset, and password change in Web UI.
- **Native Codex review**: `/review` uses App Server `review/start` inside the current thread.
- **CLI contract checks**: `npm run contract:cli` validates real Claude flags, Codex App Server schemas, and Pi RPC without sending model requests.

## Requirements

- **Node.js** >= 22
- At least one configured **Claude Code CLI**, **Codex CLI**, or **Pi CLI**

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @earendil-works/pi-coding-agent
```

## Quick Start

### One-line install (recommended)

**Linux / macOS**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh)
```

**Windows (PowerShell)**
```powershell
$s = irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1; Invoke-Expression $s
```

The script presents an interactive menu — choose to install, launch, update, reinstall dependencies, uninstall, or exit. After installing, visit `http://localhost:8001` and enter your password.

> **First-time password**: on first startup, a random 12-character password is auto-generated and printed to the console. You will be required to change it on first login.

> Custom install directory:
> - Linux/macOS: `bash <(curl -fsSL ...) ~/mydir`
> - Windows: `$env:WEBCODING_DIR="C:\mydir"; $s = irm ...; iex $s`

### Manual install

**Linux / macOS**
```bash
git clone https://github.com/HsMirage/webcoding.git
cd webcoding
npm install
npm start
```

**Windows**
```cmd
git clone https://github.com/HsMirage/webcoding.git
cd webcoding
npm install
```
Then run `start.bat`, or start manually with `node server.js`.

After startup, open `http://localhost:8001` and sign in with your password.

> **First-time password**: on first startup, a random 12-character password is auto-generated and printed to the console. You will be required to change it on first login.

## Configuration

### Environment Variables (.env)

| Variable | Required | Default | Description |
|------|:---:|--------|------|
| `CC_WEB_PASSWORD` | No | Auto-generated | Web login password (migrated into `config/auth.json` on first start) |
| `PORT` | No | `8001` | Service port |
| `HOST` | No | `0.0.0.0` | Service bind address; use `127.0.0.1` for local-only access |
| `CLAUDE_PATH` | No | `claude` | Executable path to Claude CLI |
| `CODEX_PATH` | No | `codex` | Executable path to Codex CLI |
| `PI_PATH` | No | `pi` | Executable path to Pi CLI |
| `CC_WEB_CLAUDE_TRANSPORT` | No | `stream-json` | Claude transport; use `headless` for legacy one-shot mode |
| `CC_WEB_CLAUDE_STREAM_IDLE_TIMEOUT_MINUTES` | No | `30` | Idle lifetime for persistent Claude runtimes |
| `CC_WEB_CLAUDE_STREAM_MAX_RUNTIMES` | No | `8` | Maximum persistent Claude runtimes |
| `CC_WEB_CODEX_TRANSPORT` | No | `app-server` | Codex transport; use `exec` for legacy one-shot mode |
| `CC_WEB_CODEX_APP_IDLE_TIMEOUT_MINUTES` | No | `30` | Idle lifetime for Codex App Server runtimes |
| `CC_WEB_CODEX_APP_MAX_RUNTIMES` | No | `8` | Maximum Codex App Server runtimes |
| `CC_WEB_PI_TRANSPORT` | No | `rpc` | Pi transport; set `headless` to use the previous one-shot JSON mode |
| `CC_WEB_PI_RPC_IDLE_TIMEOUT_MINUTES` | No | `30` | Idle Pi RPC process lifetime, clamped to 1–1440 minutes |
| `CC_WEB_PI_RPC_MAX_RUNTIMES` | No | `8` | Maximum concurrent Pi RPC runtimes, clamped to 1–64 |
| `CLAUDE_CONFIG_DIR` | No | `~/.claude` | Claude configuration, authentication, and history directory |
| `CODEX_HOME` | No | `~/.codex` | Codex configuration, authentication, and history directory |
| `PI_CODING_AGENT_DIR` | No | `~/.pi/agent` | Pi configuration, resources, and native history directory |
| `PI_CODING_AGENT_SESSION_DIR` | No | `PI_CODING_AGENT_DIR/sessions` | Pi native session directory; takes precedence over `PI_CODING_AGENT_DIR` |
| `CC_WEB_CLI_ENV_PASSTHROUGH` | No | - | Additional environment variable names passed to agents, separated by commas |
| `CC_WEB_WS_MAX_PAYLOAD` | No | `4194304` | Maximum WebSocket message size in bytes (64 KB–32 MB) |
| `PUSHPLUS_TOKEN` | No | - | PushPlus token (migrated into notification config on first start) |

Note: the `CC_WEB_*` variable prefix is kept for backward compatibility with older installs. The product name is now `Webcoding`.

Claude automatically receives local `ANTHROPIC_*` and `AWS_*` provider settings, Codex receives `OPENAI_*`, and Pi receives its supported provider variables. Add non-standard keys to `CC_WEB_CLI_ENV_PASSTHROUGH`; `CC_WEB_PASSWORD` is always blocked from agent subprocesses.

### Notification Configuration

Open the **Settings (⚙)** button in the sidebar to configure notifications in Web UI.

| Channel | Required Fields | How to Get |
|---------|---------|---------|
| **PushPlus** | Token | Register at [pushplus.plus](https://www.pushplus.plus/) |
| **Telegram** | Bot Token + Chat ID | Create bot via [@BotFather](https://t.me/BotFather) |
| **ServerChan** | SendKey | Register at [sct.ftqq.com](https://sct.ftqq.com/) |
| **Feishu Bot** | Webhook URL | Feishu group → Settings → Group Bot |
| **QQ (Qmsg)** | Qmsg Key | Obtain from [qmsg.zendee.cn](https://qmsg.zendee.cn/) |

Settings are stored in `config/notify.json`. Tokens are masked in UI display.

### Password Management

Passwords are stored in `config/auth.json` and support generation + UI updates:

- **First startup** (no password in `.env` and no `auth.json`): auto-generates a random 12-character password, prints it to console, and requires password reset on first login.
- **Migration from `.env`**: if `CC_WEB_PASSWORD` is already set, it is migrated to `auth.json` automatically at startup.
- **Change password in UI**: Settings panel → Change Password (requires current password).
- **Password policy**: at least 8 characters, with at least 2 of these categories: uppercase, lowercase, number, special character.
- **After password change**: all existing logged-in sessions are invalidated.

## Project Structure

```text
webcoding/
├── server.js              # Node.js backend (HTTP + WebSocket + process management + notifications)
├── public/
│   ├── index.html          # UI structure
│   ├── app.js              # Frontend logic (WebSocket, UI interactions)
│   ├── style.css           # Styles
│   └── sw.js               # Service Worker (mobile notifications)
├── config/
│   ├── notify.json         # Notification channel config (generated at runtime)
│   └── auth.json           # Auth config (generated at runtime)
├── deploy/
│   └── macos/
│       └── com.webcoding.server.plist  # macOS LaunchAgent template
├── sessions/               # Chat history JSON files (generated at runtime)
├── logs/                   # Process lifecycle logs (generated at runtime)
├── lib/                    # Agent runtime + Codex rollout parsing helpers
├── scripts/                # Regression tooling + mock CLIs
├── .env.example            # Environment variable template
├── start.bat               # Windows startup script
├── .gitignore
├── package.json
└── README.md
```

## Architecture

### Process Model

```text
Browser ←WebSocket→ Node.js (server.js) ─┬─stream-json→ Claude CLI (persistent)
                                        ├─JSON-RPC→ Codex App Server (persistent)
                                        └─JSONL RPC→ Pi CLI (persistent)
```

- Claude uses a persistent bidirectional `stream-json` process, while Codex uses its official App Server. Environment variables can restore the legacy one-shot transports.
- Claude and Codex approvals, user questions, and MCP elicitation are rendered as browser forms and returned through their native bidirectional protocols.
- Pi uses one persistent `--mode rpc` process per active Web session, with correlated JSONL requests and events.
- While Pi is generating, new messages can use its native `steer` or `followUp` queue. Web history follows Pi's actual execution order, and duplicate client message IDs are coalesced.
- Pi RPC restores pending queue state after reconnect. Aborting discards messages that have not started. By default, idle runtimes expire after 30 minutes with at most 8 concurrent runtimes; both limits are configurable.
- A server restart interrupts an active persistent turn, but all three native session IDs remain available and resume on the next message.
- Set `CC_WEB_PI_TRANSPORT=headless` to restore the one-shot `pi -p --mode json` path.
- Legacy one-shot transports persist PIDs and stream file updates for restart recovery.

### Background Task Flow

1. User sends a message → reuse or start the selected agent's persistent runtime.
2. User closes browser → the active runtime keeps running.
3. The agent emits its native completion event → the server persists the result.
4. Completion notification is sent.
5. User reconnects → completed response is synced.

### Process Logs

`logs/process.log` uses JSONL format with automatic 2MB rotation.

| Event | Description |
|------|------|
| `process_spawn` | Process created (PID, mode, model) |
| `process_complete` | Process finished (exit code, duration, cost) |
| `ws_connect` / `ws_disconnect` | Client connected/disconnected |
| `ws_resume_attach` | Client reconnected to running process |
| `recovery_alive` / `recovery_dead` | Process recovery during service restart in legacy one-shot mode |
| `heartbeat` | Active process snapshot every 60 seconds |

View logs:

```bash
tail -f logs/process.log | jq .
```

## Production Deployment

### systemd Service

Create `/etc/systemd/system/webcoding.service`:

```ini
[Unit]
Description=Webcoding - Claude Code / Codex Web Workspace
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/webcoding
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# Important: only stop Node.js process, not Claude child processes
KillMode=process

[Install]
WantedBy=multi-user.target
```

`KillMode=process` is important. It ensures systemd restart only stops Node.js, while Claude subprocesses continue and are reattached after recovery.

```bash
sudo systemctl enable webcoding
sudo systemctl start webcoding
```

### macOS LaunchAgent

The repository includes a template:

```text
deploy/macos/com.webcoding.server.plist
```

Before using it, replace these placeholder paths with real paths from your machine:

- `/absolute/path/to/npm`
- `/absolute/path/to/node/bin`
- `/absolute/path/to/webcoding`

Then copy it to `~/Library/LaunchAgents/com.webcoding.server.plist` and load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.webcoding.server.plist
launchctl kickstart -k gui/$(id -u)/com.webcoding.server
```

If you previously used the old label `com.ccweb.server`, unload it first so two launch items do not compete for the same port:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccweb.server.plist 2>/dev/null || true
```

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Long-running tasks may take time
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Windows Deployment

Use this mode when running Webcoding on a personal PC and controlling Claude / Codex from mobile.

Start with `start.bat`, or run manually:

```cmd
cd webcoding
npm install
node server.js
```

**LAN access** (same Wi-Fi):
- Open `http://<your-lan-ip>:8001`

**Remote access**:
- Recommended: [Tailscale](https://tailscale.com/) for secure private networking.
- Alternative: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (requires domain setup).

## Release Notes

- **v1.3.2**
  - Expanded the unified API runtime so Claude and Codex can switch across local/custom channels with safer native resume behavior.
  - Added structured carryover when a thread must be rebuilt, preserving recent context, paths, models, and key constraints.
  - Backed up and restored `~/.claude/settings.json` when entering or leaving unified API mode.
  - Added cache-busting query versions for `app.js` and `style.css`, plus broader regression coverage for bridge/runtime edge cases.

- **v1.3.0**
  - Added a macOS LaunchAgent template at `deploy/macos/com.webcoding.server.plist`.
  - Renamed the LaunchAgent label to `com.webcoding.server` so it matches the project name.
  - Renamed the npm package metadata to `webcoding`, so startup logs now show `webcoding@1.3.0 start`.

- **v1.2.8**
  - **Dual-agent (Codex)**: create Claude or Codex sessions on the same backend; agent-isolated sidebar, settings, and import
  - **Image upload**: drag, paste, or attach images in both Claude and Codex sessions; client-side WebP compression, 7-day server cache, up to 4 images per message
  - **Session loading**: loading overlay, hot session cache (4 slots, strong/weak hit), fix for streaming content disappearing on tab switch
  - **Theme system**: full theme engine with CoolVibe Light, washi, and editorial variants; theme picker moved to sub-page
  - **Mobile UX**: swipe-to-open/close sidebar, running-state badge replaces cwd label, button sizing fixes
  - **Backend refactor**: spawn spec + event parsing extracted to `lib/agent-runtime.js`; isolated regression script `npm run regression`

- **v1.2.2**
  - Aligned context compression with Claude Code native behavior: `/compact` is now actually sent to CLI instead of doing a local pseudo-reset.
  - Added automatic overflow recovery: when `Request too large (max 20MB)` occurs, Webcoding runs `/compact` and replays the failed prompt automatically.
  - Added retry guard: if context is still too large after compacting, Webcoding stops auto-retry and asks for a narrower prompt range.
- **v1.2.1**
  - Fixed missing `AskUserQuestion` options in Web UI by preserving structured tool input in backend and rendering question/option cards on frontend.
  - Added option-to-input shortcut: click an option to append it into the input box for quick confirmation.
- **v1.2**
  - Fixed layout overflow caused by long code blocks in messages. The page no longer stretches horizontally; code blocks scroll within the block.
  - Improved mobile input behavior: Enter inserts newline by default, and sending is done via the send button.
- **v1.1**
  - Added compatibility improvements for Claude Code CLI on Windows.

## Notes

- Claude, Codex, and Pi all use persistent native protocols by default. Commands that only exist as interactive TUI screens are explicitly marked unavailable instead of being advertised as runnable.
