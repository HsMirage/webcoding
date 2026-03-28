# Webcoding — PROJECT.md

## 项目概述

Webcoding 是一个用 Node.js 实现的轻量级浏览器工作台，用来远程控制本机 `Claude Code` / `Codex` CLI。后端通过 detached 子进程加文件 I/O 维持任务运行，前端通过 WebSocket 实时收发消息、工具调用状态、运行态摘要和会话列表。

**创建日期**：2026-03-19
**最后更新**：2026-03-21
**当前版本**：v1.3.2
**当前状态**：进行中（双 Agent、统一 API bridge、线程续接补偿、运行态可视化、隔离回归已接通）
**当前规模**：`server.js` 5878 行，`public/app.js` 5956 行，`public/style.css` 3941 行，`scripts/regression.js` 3540 行

---

## 文件结构

```text
webcoding/
├── AGENTS.md                      # 仓库协作说明
├── CLAUDE.md                      # 仓库内补充协作说明
├── PROJECT.md                     # 项目索引与代码导航
├── PROJECTS_INDEX.md              # 工作区全局项目索引
├── README.md                      # 中文说明
├── README.en.md                   # 英文说明
├── CHANGELOG.md                   # 版本更新记录
├── CODE_REVIEW_REPORT.md          # 历史审查记录
├── MotherDuck_Design_System.md    # 视觉与设计参考
├── .env / .env.example            # 本地环境变量与模板
├── package.json                   # npm 脚本与运行依赖
├── server.js                      # 后端主入口（HTTP / WebSocket / 进程管理 / 配置 / 存储）
├── lib/
│   ├── agent-runtime.js           # Claude / Codex 启动参数与事件解析适配层
│   ├── codex-rollouts.js          # Codex rollout 历史导入解析
│   └── local-api-bridge.js        # 本地统一 API bridge 服务
├── public/
│   ├── index.html                 # 页面骨架
│   ├── app.js                     # 前端单文件 SPA 逻辑
│   ├── style.css                  # 前端样式
│   ├── sw.js                      # Service Worker
│   └── test-components.html       # 独立组件 / 可访问性测试页
├── scripts/
│   ├── regression.js              # 端到端回归脚本
│   ├── mock-claude.js             # Claude mock CLI
│   └── mock-codex.js              # Codex mock CLI
├── Project/                       # 工作区级规则、模板与说明文档
├── config/                        # 运行期配置目录与 Codex runtime home
├── sessions/                      # 会话、run 目录、附件
├── logs/                          # 服务与进程日志
├── test-results/                  # 本地测试结果缓存
├── deploy/                        # 部署模板
├── start.bat                      # Windows 启动脚本
└── *.png / *.jpg                  # UI 截图与人工回看素材
```

---

## 关联资源

- CLI 依赖：`@anthropic-ai/claude-code`、`@openai/codex`
- 运行依赖：`ws`
- 启动入口：`npm start`
- 回归入口：`npm run regression`
- 环境变量模板：`.env.example`
- 版本记录：`CHANGELOG.md`
- 配置目录：`config/`
- 会话目录：`sessions/`
- 进程日志：`logs/process.log`
- 项目分组配置：`config/projects.json`
- bridge 状态：`config/bridge-runtime.json`、`config/bridge-state.json`
- Codex 自定义运行目录：`config/codex-runtime-home/`
- 部署模板：`deploy/macos/com.webcoding.server.plist`

---

## 核心内容

### 1. 启动与常用命令

```bash
npm install
npm start
npm run regression
```

- 无构建步骤：`public/` 会被 `server.js` 直接作为静态资源提供
- `npm start`：启动 `server.js`
- `npm run regression`：启动隔离环境，使用 mock CLI 验证 WebSocket、会话、导入、bridge 和运行时行为

### 2. 当前架构

```text
Browser
  ├─ HTTP: public/*
  └─ WebSocket
     └─ server.js
        ├─ 配置 / 会话 / 附件持久化
        ├─ detached CLI 进程管理
        ├─ FileTailer 输出追踪
        ├─ runtime channel / 线程续接管理
        ├─ 本地 bridge 拉起与状态管理
        └─ lib/
           ├─ agent-runtime.js
           ├─ codex-rollouts.js
           └─ local-api-bridge.js
```

关键设计点：

- 子进程与 Node 主进程解耦：CLI 通过 `detached` + `unref()` 在后台持续运行
- 输入输出不走 pipe：使用 `sessions/{id}-run/` 中的文件作为 I/O 通道
- 运行态上下文不只保存一个线程 ID：通过 `runtimeContexts` 记录不同渠道下的 runtime 信息
- 渠道切换或原生续接失败时，会自动新开线程并注入结构化补偿上下文
- 本地统一 API bridge 按需拉起，状态写入 `config/bridge-*.json`
- Web 端主要依赖 WebSocket 消息：如 `session_list`、`session_info`、`text_delta`、`tool_start`、`tool_end`、`resume_generating`

### 3. 后端索引

#### `server.js`

这是仓库的核心单文件，当前 5878 行，主要分成这些子系统：

- 启动与目录初始化：环境变量、目录、限额、安全头、缓存
- 配置读写：认证、通知、模型模板、Codex 配置、项目分组、bridge 状态
- 运行时通道管理：fingerprint、runtime channel、线程复用、上下文补偿
- 存储与会话：会话 JSON、附件元数据、导入缓存、运行态摘要
- 进程管理：spawn、恢复、停止、完成回写、后台通知
- WebSocket 路由：登录、发消息、会话管理、设置保存、导入、项目管理、目录浏览
- HTTP 路由：静态资源、附件、更新检查、本地 bridge 相关辅助逻辑

优先阅读入口：

- `renderIndexHtml()`：页面入口 HTML 渲染
- `recoverProcesses()`：服务重启后的进程恢复
- `handleNewSession()`：创建会话
- `handleLoadSession()`：加载完整会话
- `handleMessage()`：处理用户发送消息并启动 agent
- `handleDeleteSession()` / `handleRenameSession()`：会话维护
- `handleSaveNotifyConfig()` / `handleSaveModelConfig()` / `handleSaveCodexConfig()`：设置保存
- `handleImportNativeSession()` / `handleImportCodexSession()`：历史导入
- `handleSaveProject()` / `handleDeleteProject()` / `handleRenameProject()`：项目分组管理
- `handleBrowseDirectory()`：目录浏览器
- `buildSessionRuntimeMeta()`：汇总当前会话的运行态摘要
- `buildThreadCarryoverPayload()`：线程切换时构造补偿上下文
- `ensureLocalBridgeRunning()`：本地 bridge 拉起与复用
- `FileTailer`：运行目录输出追踪

#### `lib/agent-runtime.js`

职责是把两种 CLI 的差异抽成统一接口，导出 `createAgentRuntime()`：

- `buildClaudeSpawnSpec()`：构建 Claude 启动参数
- `buildCodexSpawnSpec()`：构建 Codex 启动参数
- `processClaudeEvent()`：解析 Claude 事件流并转成前端消息
- `processCodexEvent()`：解析 Codex 事件流并转成前端消息
- 内含 runtime fingerprint、fallback resume、thread reset 相关逻辑

当需要改模型参数、权限模式、恢复逻辑、事件映射时，先看这个文件。

#### `lib/codex-rollouts.js`

负责导入 `~/.codex/sessions/` 的 rollout JSONL，导出 `createCodexRolloutStore()`：

- 解析用户消息、assistant 文本、tool call、token usage
- 归并成 Webcoding 自己的会话结构
- 为 Codex 历史导入补齐 `threadId`、标题、工作目录等元信息

如果 Codex 导入结果缺消息、缺工具调用或 token 统计异常，先看这里。

#### `lib/local-api-bridge.js`

这是一个本地桥接服务，用于在不同上游 API 协议之间做转换：

- OpenAI 风格请求转 Anthropic
- Anthropic 风格请求转 OpenAI / Responses
- SSE / JSON 响应归一化
- runtime token 校验、上游转发与状态文件写回

如果统一 API 模板、bridge token、上游兼容性有问题，先看这里。

### 4. 前端索引

#### `public/index.html`

- 只负责页面骨架和主要容器
- 真实交互几乎都在 `public/app.js`

#### `public/app.js`

前端核心单文件，当前 5956 行，主要模块：

- 连接与认证：WebSocket 连接、自动重连、密码记忆
- 会话缓存：最多缓存 4 个会话，按权重做 LRU
- 消息渲染：Markdown、代码高亮、流式文本、tool call、AskUserQuestion 面板
- 发送区：文本输入、Slash 命令、图片附件上传
- 侧边栏：会话列表、项目分组、拖拽宽度、移动端手势
- 工作区洞察：会话统计、快捷操作、运行态摘要、渠道徽章
- 设置面板：通知、模型模板、统一 API 渠道、Codex 设置、密码修改
- 导入面板：Claude 历史导入、Codex rollout 导入
- 新建会话弹窗：项目选择、路径浏览器

优先阅读入口：

- `handleServerMessage(msg)`：所有服务端消息总入口
- `openSession()`：切换并加载会话
- `renderMessages()`：消息区渲染
- `renderSessionList()`：左侧会话列表
- `sendMessage()`：发送文本、命令、附件
- `renderWorkspaceInsights()`：工作区洞察卡片
- `showUnifiedSettingsPanel()`：设置面板
- `showNewSessionModal()`：新建会话弹窗
- `showImportSessionModal()`：Claude 导入
- `showImportCodexSessionModal()`：Codex 导入

#### `public/style.css`

- 维护全局设计变量与三套主题外观
- 覆盖登录页、侧边栏、聊天区、设置面板、目录浏览器、运行态徽章和响应式布局

#### `public/sw.js`

- 负责前端通知展示与点击回焦

#### `public/test-components.html`

- 独立样式测试页，不参与主流程
- 主要用于验证会话项焦点态、tool call 可访问性和 workspace insights 视觉样式
- 改动 `public/style.css` 或交互可访问性时，可以用它做快速人工回看

### 5. 测试与回归

#### `scripts/regression.js`

这是最重要的验证脚本，当前 3540 行，特点：

- 启动真实 `server.js`
- 使用临时目录隔离 `config/`、`sessions/`、`logs/`
- 使用 `mock-claude.js`、`mock-codex.js` 替代真实 CLI
- 覆盖登录、会话创建、消息流、工具调用、模型配置、导入、断线恢复、bridge 兼容、渠道切换、线程续接、上下文补偿等路径

建议改动这些区域后运行回归：

- `server.js`
- `lib/agent-runtime.js`
- `lib/codex-rollouts.js`
- `lib/local-api-bridge.js`
- `public/app.js`

#### `scripts/mock-claude.js` / `scripts/mock-codex.js`

- 提供可控的假事件流
- 让回归脚本在不依赖真实 CLI 的情况下验证协议兼容和前后端行为

### 6. 运行期目录说明

#### `config/`

常见文件：

- `auth.json`：登录密码与强制改密状态
- `notify.json`：通知渠道配置
- `model.json`：Claude 模型模板配置
- `codex.json`：Codex 运行配置
- `projects.json`：前端项目分组
- `bridge-runtime.json` / `bridge-state.json`：本地 bridge 运行状态
- `codex-runtime-home/`：Codex 自定义渠道运行时目录，包含 `sessions/`、`memories/`、`skills/`、sqlite 状态文件

#### `sessions/`

包含三类运行数据：

- 会话 JSON 文件
- `*-run/` 运行目录，保存 `input.txt`、`output.jsonl`、`error.log`、`pid`
- `_attachments/` 附件文件与元数据

#### `logs/`

常见日志：

- `process.log`：JSONL 进程生命周期日志，支持轮转
- `server-*.stdout.log` / `server-*.stderr.log`：服务输出
- `launch-agent.log`、`local-8001.log`：本地启动与部署辅助日志

### 7. 辅助文档与素材

这些不是主运行代码，但在接手项目时有参考价值：

- `Project/RULES_GLOBAL.md`、`Project/DESC_DIR.md`、`Project/DESC_ENV.md`：工作区级规则与环境说明
- `Project/_template/PROJECT.md`、`Project/_template/PROGRESS.md`：项目文档模板
- `CODE_REVIEW_REPORT.md`：历史审查报告
- `MotherDuck_Design_System.md`：视觉与界面参考
- 根目录多张 `*.png` / `*.jpg`：登录页、主界面、移动端和焦点态人工验收截图

### 8. 常见改动怎么找入口

| 需求 | 优先查看文件 |
|------|--------------|
| 调整 CLI 启动参数 | `lib/agent-runtime.js` |
| 调整 WebSocket 消息协议 | `server.js`、`public/app.js` |
| 修复流式输出或工具调用显示 | `lib/agent-runtime.js`、`public/app.js` |
| 修复线程续接 / 上下文补偿 | `server.js`、`lib/agent-runtime.js` |
| 修复会话恢复 / 后台任务恢复 | `server.js` |
| 修复 Codex 历史导入 | `lib/codex-rollouts.js` |
| 调整模型模板 / 自定义 API | `server.js`、`lib/local-api-bridge.js` |
| 调整统一 API 渠道 / bridge | `server.js`、`lib/agent-runtime.js`、`lib/local-api-bridge.js` |
| 调整设置面板 | `public/app.js`、`public/style.css` |
| 调整登录 / 记住密码 | `public/app.js`、`server.js` |
| 调整项目分组 / 路径浏览器 | `server.js`、`public/app.js` |
| 调整工作区洞察 / 运行态徽章 | `public/app.js`、`public/style.css` |
| 调整测试页 | `public/test-components.html`、`public/style.css` |
| 修复回归失败 | `scripts/regression.js` + 对应 mock CLI |

---

## 备注

- 仓库当前工作树不是干净状态，核心代码和文档均存在未提交改动；后续修改前先看 `git status` 和目标文件差异，避免覆盖用户工作。
- 当前代码结构以“大单文件 + 少量适配模块”为主，查问题时优先从入口函数定位，不要先做大范围重构。
- `config/`、`sessions/`、`logs/` 属于运行期数据目录，排查可以读，业务改动不要直接写到这些生成文件里。
- `config/codex-runtime-home/` 内含运行期状态和技能目录，不适合作为业务代码编辑目标。

---

## 进度记录

| 日期 | 说明 |
|------|------|
| 2026-03-19 | 创建项目索引 `PROJECT.md`，补全仓库结构、模块职责与查找入口 |
| 2026-03-21 | 按当前仓库实际结构刷新索引，补充辅助文档与素材、真实文件规模、runtime channel / 线程补偿入口、本地 bridge 与运行期目录说明 |
