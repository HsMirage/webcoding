# Webcoding

用浏览器远程控制本机的 Claude Code、Codex 和 Pi CLI。

[![GitHub Release](https://img.shields.io/github/v/release/HsMirage/webcoding?display_name=tag&sort=semver)](https://github.com/HsMirage/webcoding/releases/latest)
![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![Agents](https://img.shields.io/badge/Agents-Claude%20%7C%20Codex%20%7C%20Pi-111111)

[简体中文](./README.md) | [English](./README.en.md) | [v2.0.4 发布说明](https://github.com/HsMirage/webcoding/releases/tag/v2.0.4) | [更新日志](./CHANGELOG.md)

<p align="center">
  <a href="https://ai.hsnb.fun/"><strong>幻境MirageAI欢迎你</strong></a>
  &nbsp;·&nbsp;
  <a href="https://pay.ldxp.cn/shop/mirage">购买AI订阅认准：幻境MirageAI</a>
</p>

Webcoding 是一个轻量级浏览器工作台。它在本机启动并连接你已经安装、登录的 CLI Agent，让电脑、手机或平板通过同一个网页管理会话、处理中途交互、查看工具执行，并在浏览器断开后继续完成任务。

> `v2.0.4` 统一了 Claude、Codex、Pi 的模型选择：本地模式读取真实配置，会话模型实时查询并只作用于当前会话。旧的单轮执行方式仍可通过环境变量启用。

<p align="center">
  <img src="./webcoding-refactored-ui.png" alt="Webcoding v2 工作台" width="100%" />
</p>

## 30 秒开始

### 准备条件

- Node.js `22` 或更高版本
- 至少安装并登录以下一个 CLI：

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @earendil-works/pi-coding-agent
```

### 一键安装

Linux / macOS：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/HsMirage/webcoding/main/install.sh)
```

Windows PowerShell：

```powershell
$s = irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1; Invoke-Expression $s
```

安装器会先让你确认安装/运行目录，再显示安装、启动/重启、更新、重装依赖、停止、状态和卸载等选项。启动时会自动配置持久化后台服务：Linux 优先使用用户级 `systemd`，macOS 使用 `LaunchAgent`，Windows 使用当前用户的计划任务。关闭终端不会停止 Webcoding；使用原生服务管理器时，下次登录也会自动启动。

安装后可使用统一管理命令：

```text
webcoding start | restart | stop | status | logs
```

服务启动后：

1. 打开 `http://localhost:8001`。
2. 使用终端打印的 12 位初始密码登录。
3. 首次登录按提示设置新密码。
4. 选择 Claude、Codex 或 Pi，新建会话并指定工作目录。

<details>
<summary>手动安装</summary>

```bash
git clone https://github.com/HsMirage/webcoding.git
cd webcoding
npm install
npm start
```

Windows 也可以在安装依赖后双击 `start.bat`；它会注册并启动后台计划任务，不再把服务绑在当前终端窗口上。

</details>

## 核心能力

### 三 Agent 原生接入

| Agent | 默认协议 | 网页能力 | 兼容传输 |
|---|---|---|---|
| Claude Code | 双向 `stream-json` | 增量 thinking、图片、审批、用户问题、MCP elicitation、原生续接 | `headless` |
| Codex | 官方 App Server | 线程恢复/Fork、steer、中断、审批、用户问题、MCP elicitation、`/review` | `exec` |
| Pi | JSONL RPC | 扩展交互、Widget、thinking level、steer/follow-up 队列、中断、会话分支 | `headless` |

### 工作流

- **会话与项目**：按 Agent 隔离会话，支持创建、重命名、删除、工作目录浏览和项目分组。
- **原生历史**：导入 Claude projects、Codex rollouts 和 Pi JSONL 历史；Codex、Pi 支持原生分支。
- **后台执行**：关闭浏览器后任务继续运行；重新连接会恢复流式状态和待处理交互。
- **模型与权限**：每个 Agent 独立选择模型、AI 提供商和 YOLO / 默认 / Plan 权限模式。
- **运行中调整**：Codex 和 Pi 可在生成期间转向；Pi 还能把消息加入 follow-up 队列。
- **富内容**：支持图片附件、Markdown、代码高亮、沙箱 HTML 预览、工具调用和 thinking 展示。
- **命令发现**：斜杠菜单合并 Web 命令与 CLI 实时能力，不会展示无法执行的 TUI-only 命令。
- **Git 工作区**：在网页查看 status、diff、log，并执行 add、commit、分支和 checkout 操作；手机版使用分组工具栏和紧凑文件清单。
- **通知与远程访问**：支持 5 类完成通知、Cloudflare Quick Tunnel 和局域网访问。

### 安全与可靠性

- 密码登录、首次强制改密、登录失败锁定和改密后会话失效。
- `CC_WEB_PASSWORD` 永远不会传给 Agent 子进程。
- CLI 环境变量按 Agent 白名单继承，额外变量必须显式允许。
- WebSocket 单消息大小、附件类型、附件数量和附件生命周期均有限制。
- 配置写入、历史导入、历史删除和 Git 路径操作都执行目录边界检查。
- 常驻运行时按空闲时间和容量自动回收，旧传输方式保留 PID 恢复机制。

## 配置

项目会自动读取根目录的 `.env`。完整示例见 [`.env.example`](./.env.example)。

### 常用变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `8001` | Web 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机使用建议设为 `127.0.0.1` |
| `CC_WEB_PASSWORD` | 未设置 | 可选初始密码；未设置时自动生成，认证信息写入 `config/auth.json` |
| `CLAUDE_PATH` | `claude` | Claude CLI 路径 |
| `CODEX_PATH` | `codex` | Codex CLI 路径 |
| `PI_PATH` | `pi` | Pi CLI 路径 |
| `CC_WEB_WS_MAX_PAYLOAD` | `4194304` | WebSocket 单消息上限，范围 64 KB–32 MB |

<details>
<summary>高级运行时变量</summary>

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CC_WEB_CLAUDE_TRANSPORT` | `stream-json` | 设为 `headless` 使用旧的单轮 Claude 传输 |
| `CC_WEB_CLAUDE_STREAM_IDLE_TIMEOUT_MINUTES` | `30` | Claude 常驻进程空闲释放时间 |
| `CC_WEB_CLAUDE_STREAM_MAX_RUNTIMES` | `8` | Claude 常驻运行时上限 |
| `CC_WEB_CODEX_TRANSPORT` | `app-server` | 设为 `exec` 使用旧的单轮 Codex 传输 |
| `CC_WEB_CODEX_APP_IDLE_TIMEOUT_MINUTES` | `30` | Codex App Server 空闲释放时间 |
| `CC_WEB_CODEX_APP_MAX_RUNTIMES` | `8` | Codex App Server 运行时上限 |
| `CC_WEB_PI_TRANSPORT` | `rpc` | 设为 `headless` 使用旧的单轮 Pi 传输 |
| `CC_WEB_PI_RPC_IDLE_TIMEOUT_MINUTES` | `30` | Pi RPC 空闲释放时间 |
| `CC_WEB_PI_RPC_MAX_RUNTIMES` | `8` | Pi RPC 运行时上限 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude 配置、鉴权和历史目录 |
| `CODEX_HOME` | `~/.codex` | Codex 配置、鉴权和历史目录 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 配置与资源目录 |
| `PI_CODING_AGENT_SESSION_DIR` | Pi 默认目录 | Pi 原生会话目录 |
| `CC_WEB_CLI_ENV_PASSTHROUGH` | 空 | 额外传给 Agent 的变量名，逗号分隔，不填写变量值 |
| `CC_WEB_CONFIG_DIR` | `./config` | 配置存储目录 |
| `CC_WEB_SESSIONS_DIR` | `./sessions` | 会话存储目录 |
| `CC_WEB_LOGS_DIR` | `./logs` | 日志目录 |

Claude 会自动继承常见的 `ANTHROPIC_*`、`AWS_*` 变量，Codex 继承 `OPENAI_*`，Pi 继承其支持的 Provider 变量。非标准变量必须加入 `CC_WEB_CLI_ENV_PASSTHROUGH`。

</details>

### AI 提供商

在“设置 → 代理渠道”中可以：

- 分别让 Claude、Codex、Pi 使用本机配置或某个 AI 提供商。
- 保存多套 API Key、API Base URL、上游协议和默认模型。
- 仅在会话中输入 `/model` 或点击“切换模型”时，由后端实时获取当前服务商模型列表。
- 通过隔离的运行时目录使用统一提供商，不覆盖本机 Codex 或 Pi 配置。

API Key 在界面和 WebSocket 响应中都会脱敏。

### 通知

在“设置 → 通知设置”中配置 PushPlus、Telegram、Server酱、飞书机器人或 QQ（Qmsg）。通知配置保存在 `config/notify.json`。

## 远程访问

### 推荐方式

- **仅本机**：将 `HOST` 设为 `127.0.0.1`。
- **同一局域网**：保留 `HOST=0.0.0.0`，使用启动日志中的 `Network` 地址。
- **临时公网访问**：在“设置 → 远程访问”中一键安装并启动 Cloudflare Quick Tunnel，无需域名或 Cloudflare 账号。
- **固定私有网络**：电脑和手机加入同一个 Tailscale 网络后，使用 Tailscale IP 访问。

> 不建议把 `8001` 端口直接暴露到公网。公网使用时请设置强密码，并优先使用 HTTPS Tunnel、Tailscale 或带 TLS 的反向代理。

### Nginx 反向代理

<details>
<summary>查看示例</summary>

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

</details>

## 架构与恢复语义

```text
浏览器 ←WebSocket→ Node.js (server.js) ─┬─stream-json→ Claude CLI
                                       ├─JSON-RPC→ Codex App Server
                                       └─JSONL RPC→ Pi CLI
```

- 浏览器断开不会终止当前任务，重新连接后会同步运行状态和结果。
- Webcoding 服务重启会中断正在生成的常驻轮次，并清理无法继续复用的子进程。
- 三套 CLI 的原生 session/thread ID 会保存；服务恢复后的下一条消息会续接原生上下文。
- 使用兼容单轮传输时，PID 和文件尾读机制可在服务重启后重新挂载仍存活的进程。
- 会话、运行目录、附件和日志都保存在本地，不依赖外部数据库。

## 常驻部署

一键安装器会自动完成当前用户级别的常驻配置，不需要管理员权限：

- Linux：写入 `~/.config/systemd/user/webcoding.service` 并启用用户服务；若当前环境没有可用的用户级 `systemd`，自动回退到 `nohup`。
- macOS：写入 `~/Library/LaunchAgents/com.webcoding.server.plist`，通过 `launchctl` 加载并保持运行。
- Windows：注册当前用户的 `Webcoding` 计划任务，登录后自动启动；关闭 PowerShell、CMD 或 `start.bat` 窗口不会终止服务。

高级用户也可以参考 [Linux service 模板](./deploy/linux/webcoding.service) 和 [macOS LaunchAgent 模板](./deploy/macos/com.webcoding.server.plist) 手动部署。Linux 服务器若希望退出 SSH 后仍保持用户服务并在开机时运行，可额外执行 `sudo loginctl enable-linger "$USER"`。

## 更新

重新运行一键安装命令并选择“更新”，或手动执行：

```bash
git pull --ff-only
npm install
npm start
```

一键安装器更新完成后会询问是否立即重启后台服务；也可以稍后运行 `webcoding restart`。

## 开发与验证

```bash
npm start             # 启动服务，无构建步骤
npm run regression    # 48 项隔离 mock 回归，不调用真实模型
npm run contract:cli  # 检查本机三套 CLI 的参数和协议，不发送模型请求
npm test              # 依次运行以上两组检查
```

项目只有一个运行依赖：`ws`。前端使用原生 JavaScript 和模块化 CSS，不需要打包器。

<details>
<summary>项目结构</summary>

```text
webcoding/
├── server.js              # HTTP、WebSocket、认证、配置和运行时编排
├── lib/                   # Agent 适配器、双向客户端、历史解析、本地 API bridge
├── public/                # 原生 JavaScript SPA 与模块化 CSS
├── scripts/               # 回归、CLI 契约检查和 mock CLI
├── deploy/                # Linux、macOS、Windows 后台服务模板与管理脚本
├── config/                # 运行时配置（自动生成）
├── sessions/              # 会话、附件和每轮运行文件（自动生成）
├── logs/                  # JSONL 进程日志（自动生成）
├── install.sh / install.ps1 / start.bat
└── package.json
```

</details>

## 常见问题

| 现象 | 处理方式 |
|---|---|
| 提示找不到 CLI | 先在终端确认对应 CLI 能运行，或设置 `CLAUDE_PATH` / `CODEX_PATH` / `PI_PATH` |
| 页面无法连接 | 确认服务仍在运行，并检查 `HOST`、`PORT` 和防火墙 |
| 升级 CLI 后功能异常 | 执行 `npm run contract:cli`，根据失败项选择升级 CLI 或临时回退传输方式 |
| 更新后仍看到旧界面 | 强制刷新浏览器；静态资源会自动附加版本戳 |
| 远程访问不安全 | 不要直接暴露端口，改用 Quick Tunnel、Tailscale 或 HTTPS 反向代理 |

## 版本与文档

- [v2.0.4 发布说明](https://github.com/HsMirage/webcoding/releases/tag/v2.0.4)
- [完整更新日志](./CHANGELOG.md)
- [English README](./README.en.md)
