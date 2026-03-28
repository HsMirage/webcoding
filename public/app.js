// === webcoding Frontend ===
(function () {
  'use strict';
  window.addEventListener('error', (e) => { console.error('[WEBCODING-INIT-ERROR]', e.message, e.filename, e.lineno); });

  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const RENDER_DEBOUNCE = 100;

  // Claude Code model entries — matches real /model output
  const CLAUDE_MODEL_ENTRIES = [
    { alias: 'default', value: 'default', label: '默认（推荐）', desc: '使用默认模型（当前为 Sonnet 4.6）', pricing: '输入/输出 $3 / $15 / 百万 Token' },
    { alias: 'sonnet[1m]', value: 'sonnet[1m]', label: 'Sonnet（1M 上下文）', desc: 'Sonnet 4.6，适合长上下文会话', pricing: '输入/输出 $3 / $15 / 百万 Token' },
    { alias: 'opus', value: 'opus', label: 'Opus', desc: 'Opus 4.6，复杂任务能力最强', pricing: '输入/输出 $5 / $25 / 百万 Token' },
    { alias: 'opus[1m]', value: 'opus[1m]', label: 'Opus（1M 上下文）', desc: 'Opus 4.6，支持 1M 上下文，适合复杂任务', pricing: '输入/输出 $5 / $25 / 百万 Token' },
    { alias: 'haiku', value: 'haiku', label: 'Haiku', desc: 'Haiku 4.5，响应最快，适合快速问答', pricing: '输入/输出 $1 / $5 / 百万 Token' },
  ];

  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: '清除当前会话' },
    { cmd: '/model', desc: '查看/切换模型' },
    { cmd: '/mode', desc: '查看/切换权限模式' },
    { cmd: '/cost', desc: '查看会话费用' },
    { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/help', desc: '显示帮助' },
  ];

  const MODE_LABELS = {
    default: '默认',
    plan: 'Plan',
    yolo: 'YOLO',
  };

  const AGENT_LABELS = {
    claude: 'Claude',
    codex: 'Codex',
  };

  const DEFAULT_AGENT = 'claude';
  const SESSION_CACHE_LIMIT = 4;
  const SESSION_CACHE_MAX_WEIGHT = 1_500_000;
  const SIDEBAR_SWIPE_TRIGGER = 72;
  const SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT = 42;
  const SIDEBAR_WIDTH_STORAGE_KEY = 'webcoding-sidebar-width';
  const SIDEBAR_DEFAULT_WIDTH = 320;
  const SIDEBAR_MIN_WIDTH = 280;
  const SIDEBAR_MAX_WIDTH = 560;
  const GIT_PANEL_WIDTH_STORAGE_KEY = 'webcoding-git-panel-width';
  const GIT_PANEL_DEFAULT_WIDTH = 360;
  const GIT_PANEL_MIN_WIDTH = 280;
  const GIT_PANEL_MAX_WIDTH = 720;
  const DESKTOP_INSIGHTS_BREAKPOINT = 1280;
  const VISIBILITY_RESYNC_THROTTLE_MS = 2500;
  const SESSION_LIST_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const INPUT_MAX_HEIGHT_FALLBACK = 200;
  const RECONNECT_MAX_ATTEMPTS = 8;
  const REMEMBERED_PASSWORD_STORAGE_KEY = 'webcoding-remembered-password';
  const THEME_STORAGE_KEY = 'webcoding-theme';
  const DEFAULT_THEME = 'default';
  const THEME_LABELS = {
    default: '默认主题',
    localhost: '极简主题',
  };

  const MODE_PICKER_OPTIONS = [
    { value: 'yolo', label: 'YOLO', desc: '跳过所有权限检查' },
    { value: 'plan', label: 'Plan', desc: '执行前需确认计划' },
    { value: 'default', label: '默认', desc: '标准权限审批' },
  ];


  // --- State ---
  let ws = null;
  const TOOL_GROUP_THRESHOLD = 2;
  let authToken = localStorage.getItem('webcoding-token');
  let pendingAuthPassword = null;
  let pendingPasswordChangeValue = null;
  let currentSessionId = null;
  let sessions = [];
  let sessionCache = new Map();
  let isGenerating = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pendingText = '';
  let renderTimer = null;
  let activeToolCalls = new Map();
  let cmdMenuIndex = -1;
  let cmdMenuDelegated = false;
  let currentMode = 'yolo';
  let currentModel = '';
  let currentActiveRuntime = null;
  let currentRuntimeCount = 0;
  const savedAgent = localStorage.getItem('webcoding-agent');
  let selectedAgent = AGENT_LABELS[savedAgent] ? savedAgent : DEFAULT_AGENT;
  let currentAgent = selectedAgent;
  let modelConfigCache = null;
  let codexConfigCache = null;
  let loadedHistorySessionId = null;
  let activeSessionLoad = null;
  let sidebarSwipe = null;
  let pendingAttachments = [];
  let uploadingAttachments = [];
  let currentCwd = null;
  let currentSessionRunning = false;
  let skipDeleteConfirm = localStorage.getItem('webcoding-skip-delete-confirm') === '1';
  let pendingInitialSessionLoad = false;
  let projects = [];
  let collapsedProjects = new Set();
  let sidebarResizeState = null;
  let gitPanelResizeState = null;
  let lastVisibilityResyncAt = 0;
  let localIdCounter = 0;
  let cachedInputMaxHeight = INPUT_MAX_HEIGHT_FALLBACK;
  const toastQueue = [];
  let activeToast = null;
  let pendingProjectSaveCallback = null;
  let gitState = {
    cwd: null,
    loading: false,
    lastError: '',
    status: null,
    logEntries: [],
    branchEntries: [],
    panelOpen: false,
    activePanelView: 'status',
    panelDiffContent: '',
    panelDiffTitle: '',
    panelLogEntries: [],
    filesExpanded: false,
    collapsedTreeNodes: [],
  };

  // Stage-1 state grouping: keep legacy vars as source of truth, expose grouped accessors.
  const connectionState = {
    get ws() { return ws; },
    set ws(value) { ws = value; },
    get reconnectAttempts() { return reconnectAttempts; },
    set reconnectAttempts(value) { reconnectAttempts = value; },
    get reconnectTimer() { return reconnectTimer; },
    set reconnectTimer(value) { reconnectTimer = value; },
    get pendingInitialSessionLoad() { return pendingInitialSessionLoad; },
    set pendingInitialSessionLoad(value) { pendingInitialSessionLoad = value; },
    get authToken() { return authToken; },
    set authToken(value) { authToken = value; },
  };

  const sessionState = {
    get currentSessionId() { return currentSessionId; },
    set currentSessionId(value) { currentSessionId = value; },
    get currentAgent() { return currentAgent; },
    set currentAgent(value) { currentAgent = value; },
    get currentMode() { return currentMode; },
    set currentMode(value) { currentMode = value; },
    get currentModel() { return currentModel; },
    set currentModel(value) { currentModel = value; },
    get currentActiveRuntime() { return currentActiveRuntime; },
    set currentActiveRuntime(value) { currentActiveRuntime = value; },
    get currentRuntimeCount() { return currentRuntimeCount; },
    set currentRuntimeCount(value) { currentRuntimeCount = value; },
    get sessions() { return sessions; },
    set sessions(value) { sessions = value; },
    get sessionCache() { return sessionCache; },
    set sessionCache(value) { sessionCache = value; },
    get loadedHistorySessionId() { return loadedHistorySessionId; },
    set loadedHistorySessionId(value) { loadedHistorySessionId = value; },
    get activeSessionLoad() { return activeSessionLoad; },
    set activeSessionLoad(value) { activeSessionLoad = value; },
    get currentCwd() { return currentCwd; },
    set currentCwd(value) { currentCwd = value; },
    get currentSessionRunning() { return currentSessionRunning; },
    set currentSessionRunning(value) { currentSessionRunning = value; },
  };

  const composeState = {
    get isGenerating() { return isGenerating; },
    set isGenerating(value) { isGenerating = value; },
    get pendingText() { return pendingText; },
    set pendingText(value) { pendingText = value; },
    get activeToolCalls() { return activeToolCalls; },
    set activeToolCalls(value) { activeToolCalls = value; },
    get pendingAttachments() { return pendingAttachments; },
    set pendingAttachments(value) { pendingAttachments = value; },
    get uploadingAttachments() { return uploadingAttachments; },
    set uploadingAttachments(value) { uploadingAttachments = value; },
  };

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const rememberPw = $('#remember-pw');
  const app = $('#app');
  const sessionLoadingOverlay = $('#session-loading-overlay');
  const sessionLoadingLabel = $('#session-loading-label');
  const sidebar = $('#sidebar');
  const sidebarResizer = $('#sidebar-resizer');
  const sidebarOverlay = $('#sidebar-overlay');
  const menuBtn = $('#menu-btn');
  const workspaceMain = document.querySelector('.workspace-main');
  const chatMain = document.querySelector('.chat-main');
  const workspaceInsights = $('#workspace-insights');
  const workspaceInsightsContent = $('#workspace-insights-content');
  const gitPanelEl = $('#git-panel');
  const gitPanelContent = $('#git-panel-content');
  const gitPanelBtn = $('#git-panel-btn');
  const newChatSplit = sidebar.querySelector('.new-chat-split');
  const newChatBtn = $('#new-chat-btn');
  const newChatArrow = $('#new-chat-arrow');
  const newChatDropdown = $('#new-chat-dropdown');
  const importSessionBtn = $('#import-session-btn');
  const sessionList = $('#session-list');
  const chatTitle = $('#chat-title');
  const chatAgentContext = $('#chat-agent-context');
  const chatRuntimeState = $('#chat-runtime-state');
  const chatCwd = $('#topbar-chat-cwd');
  const costDisplay = $('#topbar-cost-display');
  const attachmentTray = $('#attachment-tray');
  const imageUploadInput = $('#image-upload-input');
  const attachBtn = $('#attach-btn');
  const messagesDiv = $('#messages');
  const msgInput = $('#msg-input');
  const inputWrapper = msgInput.closest('.input-wrapper');
  const sendBtn = $('#send-btn');
  const abortBtn = $('#abort-btn');
  const cmdMenu = $('#cmd-menu');
  const modeSelect = $('#mode-select');

  function getRememberedPassword() {
    return String(sessionStorage.getItem(REMEMBERED_PASSWORD_STORAGE_KEY) || '');
  }

  function hasRememberedPassword() {
    return !!getRememberedPassword();
  }

  function saveRememberedPassword(password) {
    const value = String(password || '');
    if (value) sessionStorage.setItem(REMEMBERED_PASSWORD_STORAGE_KEY, value);
    else sessionStorage.removeItem(REMEMBERED_PASSWORD_STORAGE_KEY);
  }

  function clearRememberedPassword() {
    sessionStorage.removeItem(REMEMBERED_PASSWORD_STORAGE_KEY);
  }

  function restoreRememberedPasswordInput() {
    const rememberedPassword = getRememberedPassword();
    if (rememberPw) rememberPw.checked = !!rememberedPassword;
    if (!loginPassword) return;
    loginPassword.value = rememberedPassword;
  }

  function getStoredTheme() {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_LABELS[raw] ? raw : DEFAULT_THEME;
  }

  function applyTheme(theme, options = {}) {
    const nextTheme = THEME_LABELS[theme] ? theme : DEFAULT_THEME;
    document.documentElement.dataset.theme = nextTheme;
    if (document.body) {
      document.body.dataset.theme = nextTheme;
    }
    if (!options.skipPersist) {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    }
    return nextTheme;
  }

  function parseStoredCollapsedProjects() {
    try {
      const raw = localStorage.getItem('webcoding-collapsed-projects') || '[]';
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function nextLocalId(prefix = 'tmp') {
    localIdCounter += 1;
    return `${prefix}-${Date.now()}-${localIdCounter}`;
  }

  function refreshInputMaxHeightCache() {
    const raw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--input-max-height'), 10);
    cachedInputMaxHeight = Number.isFinite(raw) && raw > 0 ? raw : INPUT_MAX_HEIGHT_FALLBACK;
  }

  function createOverlayPanel({
    overlayClass = 'settings-overlay',
    overlayId = '',
    panelClass = 'settings-panel',
    zIndex = '',
    maxWidth = '',
    panelHtml = '',
  } = {}) {
    const overlay = document.createElement('div');
    overlay.className = overlayClass;
    if (overlayId) overlay.id = overlayId;
    if (zIndex) overlay.style.zIndex = String(zIndex);

    const panel = document.createElement('div');
    panel.className = panelClass;
    if (maxWidth) panel.style.maxWidth = maxWidth;
    if (panelHtml) panel.innerHTML = panelHtml;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return {
      overlay,
      panel,
      close: () => overlay.remove(),
    };
  }

  function ensureGitPanelResizer() {
    if (!gitPanelEl?.parentNode) return null;
    const existing = document.getElementById('git-panel-resizer');
    if (existing) return existing;
    const resizer = document.createElement('div');
    resizer.id = 'git-panel-resizer';
    resizer.className = 'git-panel-resizer';
    resizer.setAttribute('aria-hidden', 'true');
    gitPanelEl.parentNode.insertBefore(resizer, gitPanelEl);
    return resizer;
  }

  function getGitPanelWidthLimit() {
    const containerWidth = workspaceMain?.getBoundingClientRect().width || window.innerWidth || GIT_PANEL_DEFAULT_WIDTH;
    const insightsWidth = window.matchMedia(`(min-width: ${DESKTOP_INSIGHTS_BREAKPOINT}px)`).matches
      ? (workspaceInsights?.getBoundingClientRect().width || 0)
      : 0;
    return Math.min(GIT_PANEL_MAX_WIDTH, Math.max(GIT_PANEL_MIN_WIDTH, containerWidth - insightsWidth - 320));
  }

  function clampGitPanelWidth(width) {
    const numericWidth = Number(width);
    if (!Number.isFinite(numericWidth)) return GIT_PANEL_DEFAULT_WIDTH;
    return Math.max(GIT_PANEL_MIN_WIDTH, Math.min(getGitPanelWidthLimit(), Math.round(numericWidth)));
  }

  function applyGitPanelWidth(width, options = {}) {
    const nextWidth = clampGitPanelWidth(width);
    document.documentElement.style.setProperty('--git-panel-width', `${nextWidth}px`);
    if (!options.skipPersist) {
      localStorage.setItem(GIT_PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
    }
    return nextWidth;
  }

  function canResizeGitPanel() {
    return !!gitPanelEl && !!ensureGitPanelResizer() && window.matchMedia('(min-width: 769px) and (pointer: fine)').matches;
  }

  function syncGitPanelResizerVisibility() {
    const resizer = ensureGitPanelResizer();
    if (!resizer) return;
    resizer.classList.toggle('visible', gitState.panelOpen && canResizeGitPanel());
  }

  collapsedProjects = new Set(parseStoredCollapsedProjects());

  // --- Viewport height fix for mobile browsers ---
  function setVH() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  }

  function getSidebarWidthLimit() {
    const reserveWidth = window.matchMedia(`(min-width: ${DESKTOP_INSIGHTS_BREAKPOINT}px)`).matches ? 860 : 440;
    const viewportMax = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - reserveWidth);
    return Math.min(SIDEBAR_MAX_WIDTH, viewportMax);
  }

  function clampSidebarWidth(width) {
    const numericWidth = Number(width);
    if (!Number.isFinite(numericWidth)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(getSidebarWidthLimit(), Math.round(numericWidth)));
  }

  function applySidebarWidth(width, options = {}) {
    const nextWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--sidebar-width', `${nextWidth}px`);
    if (!options.skipPersist) {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    }
    return nextWidth;
  }

  function canResizeSidebar() {
    return !!sidebarResizer && window.matchMedia('(min-width: 769px) and (pointer: fine)').matches;
  }

  function syncSidebarWidthForViewport() {
    if (!canResizeSidebar()) {
      document.body.classList.remove('sidebar-resizing');
      sidebarResizeState = null;
      return;
    }
    const savedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || `${SIDEBAR_DEFAULT_WIDTH}`, 10);
    applySidebarWidth(savedWidth, { skipPersist: true });
  }

  function syncGitPanelWidthForViewport() {
    syncGitPanelResizerVisibility();
    if (!canResizeGitPanel()) {
      document.body.classList.remove('git-panel-resizing');
      gitPanelResizeState = null;
      document.documentElement.style.setProperty('--git-panel-width', `${GIT_PANEL_DEFAULT_WIDTH}px`);
      return;
    }
    const savedWidth = parseInt(localStorage.getItem(GIT_PANEL_WIDTH_STORAGE_KEY) || `${GIT_PANEL_DEFAULT_WIDTH}`, 10);
    applyGitPanelWidth(savedWidth, { skipPersist: true });
  }

  setVH();
  refreshInputMaxHeightCache();
  applyTheme(getStoredTheme(), { skipPersist: true });
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));
  window.addEventListener('resize', refreshInputMaxHeightCache);
  window.addEventListener('orientationchange', () => setTimeout(refreshInputMaxHeightCache, 100));
  syncSidebarWidthForViewport();
  syncGitPanelWidthForViewport();
  window.addEventListener('resize', syncSidebarWidthForViewport);
  window.addEventListener('resize', syncGitPanelWidthForViewport);

  function buildWorkspaceActionButtons(actions, options = {}) {
    const className = options.compact ? 'workspace-action-row' : 'workspace-action-grid';
    return `
      <div class="${className}">
        ${actions.map((action) => `
          <button
            class="workspace-action-btn${action.primary ? ' primary' : ''}"
            type="button"
            data-workspace-action="${escapeHtml(action.action)}"
            ${action.projectId ? `data-project-id="${escapeHtml(action.projectId)}"` : ''}
          >${escapeHtml(action.label)}</button>
        `).join('')}
      </div>
    `;
  }

  function getCurrentProjectContext() {
    const currentMeta = sessionState.currentSessionId ? getSessionMeta(sessionState.currentSessionId) : null;
    if (!currentMeta) return null;
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    return findBestProjectForSession(currentMeta, projectsById) || buildVirtualProjectFromSession(currentMeta);
  }

  function sessionBelongsToProject(session, project, projectsById) {
    if (!session || !project) return false;
    if (project.isVirtualCwd) {
      const sessionPath = session.cwd || decodeClaudeProjectDir(session.importedFrom);
      return !!sessionPath && isSameOrChildPath(project.path, sessionPath);
    }
    const matchedProject = findBestProjectForSession(session, projectsById);
    return matchedProject ? matchedProject.id === project.id : false;
  }

  function getCurrentProjectSessionCount(project) {
    if (!project) return 0;
    const visibleSessions = getVisibleSessions();
    const projectsById = new Map(projects.map((entry) => [entry.id, entry]));
    return visibleSessions.filter((session) => sessionBelongsToProject(session, project, projectsById)).length;
  }

  function getCurrentMessageCount() {
    const cachedSnapshot = sessionState.currentSessionId ? buildCachedSessionSnapshot(sessionState.currentSessionId) : null;
    if (cachedSnapshot?.messages?.length) return cachedSnapshot.messages.length;
    return messagesDiv ? messagesDiv.querySelectorAll('.msg').length : 0;
  }

  function buildWorkspaceInsightsMarkup() {
    const visibleSessions = getVisibleSessions();
    const currentMeta = sessionState.currentSessionId ? getSessionMeta(sessionState.currentSessionId) : null;
    const activeProject = getCurrentProjectContext();
    const runningCount = visibleSessions.filter((session) => session.isRunning).length;
    const currentMessageCount = getCurrentMessageCount();
    const usageText = costDisplay?.textContent || (sessionState.currentAgent === 'codex' ? '暂无 token 统计' : '暂无费用统计');
    const modeLabel = MODE_LABELS[sessionState.currentMode] || sessionState.currentMode;
    const modelLabel = sessionState.currentModel || (sessionState.currentAgent === 'codex' ? '默认模型' : 'Default');
    const channelLabel = sessionState.currentActiveRuntime?.channelLabel || '当前渠道未建立';
    const runtimeCountLabel = sessionState.currentRuntimeCount > 0 ? `${sessionState.currentRuntimeCount} 个` : '0 个';
    const selectedAgentLabel = AGENT_LABELS[selectedAgent] || selectedAgent;
    const currentAgentLabel = AGENT_LABELS[sessionState.currentAgent] || sessionState.currentAgent;
    const runtimeLabel = sessionState.currentSessionRunning ? '运行中' : currentMeta ? '待命中' : '未开始';
    const projectSessionCount = getCurrentProjectSessionCount(activeProject);
    const actionButtons = buildWorkspaceActionButtons([
      { action: 'new-session', label: '新建会话', primary: true },
      { action: 'import-session', label: '导入历史' },
      { action: 'switch-model', label: '切换模型' },
      { action: 'switch-mode', label: '切换模式' },
      ...(activeProject ? [{ action: 'focus-project', label: '定位项目', projectId: activeProject.id }] : []),
      { action: 'open-settings', label: '打开设置' },
    ]);

    return `
      <div class="insights-shell">
        <section class="insights-hero">
          <div class="insights-hero-stats">
            <div class="insights-hero-stat">
              <span>新对话</span>
              <strong>${escapeHtml(selectedAgentLabel)}</strong>
            </div>
            <div class="insights-hero-stat">
              <span>会话数</span>
              <strong>${visibleSessions.length}</strong>
            </div>
            <div class="insights-hero-stat">
              <span>运行中</span>
              <strong>${runningCount}</strong>
            </div>
          </div>
        </section>

        <section class="insights-card">
          <div class="insights-card-header">
            <div>
              <div class="insights-card-kicker">当前会话</div>
              <h3>${escapeHtml(currentMeta?.title || '还没有打开会话')}</h3>
            </div>
            <span class="insights-status-pill${sessionState.currentSessionRunning ? ' running' : ''}">${runtimeLabel}</span>
          </div>
          <div class="insights-detail-list">
            <div class="insights-detail-item"><span>当前代理</span><strong>${escapeHtml(currentAgentLabel)}</strong></div>
            <div class="insights-detail-item"><span>当前渠道</span><strong>${escapeHtml(channelLabel)}</strong></div>
            <div class="insights-detail-item"><span>模型</span><strong>${escapeHtml(modelLabel)}</strong></div>
            <div class="insights-detail-item"><span>模式</span><strong>${escapeHtml(modeLabel)}</strong></div>
            <div class="insights-detail-item"><span>子线程</span><strong>${escapeHtml(runtimeCountLabel)}</strong></div>
            <div class="insights-detail-item"><span>消息数</span><strong>${currentMessageCount > 0 ? `${currentMessageCount} 条` : '暂无'}</strong></div>
            <div class="insights-detail-item"><span>最近更新</span><strong>${escapeHtml(currentMeta?.updated ? timeAgo(currentMeta.updated) : '尚未开始')}</strong></div>
          </div>
          <div class="insights-note">${escapeHtml(usageText)}</div>
        </section>

        <section class="insights-card">
          <div class="insights-card-header">
            <div>
              <div class="insights-card-kicker">快捷操作</div>
            </div>
          </div>
          ${actionButtons}
        </section>
      </div>
    `;
  }

  function renderWorkspaceInsights() {
    if (!workspaceInsightsContent) return;
    workspaceInsightsContent.innerHTML = buildWorkspaceInsightsMarkup();
  }

  function resetGitState(next = {}) {
    gitState = {
      cwd: null,
      loading: false,
      lastError: '',
      status: null,
      logEntries: [],
      branchEntries: [],
      panelOpen: gitState.panelOpen,
      activePanelView: 'status',
      panelDiffContent: '',
      panelDiffTitle: '',
      panelLogEntries: [],
      filesExpanded: false,
      collapsedTreeNodes: [],
      ...next,
    };
    updateGitPanelBadge();
    if (gitState.panelOpen) renderGitPanel();
  }

  function getGitRepoLabel(repoRoot) {
    const normalized = String(repoRoot || '').replace(/[\\/]+$/, '');
    if (!normalized) return '未识别仓库';
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }

  function sendGitCommand(action, params = {}, options = {}) {
    const cwd = String(options.cwd || params.cwd || sessionState.currentCwd || '').trim();
    if (!cwd) {
      return Promise.reject(new Error('当前会话还没有工作目录，无法执行 Git 操作。'));
    }
    const requestId = nextLocalId('git');
    const waiter = waitForWsEvent('git_result', {
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000,
      predicate: (payload) => payload?.requestId === requestId && payload?.action === action,
    });
    if (action === 'status') {
      gitState.loading = true;
      gitState.lastError = '';
      gitState.cwd = cwd;
      renderWorkspaceInsights();
    }
    send({
      ...params,
      type: 'git_command',
      action,
      cwd,
      sessionId: sessionState.currentSessionId,
      requestId,
    });
    return waiter.then((payload) => {
      if (!payload?.success) throw new Error(payload?.error || 'Git 操作失败');
      return payload;
    });
  }

  function requestGitStatus(options = {}) {
    if (!sessionState.currentCwd) {
      resetGitState();
      renderWorkspaceInsights();
      return Promise.resolve(null);
    }
    return sendGitCommand('status', {}, options).catch((error) => {
      gitState.loading = false;
      gitState.status = null;
      gitState.lastError = error.message || '读取 Git 状态失败';
      renderWorkspaceInsights();
      if (!options.silent) appendError(gitState.lastError);
      return null;
    });
  }

  function gitFileStatusText(file) {
    if (!file) return '未知状态';
    if (file.conflicted) return '冲突';
    if (file.untracked) return '未跟踪';
    if (file.renamed) return '已重命名';
    if (file.deleted && file.staged) return '已暂存删除';
    if (file.deleted) return '已删除';
    if (file.added && file.staged) return '已暂存新增';
    if (file.added) return '新增';
    if (file.staged && file.modified) return '已暂存 + 未暂存';
    if (file.staged) return '已暂存';
    if (file.modified) return '已修改';
    return file.code || '已变更';
  }

  function buildGitFileRowsMarkup(files, expanded = false) {
    const list = Array.isArray(files) ? files : [];
    if (list.length === 0) {
      return '<div class="insights-note">工作区干净，没有未提交改动。</div>';
    }
    const visibleFiles = expanded ? list : list.slice(0, 6);
    const hiddenCount = list.length - visibleFiles.length;
    return `
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:8px">
        ${visibleFiles.map((file) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:4px">
            <div style="min-width:0;flex:1">
              <div style="font-size:12px;font-weight:600;color:var(--text-primary);word-break:break-all;line-height:1.3">${escapeHtml(file.path)}</div>
              <div style="font-size:11px;color:var(--text-secondary);line-height:1.2">${escapeHtml(gitFileStatusText(file))}</div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
              <button
                class="workspace-action-btn"
                type="button"
                style="padding:2px 2px;font-size:10px;color:var(--text-muted);border-color:var(--line);box-shadow:none;background:transparent;min-width:0;letter-spacing:0"
                data-git-action="show-diff"
                data-git-file="${escapeHtml(file.path)}"
                ${file.staged && !file.modified ? 'data-git-staged="1"' : ''}
              >diff</button>
              ${!file.staged ? `
                <button
                  class="workspace-action-btn"
                  type="button"
                  style="padding:3px 7px;font-size:11px"
                  data-git-action="add"
                  data-git-file="${escapeHtml(file.path)}"
                >暂存</button>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>
      ${hiddenCount > 0 ? `
        <button class="insights-note" style="cursor:pointer;text-decoration:underline;text-underline-offset:3px;background:none;border:none;padding:0;color:var(--text-muted);font-size:inherit;width:100%;text-align:left" data-git-action="expand-files">还有 ${hiddenCount} 个文件，点击展开全部</button>
      ` : ''}
    `;
  }

  function normalizeGitTreePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  }

  function createEmptyGitTreeSummary() {
    return {
      total: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
    };
  }

  function appendGitFileToSummary(summary, file) {
    if (!summary || !file) return summary;
    summary.total += 1;
    if (file.staged) summary.staged += 1;
    if (file.modified) summary.modified += 1;
    if (file.untracked) summary.untracked += 1;
    if (file.conflicted) summary.conflicted += 1;
    return summary;
  }

  function buildGitTreeBadges(summary) {
    const badges = [
      summary?.staged ? { label: `暂存 ${summary.staged}`, tone: 'staged' } : null,
      summary?.modified ? { label: `修改 ${summary.modified}`, tone: 'modified' } : null,
      summary?.untracked ? { label: `未跟踪 ${summary.untracked}`, tone: 'untracked' } : null,
      summary?.conflicted ? { label: `冲突 ${summary.conflicted}`, tone: 'conflicted' } : null,
    ].filter(Boolean);
    if (!badges.length) return '';
    return `
      <span class="git-tree-badges">
        ${badges.map((badge) => `<span class="git-tree-badge ${badge.tone}">${escapeHtml(badge.label)}</span>`).join('')}
      </span>
    `;
  }

  function gitFileStatusTone(file) {
    if (!file) return '';
    if (file.conflicted) return 'conflicted';
    if (file.modified) return 'modified';
    if (file.staged) return 'staged';
    if (file.untracked) return 'untracked';
    return '';
  }

  function buildGitFileTree(files) {
    const root = [];
    const folders = new Map();
    const list = Array.isArray(files) ? files : [];
    const ensureFolder = (segments) => {
      const key = segments.join('/');
      if (folders.has(key)) return folders.get(key);
      const node = {
        type: 'folder',
        name: segments[segments.length - 1] || '',
        key,
        children: [],
        summary: createEmptyGitTreeSummary(),
      };
      if (segments.length === 1) {
        root.push(node);
      } else {
        ensureFolder(segments.slice(0, -1)).children.push(node);
      }
      folders.set(key, node);
      return node;
    };

    for (const file of list) {
      const normalizedPath = normalizeGitTreePath(file?.path);
      if (!normalizedPath) continue;
      const nextFile = { ...file, path: normalizedPath };
      const segments = normalizedPath.split('/').filter(Boolean);
      if (segments.length <= 1) {
        root.push({ type: 'file', key: normalizedPath, file: nextFile });
        continue;
      }
      const folderSegments = segments.slice(0, -1);
      folderSegments.forEach((_, index) => {
        appendGitFileToSummary(ensureFolder(folderSegments.slice(0, index + 1)).summary, nextFile);
      });
      ensureFolder(folderSegments).children.push({ type: 'file', key: normalizedPath, file: nextFile });
    }

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        const aName = a.type === 'folder'
          ? a.name
          : (a.file?.path.split('/').pop() || a.file?.path || '');
        const bName = b.type === 'folder'
          ? b.name
          : (b.file?.path.split('/').pop() || b.file?.path || '');
        return aName.localeCompare(bName, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      nodes.forEach((node) => {
        if (node.type === 'folder') sortNodes(node.children);
      });
    };

    sortNodes(root);
    return root;
  }

  function renderGitTreeNodes(nodes, collapsedSet, depth = 0) {
    return nodes.map((node) => {
      if (node.type === 'folder') {
        const isCollapsed = collapsedSet.has(node.key);
        return `
          <div class="git-tree-node git-tree-folder${isCollapsed ? ' collapsed' : ''}" style="--git-tree-depth:${depth}">
            <button
              type="button"
              class="git-tree-folder-header"
              data-git-action="toggle-tree-node"
              data-git-node="${escapeHtml(node.key)}"
              aria-expanded="${String(!isCollapsed)}"
            >
              <span class="git-tree-folder-leading">
                <span class="git-tree-folder-rail" aria-hidden="true">
                  <span class="git-tree-chevron">▸</span>
                </span>
                <span class="git-tree-folder-main">
                  <span class="git-tree-folder-name">${escapeHtml(node.name)}</span>
                  <span class="git-tree-folder-meta">${node.summary.total} 个变更文件</span>
                </span>
              </span>
              <span class="git-tree-folder-trailing">
                <span class="git-tree-folder-badges">
                  ${buildGitTreeBadges(node.summary)}
                </span>
              </span>
            </button>
            <div class="git-tree-children${isCollapsed ? ' collapsed' : ''}">
              ${renderGitTreeNodes(node.children, collapsedSet, depth + 1)}
            </div>
          </div>
        `;
      }
      const file = node.file;
      const statusText = gitFileStatusText(file);
      const statusTone = gitFileStatusTone(file);
      return `
        <div class="git-tree-node git-tree-file" style="--git-tree-depth:${depth}">
          <div class="git-tree-file-row">
            <div class="git-tree-file-leading" aria-hidden="true">
              <span class="git-tree-file-marker"></span>
            </div>
            <div class="git-tree-file-main">
              <div class="git-tree-file-head">
                <div class="git-tree-file-name">${escapeHtml(file.path.split('/').pop() || file.path)}</div>
                <span class="git-tree-badge git-tree-file-status${statusTone ? ` ${statusTone}` : ''}">${escapeHtml(statusText)}</span>
              </div>
              <div class="git-tree-file-meta">${escapeHtml(file.path)}</div>
            </div>
            <div class="git-tree-file-trailing">
              <div class="git-tree-file-actions">
                <button
                  class="workspace-action-btn git-tree-action-btn"
                  type="button"
                  data-git-action="show-diff"
                  data-git-file="${escapeHtml(file.path)}"
                  ${file.staged && !file.modified ? 'data-git-staged="1"' : ''}
                >diff</button>
                ${!file.staged ? `
                  <button
                    class="workspace-action-btn git-tree-action-btn git-tree-stage-btn"
                    type="button"
                    data-git-action="add"
                    data-git-file="${escapeHtml(file.path)}"
                  >暂存</button>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function buildGitFileTreeMarkup(files) {
    const list = Array.isArray(files) ? files : [];
    if (list.length === 0) {
      return '<div class="insights-note">工作区干净，没有未提交改动。</div>';
    }
    const collapsedSet = new Set(Array.isArray(gitState.collapsedTreeNodes) ? gitState.collapsedTreeNodes : []);
    const tree = buildGitFileTree(list);
    return `<div class="git-tree-list">${renderGitTreeNodes(tree, collapsedSet)}</div>`;
  }

  function buildGitInsightsCardMarkup() {
    const cwd = sessionState.currentCwd || '';
    const status = gitState.status;
    const summary = status?.summary || { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
    const repoName = status?.repoRoot ? getGitRepoLabel(status.repoRoot) : (cwd ? getGitRepoLabel(cwd) : '未识别仓库');
    const trackingParts = [];
    if (status?.upstream) trackingParts.push(status.upstream);
    const stateLabel = !cwd
      ? '未就绪'
      : gitState.loading
        ? '刷新中'
        : status
          ? (status.clean ? '干净' : '有改动')
          : '未加载';
    const actionButtons = cwd ? buildWorkspaceActionButtons([
      { action: 'refresh-git', label: '刷新 Git', primary: true },
      { action: 'show-git-diff', label: '工作区 Diff' },
      { action: 'show-git-staged-diff', label: '已暂存 Diff' },
      { action: 'show-git-log', label: '查看 Log' },
      { action: 'git-add-all', label: '全部暂存' },
      { action: 'git-commit', label: '提交' },
      { action: 'git-checkout', label: '切分支' },
      { action: 'git-create-branch', label: '新建分支' },
    ], { compact: true }) : '';

    let bodyHtml = '';
    if (!cwd) {
      bodyHtml = '<div class="insights-note">当前会话没有工作目录，暂时无法读取 Git 信息。</div>';
    } else if (!status && gitState.loading) {
      bodyHtml = '<div class="insights-note">正在读取 Git 状态…</div>';
    } else if (!status && gitState.lastError) {
      bodyHtml = `<div class="insights-note">${escapeHtml(gitState.lastError)}</div>`;
    } else if (!status) {
      bodyHtml = '<div class="insights-note">点击“刷新 Git”后读取当前仓库状态。</div>';
    } else {
      const statsBadges = [
        summary.staged     ? `<span class="git-insights-badge staged">暂存 ${summary.staged}</span>` : '',
        summary.modified   ? `<span class="git-insights-badge modified">修改 ${summary.modified}</span>` : '',
        summary.untracked  ? `<span class="git-insights-badge untracked">未跟踪 ${summary.untracked}</span>` : '',
        summary.conflicted ? `<span class="git-insights-badge conflicted">冲突 ${summary.conflicted}</span>` : '',
      ].filter(Boolean).join('');
      const hasChanges = statsBadges.length > 0;
      bodyHtml = `
        <div class="git-insights-summary">
          ${trackingParts.length ? `<span class="git-insights-track">${escapeHtml(trackingParts.join(' · '))}</span>` : ''}
          <span class="git-insights-badges">
            ${hasChanges ? statsBadges : '<span class="git-insights-clean">干净</span>'}
          </span>
        </div>
        ${gitState.loading ? '<div class="insights-note">正在刷新 Git 状态…</div>' : ''}
        ${gitState.lastError ? `<div class="insights-note">${escapeHtml(gitState.lastError)}</div>` : ''}
        ${status.files?.length ? buildGitFileRowsMarkup(status.files, gitState.filesExpanded) : ''}
      `;
    }

    const branchLabel = status ? (status.branch || 'HEAD') : '';
    return `
      <section class="insights-card">
        <div class="insights-card-header">
          <div class="git-insights-header-main">
            <h3>${escapeHtml(repoName)}</h3>
            ${branchLabel ? `<span class="git-insights-branch">${escapeHtml(branchLabel)}</span>` : ''}
          </div>
          <span class="insights-status-pill${status && !status.clean ? ' running' : ''}">${escapeHtml(stateLabel)}</span>
        </div>
        ${bodyHtml}
        ${actionButtons}
      </section>
    `;
  }

  // === Git Panel ===

  function toggleGitPanel() {
    if (gitState.panelOpen) {
      closeGitPanel();
    } else {
      openGitPanel(gitState.activePanelView || 'status');
    }
  }

  function openGitPanel(view) {
    gitState.panelOpen = true;
    gitState.activePanelView = view || 'status';
    if (gitPanelEl) gitPanelEl.classList.add('visible');
    syncGitPanelWidthForViewport();
    if (gitPanelBtn) gitPanelBtn.classList.add('active');
    renderGitPanel();
    if (view === 'status' && sessionState.currentCwd && !gitState.status && !gitState.loading) {
      requestGitStatus({ silent: true });
    }
  }

  function closeGitPanel() {
    handleGitPanelResizeEnd();
    gitState.panelOpen = false;
    if (gitPanelEl) gitPanelEl.classList.remove('visible');
    if (gitPanelBtn) gitPanelBtn.classList.remove('active');
    syncGitPanelWidthForViewport();
  }

  function renderGitPanel() {
    if (!gitPanelContent) return;
    const view = gitState.activePanelView;
    // Sync toolbar disabled state
    const toolbar = document.getElementById('git-panel-toolbar');
    if (toolbar) {
      const disabled = !sessionState.currentCwd;
      toolbar.querySelectorAll('.git-toolbar-btn').forEach((btn) => {
        btn.disabled = disabled;
      });
    }
    // Sync tab active state
    const activeTabView = view === 'staged-diff' ? 'diff' : view;
    document.querySelectorAll('.git-panel-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.gitView === activeTabView);
    });
    if (view === 'status') {
      gitPanelContent.innerHTML = buildGitPanelStatusMarkup();
    } else if (view === 'diff' || view === 'staged-diff') {
      gitPanelContent.innerHTML = buildGitPanelDiffMarkup();
    } else if (view === 'log') {
      gitPanelContent.innerHTML = buildGitPanelLogMarkup();
    } else if (view === 'commit') {
      gitPanelContent.innerHTML = buildGitPanelCommitMarkup();
      setupGitPanelCommitHandlers();
    } else {
      gitPanelContent.innerHTML = buildGitPanelStatusMarkup();
    }
  }

  function buildGitPanelStatusMarkup() {
    const cwd = sessionState.currentCwd || '';
    const status = gitState.status;
    const summary = status?.summary || { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
    const trackingParts = [];
    if (status?.upstream) trackingParts.push(status.upstream);
    if (status?.ahead) trackingParts.push(`ahead ${status.ahead}`);
    if (status?.behind) trackingParts.push(`behind ${status.behind}`);
    let bodyHtml = '';
    if (!cwd) {
      bodyHtml = '<div class="insights-note">当前会话没有工作目录。</div>';
    } else if (!status && gitState.loading) {
      bodyHtml = '<div class="insights-note">正在读取 Git 状态…</div>';
    } else if (!status && gitState.lastError) {
      bodyHtml = `<div class="insights-note">${escapeHtml(gitState.lastError)}</div>`;
    } else if (!status) {
      bodyHtml = '<div class="insights-note">点击「刷新」后读取当前仓库状态。</div>';
    } else {
      bodyHtml = `
        <section class="git-panel-status-shell">
          <div class="git-panel-status-summary">
            <div class="git-panel-status-main">
              <span class="git-panel-status-branch">${escapeHtml(status.branch || 'HEAD')}</span>
              ${trackingParts.length ? `<span class="git-panel-status-track">${escapeHtml(trackingParts.join(' · '))}</span>` : ''}
            </div>
            <div class="git-panel-status-badges">
              ${summary.staged ? `<span class="git-insights-badge staged">暂存 ${summary.staged}</span>` : ''}
              ${summary.modified ? `<span class="git-insights-badge modified">修改 ${summary.modified}</span>` : ''}
              ${summary.untracked ? `<span class="git-insights-badge untracked">未跟踪 ${summary.untracked}</span>` : ''}
              ${summary.conflicted ? `<span class="git-insights-badge conflicted">冲突 ${summary.conflicted}</span>` : ''}
              ${!summary.staged && !summary.modified && !summary.untracked && !summary.conflicted ? '<span class="git-insights-clean">干净</span>' : ''}
            </div>
          </div>
          ${gitState.lastError ? `<div class="insights-note">${escapeHtml(gitState.lastError)}</div>` : ''}
          <div class="git-panel-tree-wrap">
            ${buildGitFileTreeMarkup(status.files || [])}
          </div>
        </section>
      `;
    }
    return bodyHtml;
  }

  function buildGitPanelDiffMarkup() {
    const content = gitState.panelDiffContent;
    const title = gitState.panelDiffTitle;
    if (!content) {
      return '<div class=\"insights-note\">当前没有 diff 内容。</div>';
    }
    return `
      ${title ? `<div style=\"font-size:12px;color:var(--text-muted);margin-bottom:8px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.04em\">${escapeHtml(title)}</div>` : ''}
      <pre class=\"git-panel-code\"><code class=\"language-diff\">${escapeHtml(content)}</code></pre>
    `;
  }

  function buildGitPanelLogMarkup() {
    const entries = gitState.panelLogEntries;
    if (!entries.length) {
      return '<div class=\"insights-note\">暂无提交记录。</div>';
    }
    const items = entries.map((e) => `
      <div class=\"git-panel-log-item\">
        <span class=\"git-panel-log-hash\">${escapeHtml(e.hash || '')}</span>
        <span class=\"git-panel-log-subject\">${escapeHtml(e.subject || '')}</span>
      </div>
    `).join('');
    return `<div class=\"git-panel-log-list\">${items}</div>`;
  }

  function buildGitPanelCommitMarkup() {
    const stagedCount = gitState.status?.summary?.staged || 0;
    return `
      <div class=\"git-panel-commit-area\">
        <label class=\"modal-field-label\" for=\"git-panel-commit-message\">提交说明</label>
        <textarea id=\"git-panel-commit-message\" class=\"themed-textarea\" rows=\"6\"
          placeholder=\"例如：feat: add git panel\"
          style=\"min-height:120px;resize:vertical;width:100%\"></textarea>
        <div class=\"settings-inline-note\">${stagedCount > 0 ? `当前有 ${stagedCount} 个已暂存文件。` : '当前没有已暂存文件，请先暂存后再提交。'}</div>
        <div class=\"settings-status\" id=\"git-panel-commit-status\"></div>
        <button class=\"settings-btn primary\" id=\"git-panel-commit-submit\"${stagedCount > 0 ? '' : ' disabled'}>提交</button>
      </div>
    `;
  }

  function setupGitPanelCommitHandlers() {
    const submitBtn = document.getElementById('git-panel-commit-submit');
    const messageEl = document.getElementById('git-panel-commit-message');
    const statusEl = document.getElementById('git-panel-commit-status');
    if (!submitBtn || !messageEl) return;
    submitBtn.addEventListener('click', () => {
      const message = String(messageEl.value || '').trim();
      if (!message) {
        if (statusEl) { statusEl.textContent = '提交说明不能为空。'; statusEl.className = 'settings-status error'; }
        return;
      }
      submitBtn.disabled = true;
      if (statusEl) { statusEl.textContent = '正在提交…'; statusEl.className = 'settings-status'; }
      sendGitCommand('commit', { message }).then(() => {
        if (statusEl) { statusEl.textContent = '提交完成'; statusEl.className = 'settings-status success'; }
        messageEl.value = '';
        showToast('Git 提交完成');
        requestGitStatus({ silent: true }).then(() => openGitPanel('status'));
      }).catch((error) => {
        if (statusEl) { statusEl.textContent = error.message || 'Git 提交失败'; statusEl.className = 'settings-status error'; }
        submitBtn.disabled = false;
      });
    });
  }

  function updateGitPanelBadge() {
    const badge = document.getElementById('git-badge');
    if (!badge) return;
    const summary = gitState.status?.summary;
    if (!summary) { badge.hidden = true; return; }
    const count = (summary.staged || 0) + (summary.modified || 0) + (summary.untracked || 0);
    if (count > 0) {
      badge.textContent = String(count > 99 ? '99+' : count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function closeGitModal() {
    document.getElementById('git-modal-overlay')?.remove();
  }

  function showGitTextModal(title, text, options = {}) {
    closeGitModal();
    const { overlay, panel, close } = createOverlayPanel({
      overlayClass: 'modal-overlay',
      overlayId: 'git-modal-overlay',
      panelClass: 'modal-panel modal-panel-wide',
      maxWidth: '960px',
      panelHtml: `
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(title)}</span>
          <button class="modal-close-btn" id="git-modal-close">✕</button>
        </div>
        <div class="modal-body">
          <pre style="margin:0;max-height:60vh;overflow:auto;background:#101828;color:#f8fafc;padding:16px;border-radius:8px;"><code class="${escapeHtml(options.language ? `language-${options.language}` : '')}">${escapeHtml(text || '暂无内容')}</code></pre>
        </div>
      `,
    });
    panel.querySelector('#git-modal-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    const codeEl = panel.querySelector('code');
    if (window.hljs && codeEl && options.language) {
      try { window.hljs.highlightElement(codeEl); } catch {}
    }
  }

  async function showGitLogModal() {
    try {
      const result = await sendGitCommand('log');
      const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
      gitState.logEntries = entries;
      gitState.panelLogEntries = entries;
      openGitPanel('log');
    } catch (error) {
      appendError(error.message || '读取 Git 历史失败');
    }
  }

  async function showGitDiffModal({ staged = false, file = '' } = {}) {
    try {
      const result = await sendGitCommand('diff', { staged, file });
      const title = file
        ? `Git Diff · ${file}${staged ? ' · 已暂存' : ''}`
        : (staged ? 'Git Diff · 已暂存' : 'Git Diff · 工作区');
      gitState.panelDiffContent = result.data?.diff || '当前范围没有 diff。';
      gitState.panelDiffTitle = title;
      openGitPanel(staged ? 'staged-diff' : 'diff');
    } catch (error) {
      appendError(error.message || '读取 Git diff 失败');
    }
  }

  async function performGitAdd(file = '.') {
    if (file === '.') {
      const summary = gitState.status?.summary || {};
      const total = (summary.modified || 0) + (summary.untracked || 0) + (summary.staged || 0);
      const lines = [];
      if (summary.modified) lines.push(`${summary.modified} 个已修改`);
      if (summary.untracked) lines.push(`${summary.untracked} 个未跟踪`);
      if (summary.staged) lines.push(`${summary.staged} 个已在暂存区`);
      const desc = total > 0 ? lines.join('、') : '工作区无改动';
      const confirmed = await showGitConfirmModal({
        title: '全部暂存',
        message: `将暂存所有工作区改动。`,
        detail: desc,
        confirmLabel: '确认暂存',
      });
      if (!confirmed) return;
    }
    try {
      await sendGitCommand('add', { file });
      showToast(file === '.' ? '已暂存全部改动' : `已暂存 ${file}`);
      requestGitStatus({ silent: true });
    } catch (error) {
      appendError(error.message || '暂存文件失败');
    }
  }

  function showGitCommitModal() {
    openGitPanel('commit');
  }

  function showGitConfirmModal({ title, message, detail, confirmLabel = '确认', danger = false, alertOnly = false }) {
    return new Promise((resolve) => {
      const { overlay, close } = createOverlayPanel({
        overlayClass: 'modal-overlay',
        panelClass: 'modal-panel',
        maxWidth: '400px',
        panelHtml: `
          <div class="modal-header">
            <span class="modal-title">${escapeHtml(title)}</span>
            <button class="modal-close-btn" id="git-confirm-close">✕</button>
          </div>
          <div class="modal-body" style="padding:16px 20px;display:flex;flex-direction:column;gap:10px">
            <p style="margin:0;color:var(--text-primary)">${escapeHtml(message)}</p>
            ${detail ? `<p style="margin:0;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">${escapeHtml(detail)}</p>` : ''}
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
              ${alertOnly ? '' : '<button class="modal-btn-secondary" id="git-confirm-cancel">取消</button>'}
              <button class="modal-btn-${danger ? 'danger' : 'primary'}" id="git-confirm-ok">${escapeHtml(confirmLabel)}</button>
            </div>
          </div>
        `,
      });
      const done = (val) => { close(); resolve(val); };
      overlay.querySelector('#git-confirm-close').addEventListener('click', () => done(false));
      if (!alertOnly) overlay.querySelector('#git-confirm-cancel').addEventListener('click', () => done(false));
      overlay.querySelector('#git-confirm-ok').addEventListener('click', () => done(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    });
  }

  async function showGitBranchPicker() {
    try {
      const result = await sendGitCommand('branch');
      const branches = Array.isArray(result.data?.branches) ? result.data.branches : [];
      const current = result.data?.current || '';
      gitState.branchEntries = branches;
      if (branches.length === 0) {
        appendError('未读取到任何 Git 分支');
        return;
      }
      showOptionPicker(
        '切换 Git 分支',
        branches.map((branch) => ({
          value: branch.name,
          label: branch.name,
          desc: branch.current ? '当前分支' : '点击后切换到该分支',
        })),
        current,
        async (value) => {
          if (value === current) {
            showToast(`当前已在 ${value}`);
            return;
          }
          const summary = gitState.status?.summary || {};
          const conflicted = summary.conflicted || 0;
          const dirty = (summary.staged || 0) + (summary.modified || 0) + (summary.untracked || 0);
          if (conflicted > 0) {
            await showGitConfirmModal({
              title: '存在冲突文件',
              message: `当前有 ${conflicted} 个冲突文件，请先解决冲突再切换分支。`,
              confirmLabel: '知道了',
              alertOnly: true,
            });
            return;
          }
          if (dirty > 0) {
            const lines = [];
            if (summary.staged) lines.push(`${summary.staged} 个已暂存`);
            if (summary.modified) lines.push(`${summary.modified} 个未暂存`);
            if (summary.untracked) lines.push(`${summary.untracked} 个未跟踪`);
            const confirmed = await showGitConfirmModal({
              title: '工作区有未提交改动',
              message: `切换到 ${value} 时，这些改动可能被一起带走或导致切换失败。`,
              detail: lines.join('、'),
              confirmLabel: '仍然切换',
              danger: true,
            });
            if (!confirmed) return;
          }
          try {
            await sendGitCommand('checkout', { branch: value });
            showToast(`已切换到 ${value}`);
            requestGitStatus({ silent: true });
          } catch (error) {
            appendError(error.message || '切换分支失败');
          }
        }
      );
    } catch (error) {
      appendError(error.message || '读取分支列表失败');
    }
  }

  async function promptCreateGitBranch() {
    return new Promise((resolve) => {
      const { overlay, close } = createOverlayPanel({
        overlayClass: 'modal-overlay',
        panelClass: 'modal-panel',
        maxWidth: '400px',
        panelHtml: `
          <div class="modal-header">
            <span class="modal-title">新建分支</span>
            <button class="modal-close-btn" id="git-branch-close">✕</button>
          </div>
          <div class="modal-body" style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">
            <label class="modal-field-label" for="git-branch-name">分支名称</label>
            <input id="git-branch-name" type="text" placeholder="例如：feat/my-feature" autocomplete="off" style="width:100%;padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--line);border-radius:2px;color:var(--text-primary);font-family:var(--font-mono);font-size:13px;box-sizing:border-box">
            <p style="margin:0;font-size:12px;color:var(--text-muted)">只创建分支，不会自动切换。</p>
            <div class="settings-status" id="git-branch-status"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button class="modal-btn-secondary" id="git-branch-cancel">取消</button>
              <button class="modal-btn-primary" id="git-branch-submit">创建分支</button>
            </div>
          </div>
        `,
      });
      const done = (val) => { close(); resolve(val); };
      const nameInput = overlay.querySelector('#git-branch-name');
      const statusEl = overlay.querySelector('#git-branch-status');
      const submitBtn = overlay.querySelector('#git-branch-submit');
      overlay.querySelector('#git-branch-close').addEventListener('click', () => done(null));
      overlay.querySelector('#git-branch-cancel').addEventListener('click', () => done(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      const doSubmit = async () => {
        const name = nameInput.value.trim();
        if (!name) {
          statusEl.textContent = '请输入分支名称';
          statusEl.className = 'settings-status error';
          nameInput.focus();
          return;
        }
        submitBtn.disabled = true;
        statusEl.textContent = '';
        try {
          await sendGitCommand('branch', { name });
          done(name);
          showToast(`已创建分支 ${name}`);
          requestGitStatus({ silent: true });
        } catch (error) {
          statusEl.textContent = error.message || '创建分支失败';
          statusEl.className = 'settings-status error';
          submitBtn.disabled = false;
        }
      };
      submitBtn.addEventListener('click', doSubmit);
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
      setTimeout(() => nameInput.focus(), 50);
    });
  }

  function buildWelcomeMarkup(agent) {
    const label = AGENT_LABELS[agent] || AGENT_LABELS.claude;
    const sessionCount = typeof getVisibleSessions === 'function' ? getVisibleSessions().length : 0;
    const projectCount = Array.isArray(projects) ? projects.length : 0;
    return `
      <div class="welcome-msg">
        <div class="welcome-header">
          <div class="welcome-icon">✦</div>
          <h3>${label} 工作区</h3>
        </div>
        <div class="welcome-stats">
          <div class="welcome-stat">
            <strong>${sessionCount}</strong>
            <span>会话数</span>
          </div>
          <div class="welcome-stat">
            <strong>${projectCount}</strong>
            <span>项目数</span>
          </div>
          <div class="welcome-stat">
            <strong>${MODE_LABELS[sessionState.currentMode] || sessionState.currentMode}</strong>
            <span>模式</span>
          </div>
        </div>
        <div class="welcome-actions">
          ${buildWorkspaceActionButtons([
            { action: 'new-session', label: '新建会话', primary: true },
            { action: 'import-session', label: '导入历史' },
            { action: 'switch-model', label: '切换模型' },
          ], { compact: true })}
        </div>
        <div class="welcome-panels">
          <section class="welcome-panel">
            <div class="welcome-panel-kicker">常用指令</div>
            <ul class="welcome-list">
              <li><code>/model</code> 查看或切换模型</li>
              <li><code>/mode</code> 切换权限模式</li>
              <li><code>/compact</code> 压缩上下文</li>
            </ul>
          </section>
          <section class="welcome-panel">
            <div class="welcome-panel-kicker">多模态协作</div>
            <ul class="welcome-list">
              <li>支持随消息附带图片，适合 UI、截图和报错定位。</li>
            </ul>
          </section>
        </div>
      </div>
    `;
  }

  function normalizeAgent(agent) {
    return AGENT_LABELS[agent] ? agent : DEFAULT_AGENT;
  }

  function getAgentSessionStorageKey(agent) {
    return `webcoding-session-${normalizeAgent(agent)}`;
  }

  function getAgentModeStorageKey(agent) {
    return `webcoding-mode-${normalizeAgent(agent)}`;
  }

  function getLastSessionForAgent(agent) {
    return localStorage.getItem(getAgentSessionStorageKey(agent));
  }

  function setLastSessionForAgent(agent, sessionId) {
    localStorage.setItem(getAgentSessionStorageKey(agent), sessionId);
    localStorage.setItem('webcoding-session', sessionId);
  }

  function getSessionMeta(sessionId) {
    return sessionState.sessions.find((s) => s.id === sessionId) || null;
  }

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  const wsEventListeners = new Map();
  let settingsPanelUnsubscribers = [];

  function onWsEvent(type, handler, options = {}) {
    if (!type || typeof handler !== 'function') return () => {};
    const listener = {
      fn: handler,
      once: !!options.once,
    };
    if (!wsEventListeners.has(type)) wsEventListeners.set(type, new Set());
    const bucket = wsEventListeners.get(type);
    bucket.add(listener);
    return () => {
      bucket.delete(listener);
      if (bucket.size === 0) wsEventListeners.delete(type);
    };
  }

  function emitWsEvent(type, payload) {
    const bucket = wsEventListeners.get(type);
    if (!bucket || bucket.size === 0) return;
    for (const listener of Array.from(bucket)) {
      try {
        listener.fn(payload);
      } catch (error) {
        console.error('[WEBCODING-WS-EVENT]', type, error);
      }
      if (listener.once) {
        bucket.delete(listener);
      }
    }
    if (bucket.size === 0) wsEventListeners.delete(type);
  }

  function clearWsEvent(type) {
    if (!type) return;
    wsEventListeners.delete(type);
  }

  function clearSettingsPanelSubscriptions() {
    for (const dispose of settingsPanelUnsubscribers) {
      try { dispose(); } catch {}
    }
    settingsPanelUnsubscribers = [];
  }

  function registerSettingsPanelHandler(type, handler, options = {}) {
    const dispose = onWsEvent(type, handler, options);
    settingsPanelUnsubscribers.push(dispose);
    return dispose;
  }

  function waitForWsEvent(type, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const predicate = typeof options.predicate === 'function' ? options.predicate : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        fn();
      };
      const off = onWsEvent(type, (payload) => {
        if (predicate && !predicate(payload)) return;
        done(() => resolve(payload));
      });
      const timer = setTimeout(() => {
        done(() => reject(new Error(`等待 ${type} 回包超时`)));
      }, timeoutMs);
    });
  }

  function cloneMessages(messages) {
    return Array.isArray(messages) ? deepClone(messages) : [];
  }

  function estimateSessionMessageWeight(message) {
    const content = typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content || '').length;
    const toolCalls = Array.isArray(message?.toolCalls) ? JSON.stringify(message.toolCalls).length : 0;
    const segments = Array.isArray(message?.segments) ? JSON.stringify(message.segments).length : 0;
    return content + toolCalls + segments + 64;
  }

  function estimateSessionSnapshotWeight(snapshot) {
    const base = JSON.stringify({
      title: snapshot.title || '',
      mode: snapshot.mode || '',
      model: snapshot.model || '',
      agent: snapshot.agent || '',
      activeRuntime: snapshot.activeRuntime || null,
      runtimeCount: snapshot.runtimeCount || 0,
      cwd: snapshot.cwd || '',
      updated: snapshot.updated || '',
    }).length;
    return base + (snapshot.messages || []).reduce((sum, message) => sum + estimateSessionMessageWeight(message), 0);
  }

  function normalizeActiveRuntime(runtime, fallbackAgent, fallbackModel = '') {
    if (!runtime || typeof runtime !== 'object') return null;
    const agent = normalizeAgent(runtime.agent || fallbackAgent);
    return {
      agent,
      channelKey: runtime.channelKey || null,
      channelLabel: runtime.channelLabel || null,
      mode: runtime.mode || null,
      model: runtime.model || '',
      displayModel: runtime.displayModel || runtime.model || fallbackModel || '',
      explicitModel: runtime.explicitModel || '',
      defaultModel: runtime.defaultModel || '',
      runtimeIdPresent: !!runtime.runtimeIdPresent,
      runtimeId: runtime.runtimeId || null,
      runtimeCount: Number.isFinite(runtime.runtimeCount) ? runtime.runtimeCount : 0,
    };
  }

  function normalizeSessionSnapshot(payload, options = {}) {
    const normalizedRuntime = normalizeActiveRuntime(payload.activeRuntime, payload.agent, payload.model || '');
    const hasPayloadModel = Object.prototype.hasOwnProperty.call(payload || {}, 'model');
    return {
      sessionId: payload.sessionId,
      messages: cloneMessages(payload.messages || []),
      title: payload.title || '新会话',
      mode: payload.mode || 'yolo',
      model: hasPayloadModel ? (payload.model || '') : (normalizedRuntime?.displayModel || ''),
      activeRuntime: normalizedRuntime,
      activeChannelKey: payload.activeChannelKey || normalizedRuntime?.channelKey || null,
      runtimeCount: Number.isFinite(payload.runtimeCount)
        ? payload.runtimeCount
        : (normalizedRuntime?.runtimeCount || 0),
      agent: normalizeAgent(payload.agent),
      hasUnread: !!payload.hasUnread,
      cwd: payload.cwd || null,
      projectId: payload.projectId || null,
      totalCost: typeof payload.totalCost === 'number' ? payload.totalCost : 0,
      totalUsage: payload.totalUsage ? deepClone(payload.totalUsage) : null,
      updated: payload.updated || null,
      isRunning: !!payload.isRunning,
      historyPending: !!payload.historyPending,
      complete: options.complete !== undefined ? !!options.complete : !payload.historyPending,
    };
  }

  function touchSessionCache(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (entry) entry.lastUsed = Date.now();
  }

  function invalidateSessionCache(sessionId) {
    if (!sessionId) return;
    sessionCache.delete(sessionId);
  }

  function pruneSessionCache() {
    let totalWeight = 0;
    for (const entry of sessionCache.values()) totalWeight += entry.weight || 0;
    while (sessionCache.size > SESSION_CACHE_LIMIT || totalWeight > SESSION_CACHE_MAX_WEIGHT) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [sessionId, entry] of sessionCache) {
        if ((entry.lastUsed || 0) < oldestTs) {
          oldestTs = entry.lastUsed || 0;
          oldestId = sessionId;
        }
      }
      if (!oldestId) break;
      totalWeight -= sessionCache.get(oldestId)?.weight || 0;
      sessionCache.delete(oldestId);
    }
  }

  function cacheSessionSnapshot(snapshot) {
    if (!snapshot?.sessionId || !snapshot.complete) return;
    const cachedSnapshot = deepClone(snapshot);
    const weight = estimateSessionSnapshotWeight(cachedSnapshot);
    if (weight > SESSION_CACHE_MAX_WEIGHT) {
      invalidateSessionCache(cachedSnapshot.sessionId);
      return;
    }
    const meta = getSessionMeta(cachedSnapshot.sessionId);
    sessionCache.set(cachedSnapshot.sessionId, {
      snapshot: cachedSnapshot,
      version: cachedSnapshot.updated || null,
      meta: meta ? deepClone(meta) : null,
      weight,
      lastUsed: Date.now(),
    });
    pruneSessionCache();
  }

  function updateCachedSession(sessionId, updater) {
    const entry = sessionCache.get(sessionId);
    if (!entry) return;
    const nextSnapshot = deepClone(entry.snapshot);
    updater(nextSnapshot);
    entry.snapshot = nextSnapshot;
    entry.weight = estimateSessionSnapshotWeight(nextSnapshot);
    entry.lastUsed = Date.now();
    if (nextSnapshot.updated) entry.version = nextSnapshot.updated;
    pruneSessionCache();
  }

  function reconcileSessionCacheWithSessions() {
    const knownIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, entry] of sessionState.sessionCache) {
      if (!knownIds.has(sessionId)) {
        sessionState.sessionCache.delete(sessionId);
        continue;
      }
      const meta = getSessionMeta(sessionId);
      entry.meta = meta ? deepClone(meta) : null;
    }
  }

  function getSessionCacheDisposition(sessionId) {
    const entry = sessionState.sessionCache.get(sessionId);
    const meta = getSessionMeta(sessionId);
    if (!entry?.snapshot?.complete || !meta) return 'miss';
    if (entry.version === (meta.updated || null) && !meta.hasUnread && !meta.isRunning) {
      return 'strong';
    }
    return 'weak';
  }

  function buildCachedSessionSnapshot(sessionId) {
    const entry = sessionState.sessionCache.get(sessionId);
    if (!entry?.snapshot) return null;
    const snapshot = deepClone(entry.snapshot);
    const meta = getSessionMeta(sessionId) || entry.meta;
    if (meta) {
      snapshot.title = meta.title || snapshot.title;
      snapshot.agent = normalizeAgent(meta.agent || snapshot.agent);
      snapshot.hasUnread = !!meta.hasUnread;
      snapshot.updated = meta.updated || snapshot.updated;
      snapshot.isRunning = !!meta.isRunning;
    }
    return snapshot;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  }

  function syncAttachmentActions() {
    const uploading = composeState.uploadingAttachments.length > 0;
    if (attachBtn) attachBtn.disabled = uploading;
  }

  function replaceFileExtension(filename, ext) {
    const base = String(filename || 'image').replace(/\.[^/.]+$/, '');
    return `${base}${ext}`;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('读取图片失败'));
      };
      img.src = url;
    });
  }

  async function compressImageFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) return file;
    const img = await loadImageFromFile(file);
    const maxDimension = 2000;
    const maxOriginalBytes = 2 * 1024 * 1024;
    const largestSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (file.size <= maxOriginalBytes && largestSide <= maxDimension) {
      return file;
    }

    const scale = Math.min(1, maxDimension / largestSide);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const targetType = 'image/webp';
    const qualities = [0.9, 0.84, 0.78, 0.72];
    let bestBlob = null;
    for (const quality of qualities) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetType, quality));
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= Math.max(maxOriginalBytes, file.size * 0.72)) break;
    }
    if (!bestBlob || bestBlob.size >= file.size) return file;
    return new File([bestBlob], replaceFileExtension(file.name || 'image', '.webp'), {
      type: bestBlob.type,
      lastModified: Date.now(),
    });
  }

  async function deleteUploadedAttachment(id) {
    if (!id) return;
    try {
      await ensureAuthenticatedWs();
      await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    } catch {}
  }

  function ensureAuthenticatedWs() {
    return new Promise((resolve, reject) => {
      if (connectionState.ws && connectionState.ws.readyState === WebSocket.OPEN && connectionState.authToken) {
        resolve(connectionState.authToken);
        return;
      }
      if (!connectionState.authToken) {
        reject(new Error('登录状态已失效，请重新登录后再上传图片。'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('登录状态恢复超时，请重新登录后重试。'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        document.removeEventListener('webcoding-auth-restored', onRestored);
        document.removeEventListener('webcoding-auth-failed', onFailed);
      };
      const onRestored = () => {
        cleanup();
        resolve(connectionState.authToken);
      };
      const onFailed = () => {
        cleanup();
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
      };
      document.addEventListener('webcoding-auth-restored', onRestored);
      document.addEventListener('webcoding-auth-failed', onFailed);

      if (!connectionState.ws || connectionState.ws.readyState > WebSocket.OPEN) {
        connect();
      } else if (connectionState.ws.readyState === WebSocket.OPEN) {
        send({ type: 'auth', token: connectionState.authToken });
      }
    });
  }

  function renderAttachmentLabels(attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const labels = attachments.map((attachment) => {
      const stateSuffix = attachment.storageState === 'expired' ? '（已过期）' : '';
      const name = escapeHtml(attachment.filename || 'image');
      return `<span class="msg-attachment-label">图片: ${name}${stateSuffix}</span>`;
    }).join('');
    return `<div class="msg-attachments${options.compact ? ' compact' : ''}">${labels}</div>`;
  }

  function renderPendingAttachments() {
    if (!attachmentTray) return;
    if (!composeState.pendingAttachments.length && !composeState.uploadingAttachments.length) {
      attachmentTray.hidden = true;
      attachmentTray.innerHTML = '';
      syncAttachmentActions();
      return;
    }
    attachmentTray.hidden = false;
    const uploadingHtml = composeState.uploadingAttachments.map((attachment) => `
      <div class="attachment-chip uploading">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">上传中 · ${formatFileSize(attachment.size)}</span>
        </div>
      </div>
    `).join('');
    const readyHtml = composeState.pendingAttachments.map((attachment, index) => `
      <div class="attachment-chip" data-index="${index}">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">${formatFileSize(attachment.size)} · 将随下一条消息发送</span>
        </div>
        <button class="attachment-chip-remove" type="button" data-index="${index}" title="移除">✕</button>
      </div>
    `).join('');
    const noteHtml = [
      composeState.uploadingAttachments.length > 0
        ? '<div class="attachment-tray-note">图片上传中，此时发送不会包含尚未完成的图片。</div>'
        : '',
    ].join('');
    attachmentTray.innerHTML = `${uploadingHtml}${readyHtml}${noteHtml}`;
    attachmentTray.querySelectorAll('.attachment-chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const [removed] = composeState.pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        deleteUploadedAttachment(removed?.id);
      });
    });
    syncAttachmentActions();
  }

  async function uploadImageFile(file) {
    await ensureAuthenticatedWs();
    const headers = {
      'Authorization': `Bearer ${connectionState.authToken}`,
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'image'),
    };
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers,
      body: file,
    });
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }
    if (response.status === 401) {
      throw new Error('登录状态已失效，请刷新页面后重新登录再上传图片。');
    }
    if (response.status === 413) {
      throw new Error('图片大小超过当前上传限制，请压缩到 10MB 以内后重试。');
    }
    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `上传失败 (${response.status})`);
    }
    return data.attachment;
  }

  async function handleSelectedImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) return;
    const totalAttachments = composeState.pendingAttachments.length + composeState.uploadingAttachments.length + files.length;
    if (totalAttachments > 4) {
      appendError('单条消息最多附带 4 张图片。');
      return;
    }
    const batch = files.map((file, index) => ({
      id: nextLocalId(`upload-${index}`),
      filename: file.name || 'image',
      size: file.size || 0,
    }));
    composeState.uploadingAttachments.push(...batch);
    renderPendingAttachments();
    try {
      const results = await Promise.allSettled(files.map(async (file) => {
        const optimized = await compressImageFile(file);
        return uploadImageFile(optimized);
      }));
      const errors = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          composeState.pendingAttachments.push(result.value);
        } else {
          errors.push(result.reason?.message || '图片上传失败');
        }
      }
      if (errors.length > 0) {
        appendError(errors[0]);
      }
    } catch (err) {
      appendError(err.message || '图片上传失败');
    } finally {
      composeState.uploadingAttachments = composeState.uploadingAttachments.filter((item) => !batch.some((entry) => entry.id === item.id));
      renderPendingAttachments();
      if (imageUploadInput) imageUploadInput.value = '';
    }
  }

  function getVisibleSessions() {
    return sessionState.sessions;
  }

  function shouldOverlayRuntimeBadge() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  function updateCwdBadge() {
    if (!chatCwd) return;
    if (sessionState.currentCwd) {
      const parts = sessionState.currentCwd.replace(/\/+$/, '').split('/');
      const short = parts.slice(-2).join('/') || sessionState.currentCwd;
      chatCwd.textContent = '~/' + short;
      chatCwd.title = sessionState.currentCwd;
    } else {
      chatCwd.textContent = '';
      chatCwd.title = '';
    }
    chatCwd.hidden = !sessionState.currentCwd || (sessionState.currentSessionRunning && shouldOverlayRuntimeBadge());
  }

  function setCurrentSessionRunningState(isRunning) {
    const running = !!isRunning;
    sessionState.currentSessionRunning = running;
    if (chatRuntimeState) {
      chatRuntimeState.hidden = !running;
      chatRuntimeState.textContent = running ? '运行中' : '';
    }
    updateCwdBadge();
    renderWorkspaceInsights();
  }

  function updateAgentScopedUI() {
    const selectedAgentLabel = AGENT_LABELS[selectedAgent] || selectedAgent;
    const currentAgentLabel = sessionState.currentSessionId ? (AGENT_LABELS[sessionState.currentAgent] || sessionState.currentAgent) : '未开始';
    // Sync agent tabs
    document.querySelectorAll('.agent-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.agent === selectedAgent);
    });
    // Sync mode tabs
    document.querySelectorAll('.mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === sessionState.currentMode);
    });
    // Sync mobile selects
    const mas = document.getElementById('mobile-agent-select');
    const mms = document.getElementById('mobile-mode-select');
    if (mas) mas.value = selectedAgent;
    if (mms) mms.value = sessionState.currentMode;
    if (importSessionBtn) {
      importSessionBtn.textContent = selectedAgent === 'codex' ? '导入本地 Codex 会话' : '导入本地 Claude 会话';
    }
    if (chatAgentContext) {
      chatAgentContext.textContent = `当前对话：${currentAgentLabel} · 新建默认：${selectedAgentLabel}`;
    }
  }

  function getSavedModeForAgent(agent) {
    return localStorage.getItem(getAgentModeStorageKey(agent)) || 'yolo';
  }

  function setSelectedAgent(agent, options = {}) {
    selectedAgent = normalizeAgent(agent);
    localStorage.setItem('webcoding-agent', selectedAgent);
    if (options.syncMode) {
      sessionState.currentMode = getSavedModeForAgent(selectedAgent);
      modeSelect.value = sessionState.currentMode;
    }
    updateAgentScopedUI();
  }

  function setCurrentAgent(agent) {
    sessionState.currentAgent = normalizeAgent(agent);
    updateAgentScopedUI();
  }

  function handleAgentSelectionChange(agent) {
    const targetAgent = normalizeAgent(agent);
    if (targetAgent === selectedAgent) return;
    const hadOpenSession = !!sessionState.currentSessionId;
    setSelectedAgent(targetAgent, { syncMode: !hadOpenSession });
    if (!hadOpenSession) {
      resetChatView(targetAgent);
      return;
    }
    renderSessionList();
    highlightActiveSession();
    renderWorkspaceInsights();
  }

  function restoreInitialSession(agent = selectedAgent) {
    const targetAgent = normalizeAgent(agent);
    setSelectedAgent(targetAgent, { syncMode: true });
    renderSessionList();

    const lastOpenedId = localStorage.getItem('webcoding-session');
    const lastOpenedMeta = lastOpenedId ? getSessionMeta(lastOpenedId) : null;
    if (lastOpenedMeta) {
      openSession(lastOpenedId);
      return;
    }

    const lastSessionId = getLastSessionForAgent(targetAgent);
    const lastMeta = lastSessionId ? getSessionMeta(lastSessionId) : null;
    if (lastMeta && normalizeAgent(lastMeta.agent) === targetAgent) {
      openSession(lastSessionId);
      return;
    }

    resetChatView(targetAgent);
  }

  function resetChatView(agent) {
    const baseAgent = normalizeAgent(agent || selectedAgent);
    setCurrentAgent(baseAgent);
    resetGitState();
    sessionState.currentSessionId = null;
    sessionState.loadedHistorySessionId = null;
    clearSessionLoading();
    setCurrentSessionRunningState(false);
    sessionState.currentCwd = null;
    sessionState.currentModel = '';
    sessionState.currentActiveRuntime = null;
    sessionState.currentRuntimeCount = 0;
    composeState.isGenerating = false;
    composeState.pendingText = '';
    composeState.pendingAttachments = [];
    composeState.uploadingAttachments = [];
    composeState.activeToolCalls.clear();
    _previewCodeMap.clear();
    _previewCodeId = 0;
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    sessionState.currentMode = getSavedModeForAgent(baseAgent);
    modeSelect.value = sessionState.currentMode;
    updateAgentScopedUI();
    chatTitle.textContent = '新会话';
    updateCwdBadge();
    messagesDiv.innerHTML = buildWelcomeMarkup(baseAgent);
    setStatsDisplay(null);
    renderPendingAttachments();
    highlightActiveSession();
    renderWorkspaceInsights();
  }

  function applySessionSnapshot(snapshot, options = {}) {
    if (!snapshot) return;
    const preserveStreaming = !!(options.preserveStreaming && composeState.isGenerating && snapshot.sessionId === sessionState.currentSessionId && snapshot.isRunning);
    if (composeState.isGenerating && !preserveStreaming) {
      composeState.isGenerating = false;
      sendBtn.hidden = false;
      abortBtn.hidden = true;
      composeState.pendingText = '';
      composeState.activeToolCalls.clear();
    }
    sessionState.currentSessionId = snapshot.sessionId;
    sessionState.loadedHistorySessionId = snapshot.sessionId;
    setLastSessionForAgent(snapshot.agent, sessionState.currentSessionId);
    chatTitle.textContent = snapshot.title || '新会话';
    setCurrentAgent(snapshot.agent);
    setCurrentSessionRunningState(snapshot.isRunning);
    setStatsDisplay(snapshot);
    const nextGitCwd = snapshot.cwd || null;
    const gitCwdChanged = gitState.cwd !== nextGitCwd;
    sessionState.currentCwd = nextGitCwd;
    if (gitCwdChanged) resetGitState(nextGitCwd ? { cwd: nextGitCwd } : {});
    updateCwdBadge();
    if (snapshot.mode && MODE_LABELS[snapshot.mode]) {
      sessionState.currentMode = snapshot.mode;
      modeSelect.value = sessionState.currentMode;
      localStorage.setItem(getAgentModeStorageKey(sessionState.currentAgent), sessionState.currentMode);
    }
    updateAgentScopedUI();
    sessionState.currentModel = snapshot.model || '';
    sessionState.currentActiveRuntime = snapshot.activeRuntime ? deepClone(snapshot.activeRuntime) : null;
    sessionState.currentRuntimeCount = Number.isFinite(snapshot.runtimeCount) ? snapshot.runtimeCount : 0;
    if (!preserveStreaming) {
      renderMessages(snapshot.messages || [], { immediate: !!options.immediate });
    }
    highlightActiveSession();
    renderSessionList();
    if (!options.skipCloseSidebar) closeSidebar();
    if (snapshot.hasUnread && !options.suppressUnreadToast) {
      showToast('后台任务已完成', snapshot.sessionId);
    }
    renderWorkspaceInsights();
    if (nextGitCwd && (gitCwdChanged || !gitState.status)) {
      requestGitStatus({ silent: true });
    }
  }

  function getSessionLoadLabel(sessionId) {
    const meta = sessionId ? getSessionMeta(sessionId) : null;
    const title = meta?.title ? `“${meta.title}”` : '所选会话';
    return `正在载入 ${title} 的完整消息记录…`;
  }

  function setSessionLoading(sessionId, options = {}) {
    const loading = !!sessionId;
    const blocking = options.blocking !== false;
    sessionState.activeSessionLoad = loading ? { sessionId, blocking, snapshot: null } : null;
    const showOverlay = !!(loading && blocking);
    document.body.classList.toggle('session-loading-active', showOverlay);
    sessionLoadingOverlay.hidden = !showOverlay;
    sessionLoadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');
    sessionLoadingLabel.textContent = loading ? (options.label || getSessionLoadLabel(sessionId)) : '正在整理消息与上下文…';
    msgInput.disabled = showOverlay;
    modeSelect.disabled = showOverlay;
    sendBtn.disabled = showOverlay;
    abortBtn.disabled = showOverlay;
    if (showOverlay && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function clearSessionLoading(sessionId) {
    if (sessionId && sessionState.activeSessionLoad && sessionState.activeSessionLoad.sessionId !== sessionId) return;
    setSessionLoading(null, { blocking: false });
  }

  function isBlockingSessionLoad(sessionId) {
    return !!(sessionState.activeSessionLoad &&
      sessionState.activeSessionLoad.blocking &&
      (!sessionId || sessionState.activeSessionLoad.sessionId === sessionId));
  }

  function finishSessionSwitch(sessionId) {
    if (isBlockingSessionLoad(sessionId)) {
      scrollToBottom();
      requestAnimationFrame(() => clearSessionLoading(sessionId));
      return;
    }
    clearSessionLoading(sessionId);
  }

  function finalizeLoadedSession(sessionId) {
    if (sessionState.activeSessionLoad?.sessionId === sessionId && sessionState.activeSessionLoad.snapshot) {
      sessionState.activeSessionLoad.snapshot.complete = true;
      cacheSessionSnapshot(sessionState.activeSessionLoad.snapshot);
    }
    finishSessionSwitch(sessionId);
  }

  function beginSessionSwitch(sessionId, options = {}) {
    if (!sessionId) return;
    const blocking = options.blocking !== false;
    const force = options.force === true;
    if (!force && sessionState.activeSessionLoad?.sessionId === sessionId) return;
    if (!force && sessionId === sessionState.currentSessionId && !sessionState.activeSessionLoad) return;
    renderEpoch++;
    sessionState.loadedHistorySessionId = null;
    setSessionLoading(sessionId, { blocking, label: options.label });
    send({ type: 'load_session', sessionId });
  }

  function showCachedSession(sessionId) {
    const snapshot = buildCachedSessionSnapshot(sessionId);
    if (!snapshot) return false;
    if (sessionState.currentSessionId && sessionState.currentSessionId !== sessionId) {
      send({ type: 'detach_view' });
    }
    clearSessionLoading();
    touchSessionCache(sessionId);
    applySessionSnapshot(snapshot, { immediate: true, suppressUnreadToast: true });
    return true;
  }

  function openSession(sessionId, options = {}) {
    if (!sessionId) return;
    if (options.forceSync) {
      beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: true, label: options.label });
      return;
    }
    if (!options.force && sessionId === sessionState.currentSessionId && !sessionState.activeSessionLoad) return;

    const disposition = getSessionCacheDisposition(sessionId);
    if (disposition === 'strong') {
      showCachedSession(sessionId);
      return;
    }
    if (disposition === 'weak' && showCachedSession(sessionId)) {
      beginSessionSwitch(sessionId, { blocking: false, force: true, label: options.label });
      return;
    }
    beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: options.force === true, label: options.label });
  }

  function setStatsDisplay(msg) {
    if (sessionState.currentAgent === 'codex' && msg && msg.totalUsage) {
      const usage = msg.totalUsage;
      if ((usage.inputTokens || 0) > 0 || (usage.outputTokens || 0) > 0) {
        const cacheText = usage.cachedInputTokens ? ` · cache ${usage.cachedInputTokens}` : '';
        costDisplay.textContent = `in ${usage.inputTokens} · out ${usage.outputTokens}${cacheText}`;
        return;
      }
    }
    if (msg && typeof msg.totalCost === 'number' && msg.totalCost > 0) {
      costDisplay.textContent = `$${msg.totalCost.toFixed(4)}`;
      return;
    }
    costDisplay.textContent = '';
  }

  function getCodexModelOptions() {
    const seen = new Set();
    const options = [];

    function addOption(value, label, desc) {
      const v = (value || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      options.push({ value: v, label: label || v, desc: desc || 'Codex 模型' });
    }

    addOption('default', '默认模型', '使用当前默认模型');
    addOption(sessionState.currentModel, sessionState.currentModel, '当前会话模型');
    sessionState.sessions
      .filter((s) => normalizeAgent(s.agent) === 'codex')
      .forEach((s) => addOption(s.model, s.model, s.id === sessionState.currentSessionId ? '当前会话已保存模型' : '其他 Codex 会话模型'));

    return options;
  }

  // --- marked config ---
  const PREVIEW_LANGS = new Set(['html', 'svg']);
  const RENDER_LANGS = new Set(['md', 'markdown', 'json', 'csv']);
  const _previewCodeMap = new Map();
  let _previewCodeId = 0;
  const PREVIEW_SRCDOC_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:; media-src data:; script-src 'none';">`;

  function sanitizePreviewMarkup(markup) {
    if (!markup) return '';
    let safe = String(markup);
    safe = safe.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    safe = safe.replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '');
    safe = safe.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gis, '');
    safe = safe.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
    safe = safe.replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, ' $1="#"');
    safe = safe.replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"');
    return safe;
  }

  function buildSafePreviewSrcdoc(markup) {
    return `${PREVIEW_SRCDOC_CSP}${sanitizePreviewMarkup(markup)}`;
  }

  function buildMarkdownSrcdoc(code) {
    let html;
    try { html = marked.parse(code); } catch { html = escapeHtml(code); }
    return `${PREVIEW_SRCDOC_CSP}<style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;padding:16px 20px;margin:0;color:#222;word-wrap:break-word}pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow-x:auto}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:0.9em}pre code{background:none;padding:0}img{max-width:100%}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f5f5f5}blockquote{border-left:3px solid #ccc;margin:0;padding-left:12px;color:#555}a{color:#0066cc}</style>${html}`;
  }

  function buildCsvSrcdoc(code) {
    const rows = code.trim().split('\n').map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    const header = rows[0] || [];
    const body = rows.slice(1);
    const th = header.map(c => `<th>${escapeHtml(c)}</th>`).join('');
    const tr = body.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
    return `${PREVIEW_SRCDOC_CSP}<style>body{margin:0;padding:12px;font-family:system-ui,sans-serif;font-size:13px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:5px 10px;text-align:left}th{background:#f5f5f5;font-weight:600}tr:nth-child(even){background:#fafafa}</style><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }

  const renderer = new marked.Renderer();
  renderer.html = function (html) {
    return escapeHtml(html || '');
  };
  renderer.link = function (href, title, text) {
    // Detect absolute local file paths (e.g. /Users/... or /home/...)
    const rawHref = String(href || '').trim();
    if (/^\/[A-Za-z]/.test(rawHref) && !rawHref.startsWith('//')) {
      return `<a href="#" class="local-file-link" data-path="${escapeHtml(rawHref)}" onclick="ccCopyFilePath(this);return false;" title="点击复制路径">${text || escapeHtml(rawHref)}</a>`;
    }
    // Detect relative local file paths with a known extension when cwd is available
    if (sessionState.currentCwd && /^[^/#?][^#?]*\.[a-zA-Z0-9]+$/.test(rawHref) && !/^https?:\/\//i.test(rawHref)) {
      const absPath = sessionState.currentCwd.replace(/\/$/, '') + '/' + rawHref;
      return `<a href="#" class="local-file-link" data-path="${escapeHtml(absPath)}" onclick="ccCopyFilePath(this);return false;" title="点击复制路径">${text || escapeHtml(rawHref)}</a>`;
    }
    const safeHref = normalizeSafeHref(href, { externalOnly: false, allowRelative: true });
    if (!safeHref) return text || '';
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
    const isExternal = /^https?:\/\//i.test(safeHref);
    const externalAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(safeHref)}"${safeTitle}${externalAttrs}>${text || ''}</a>`;
  };
  renderer.image = function (href, title, text) {
    const safeHref = normalizeSafeHref(href, { externalOnly: false, allowRelative: false, allowDataImage: true });
    if (!safeHref) return '';
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text || '')}"${safeTitle}>`;
  };
  renderer.code = function (code, language) {
    const lang = (language || 'plaintext').toLowerCase();
    let highlighted;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch {
      highlighted = escapeHtml(code);
    }
    const canPreview = PREVIEW_LANGS.has(lang);
    const canRender = RENDER_LANGS.has(lang);
    const hasAction = canPreview || canRender;
    const btnLabel = canRender ? 'View' : 'Preview';
    const renderType = canPreview ? 'html' : ((['md','markdown'].includes(lang)) ? 'md' : lang);
    const actionBtn = hasAction
      ? `<button class="code-preview-btn" onclick="ccTogglePreview(this)">${btnLabel}</button>`
      : '';
    const previewPane = canPreview
      ? `<div class="code-preview-pane"><iframe class="code-preview-iframe" sandbox="allow-same-origin" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`
      : canRender
        ? `<div class="code-preview-pane code-render-pane" data-rtype="${escapeHtml(renderType)}"></div>`
        : '';
    const cid = hasAction ? (++_previewCodeId) : 0;
    if (hasAction) _previewCodeMap.set(cid, code);
    return `<div class="code-block-wrapper${hasAction ? ' has-preview' : ''}"${hasAction ? ` data-cid="${cid}"` : ''}>
      <div class="code-block-header">
        <span>${escapeHtml(lang)}</span>
        <div class="code-block-actions">${actionBtn}<button class="code-copy-btn" onclick="ccCopyCode(this)">Copy</button></div>
      </div>
      ${previewPane}<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
    </div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  window.ccCopyCode = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
    const code = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : wrapper.querySelector('code').textContent;
    const fallbackCopy = (text) => {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
      } catch {
        return false;
      }
    };
    const onCopied = () => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    };
    const onFailed = () => {
      showToast('复制失败，请手动复制代码');
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(code).then(onCopied).catch(() => {
        if (fallbackCopy(code)) onCopied();
        else onFailed();
      });
      return;
    }
    if (fallbackCopy(code)) onCopied();
    else onFailed();
  };

  window.ccTogglePreview = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const inPreview = wrapper.classList.contains('preview-mode');
    if (inPreview) {
      wrapper.classList.remove('preview-mode');
      // restore original button label based on pane type
      const renderPane = wrapper.querySelector('.code-render-pane');
      btn.textContent = renderPane ? 'View' : 'Preview';
    } else {
      const iframe = wrapper.querySelector('.code-preview-iframe');
      const renderPane = wrapper.querySelector('.code-render-pane');
      const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
      const rawCode = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : '';
      if (iframe && !iframe.dataset.loaded) {
        iframe.srcdoc = buildSafePreviewSrcdoc(rawCode);
        iframe.dataset.loaded = '1';
      } else if (renderPane && !renderPane.dataset.loaded) {
        const rtype = renderPane.dataset.rtype || '';
        if (rtype === 'md' || rtype === 'markdown') {
          const iframe2 = document.createElement('iframe');
          iframe2.className = 'code-preview-iframe';
          iframe2.setAttribute('sandbox', 'allow-same-origin');
          iframe2.setAttribute('referrerpolicy', 'no-referrer');
          iframe2.srcdoc = buildMarkdownSrcdoc(rawCode);
          renderPane.appendChild(iframe2);
        } else if (rtype === 'csv') {
          const iframe2 = document.createElement('iframe');
          iframe2.className = 'code-preview-iframe';
          iframe2.setAttribute('sandbox', 'allow-same-origin');
          iframe2.setAttribute('referrerpolicy', 'no-referrer');
          iframe2.srcdoc = buildCsvSrcdoc(rawCode);
          renderPane.appendChild(iframe2);
        } else if (rtype === 'json') {
          const pre = document.createElement('pre');
          pre.className = 'json-render-pre';
          pre.textContent = (() => { try { return JSON.stringify(JSON.parse(rawCode), null, 2); } catch { return rawCode; } })();
          renderPane.appendChild(pre);
        }
        renderPane.dataset.loaded = '1';
      }
      wrapper.classList.add('preview-mode');
      btn.textContent = 'Source';
    }
  };

  window.ccCopyFilePath = function (el) {
    const filePath = el.dataset.path || '';
    if (!filePath) return;
    const copy = (text) => {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(() => showToast('路径已复制')).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); document.execCommand('copy');
          document.body.removeChild(ta); showToast('路径已复制');
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); showToast('路径已复制');
      }
    };
    copy(filePath);
  };

  // --- WebSocket ---
  function connect() {
    if (connectionState.ws && (connectionState.ws.readyState === WebSocket.CONNECTING || connectionState.ws.readyState === WebSocket.OPEN)) return;
    connectionState.ws = new WebSocket(WS_URL);

    connectionState.ws.onopen = () => {
      connectionState.reconnectAttempts = 0;
      // Show reconnection success toast if this was a reconnect
      if (connectionState.reconnectAttempts === 0 && document.body.classList.contains('ws-reconnecting')) {
        document.body.classList.remove('ws-reconnecting');
        showToast('连接已恢复');
      }
      if (connectionState.authToken) send({ type: 'auth', token: connectionState.authToken });
    };

    connectionState.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    connectionState.ws.onclose = () => {
      clearSessionLoading();
      scheduleReconnect();
    };
    connectionState.ws.onerror = () => {
      // Show connection error indicator
      if (connectionState.reconnectAttempts === 0) {
        document.body.classList.add('ws-reconnecting');
      }
    };
  }

  function send(data) {
    if (connectionState.ws && connectionState.ws.readyState === WebSocket.OPEN) {
      connectionState.ws.send(JSON.stringify(data));
    } else {
      // Warn user if trying to send while disconnected
      showToast('连接已断开，正在重连…');
    }
  }

  function scheduleReconnect() {
    if (connectionState.reconnectTimer) return;
    if (connectionState.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      // Max reconnect attempts reached - show persistent error
      appendError('连接已断开且重连失败，请刷新页面重试。', { type: 'connection', dismissible: false });
      return;
    }
    if (navigator.onLine === false) {
      // Offline - wait for online event
      showToast('网络已断开，等待恢复…');
      return;
    }
    
    document.body.classList.add('ws-reconnecting');
    
    const delay = Math.min(1000 * Math.pow(2, connectionState.reconnectAttempts), 30000);
    connectionState.reconnectAttempts++;
    
    // Show reconnection attempt toast every few attempts
    if (connectionState.reconnectAttempts <= 3 || connectionState.reconnectAttempts % 3 === 0) {
      showToast(`正在重连 (${connectionState.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})…`);
    }
    
    connectionState.reconnectTimer = setTimeout(() => {
      connectionState.reconnectTimer = null;
      connect();
    }, delay);
  }

  // --- Server Message Handler ---
  function handleAuthResultMessage(msg) {
    if (msg.success) {
      if (pendingAuthPassword !== null) {
        if (rememberPw?.checked) saveRememberedPassword(pendingAuthPassword);
        else clearRememberedPassword();
        pendingAuthPassword = null;
      }
      connectionState.authToken = msg.token;
      localStorage.setItem('webcoding-token', msg.token);
      document.dispatchEvent(new CustomEvent('webcoding-auth-restored'));
      loginOverlay.hidden = true;
      app.hidden = false;
      send({ type: 'get_codex_config' });
      send({ type: 'get_projects' });
      if (msg.mustChangePassword) {
        showForceChangePassword();
      } else {
        connectionState.pendingInitialSessionLoad = true;
      }
      return;
    }
    const attemptedPassword = pendingAuthPassword;
    pendingAuthPassword = null;
    connectionState.authToken = null;
    localStorage.removeItem('webcoding-token');
    document.dispatchEvent(new CustomEvent('webcoding-auth-failed'));
    loginOverlay.hidden = false;
    app.hidden = true;
    if (attemptedPassword === null) restoreRememberedPasswordInput();
    loginError.hidden = false;
  }

  function handleSessionListMessage(msg) {
    sessionState.sessions = msg.sessions || [];
    reconcileSessionCacheWithSessions();
    renderSessionList();
    if (sessionState.currentSessionId) {
      setCurrentSessionRunningState(!!getSessionMeta(sessionState.currentSessionId)?.isRunning);
    }
    if (connectionState.pendingInitialSessionLoad) {
      connectionState.pendingInitialSessionLoad = false;
      restoreInitialSession(selectedAgent);
    } else if (sessionState.currentSessionId && !getSessionMeta(sessionState.currentSessionId)) {
      resetChatView(selectedAgent);
    }
  }

  function handleSessionInfoMessage(msg) {
    const snapshot = normalizeSessionSnapshot(msg);
    
    // Guard against stale responses from previous session loads
    // Only apply if this is the expected session or if no load is in progress
    const expectedSessionId = sessionState.activeSessionLoad?.sessionId;
    const isExpectedResponse = !expectedSessionId || expectedSessionId === msg.sessionId;
    
    // If we're waiting for a different session, ignore this stale response
    if (!isExpectedResponse && sessionState.activeSessionLoad?.blocking) {
      return;
    }
    
    if (sessionState.activeSessionLoad?.sessionId === msg.sessionId) {
      sessionState.activeSessionLoad.snapshot = snapshot;
    }
    applySessionSnapshot(snapshot, {
      immediate: isBlockingSessionLoad(msg.sessionId),
      suppressUnreadToast: false,
      preserveStreaming: msg.sessionId === sessionState.currentSessionId && msg.isRunning,
    });
    if (msg.historyPending) return;
    if (sessionState.activeSessionLoad?.sessionId === msg.sessionId) {
      finalizeLoadedSession(msg.sessionId);
      return;
    }
    cacheSessionSnapshot(snapshot);
    finishSessionSwitch(msg.sessionId);
  }

  function handleSessionHistoryChunkMessage(msg) {
    // Guard against stale history chunks from different sessions
    if (msg.sessionId !== sessionState.currentSessionId) return;
    if (sessionState.loadedHistorySessionId !== msg.sessionId) return;
    
    // Additional guard: ignore if we're loading a different session
    const activeLoadId = sessionState.activeSessionLoad?.sessionId;
    if (activeLoadId && activeLoadId !== msg.sessionId) return;
    
    const blocking = isBlockingSessionLoad(msg.sessionId);
    if (sessionState.activeSessionLoad?.sessionId === msg.sessionId && sessionState.activeSessionLoad.snapshot) {
      sessionState.activeSessionLoad.snapshot.messages = cloneMessages(msg.messages || []).concat(sessionState.activeSessionLoad.snapshot.messages);
    }
    prependHistoryMessages(msg.messages || [], {
      preserveScroll: !blocking,
      skipScrollbar: blocking,
    });
    if (!msg.remaining) {
      finalizeLoadedSession(msg.sessionId);
    }
  }

  function handleSessionRenamedMessage(msg) {
    sessionState.sessions = sessionState.sessions.map((session) => session.id === msg.sessionId ? { ...session, title: msg.title } : session);
    updateCachedSession(msg.sessionId, (snapshot) => { snapshot.title = msg.title; });
    if (msg.sessionId === sessionState.currentSessionId) {
      chatTitle.textContent = msg.title;
    }
    renderSessionList();
  }

  function handleTextDeltaMessage(msg) {
    if (!composeState.isGenerating) startGenerating();
    composeState.pendingText += msg.text;
    scheduleRender();
  }

  function handleToolStartMessage(msg) {
    if (!composeState.isGenerating) startGenerating();
    if (composeState.pendingText) flushRender();
    markStreamingProcessTextSegments();
    composeState.activeToolCalls.set(msg.toolUseId, { name: msg.name, input: msg.input, kind: msg.kind || null, meta: msg.meta || null, done: false });
    appendToolCall(msg.toolUseId, msg.name, msg.input, false, msg.kind || null, msg.meta || null);
  }

  function handleToolEndMessage(msg) {
    if (composeState.activeToolCalls.has(msg.toolUseId)) {
      composeState.activeToolCalls.get(msg.toolUseId).done = true;
      if (msg.kind) composeState.activeToolCalls.get(msg.toolUseId).kind = msg.kind;
      if (msg.meta) composeState.activeToolCalls.get(msg.toolUseId).meta = msg.meta;
      composeState.activeToolCalls.get(msg.toolUseId).result = msg.result;
    }
    updateToolCall(msg.toolUseId, msg.result);
  }

  function handleCostMessage(msg) {
    costDisplay.textContent = `$${msg.costUsd.toFixed(4)}`;
    if (sessionState.currentSessionId) {
      updateCachedSession(sessionState.currentSessionId, (snapshot) => { snapshot.totalCost = msg.costUsd; });
    }
    renderWorkspaceInsights();
  }

  function handleUsageMessage(msg) {
    if (msg.totalUsage) {
      const cacheText = msg.totalUsage.cachedInputTokens ? ` · cache ${msg.totalUsage.cachedInputTokens}` : '';
      costDisplay.textContent = `in ${msg.totalUsage.inputTokens} · out ${msg.totalUsage.outputTokens}${cacheText}`;
      if (sessionState.currentSessionId) {
        updateCachedSession(sessionState.currentSessionId, (snapshot) => { snapshot.totalUsage = deepClone(msg.totalUsage); });
      }
    }
    renderWorkspaceInsights();
  }

  function handleModeChangedMessage(msg) {
    if (!msg.mode || !MODE_LABELS[msg.mode]) return;
    sessionState.currentMode = msg.mode;
    modeSelect.value = sessionState.currentMode;
    localStorage.setItem(getAgentModeStorageKey(sessionState.currentAgent), sessionState.currentMode);
    updateAgentScopedUI();
    if (sessionState.currentSessionId) {
      updateCachedSession(sessionState.currentSessionId, (snapshot) => { snapshot.mode = msg.mode; });
    }
    renderWorkspaceInsights();
  }

  function handleModelChangedMessage(msg) {
    if (msg.model === undefined) return;
    const normalizedRuntime = normalizeActiveRuntime(msg.activeRuntime, sessionState.currentAgent, msg.model || '');
    sessionState.currentModel = msg.model || '';
    sessionState.currentActiveRuntime = normalizedRuntime;
    sessionState.currentRuntimeCount = Number.isFinite(msg.runtimeCount)
      ? msg.runtimeCount
      : (normalizedRuntime?.runtimeCount || 0);
    if (sessionState.currentSessionId) {
      updateCachedSession(sessionState.currentSessionId, (snapshot) => {
        snapshot.model = msg.model || '';
        snapshot.activeRuntime = normalizedRuntime ? deepClone(normalizedRuntime) : null;
        snapshot.activeChannelKey = msg.activeChannelKey || normalizedRuntime?.channelKey || null;
        snapshot.runtimeCount = Number.isFinite(msg.runtimeCount)
          ? msg.runtimeCount
          : (normalizedRuntime?.runtimeCount || 0);
      });
    }
    renderWorkspaceInsights();
  }

  function handleModelListMessage(msg) {
    if ((msg.agent || sessionState.currentAgent) === 'codex') {
      const options = Array.isArray(msg.entries) && msg.entries.length > 0 ? msg.entries : getCodexModelOptions();
      const activeValue = msg.currentFull || sessionState.currentModel || 'default';
      showOptionPicker('选择 Codex 模型', options, activeValue, (value) => {
        send({ type: 'message', text: `/model ${value}`, sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: 'codex' });
      });
      return;
    }
    if (msg.models) {
      showClaudeModelPicker(msg.entries, msg.models, msg.current, msg.currentFull);
    }
  }

  function handleResumeGeneratingMessage(msg) {
    setCurrentSessionRunningState(true);
    if (!composeState.isGenerating || !document.getElementById('streaming-msg')) {
      startGenerating();
    } else {
      sendBtn.hidden = true;
      abortBtn.hidden = false;
      composeState.activeToolCalls.clear();
      const bubble = document.querySelector('#streaming-msg .msg-bubble');
      if (bubble) bubble.innerHTML = '';
    }
    const resumedSegments = Array.isArray(msg.segments) && msg.segments.length > 0 ? msg.segments : null;
    if (resumedSegments) {
      renderStreamingSegments(resumedSegments);
      for (const segment of resumedSegments) {
        if (segment?.type !== 'tool_call' || !segment.id) continue;
        composeState.activeToolCalls.set(segment.id, {
          name: segment.name,
          input: segment.input,
          result: segment.result,
          kind: segment.kind || null,
          meta: segment.meta || null,
          done: segment.done !== false,
        });
      }
      composeState.pendingText = '';
      return;
    }
    composeState.pendingText = msg.text || '';
    flushRender();
    if (!(msg.toolCalls && msg.toolCalls.length > 0)) return;
    for (const tc of msg.toolCalls) {
      composeState.activeToolCalls.set(tc.id, {
        name: tc.name,
        input: tc.input,
        result: tc.result,
        kind: tc.kind || null,
        meta: tc.meta || null,
        done: tc.done,
      });
      appendToolCall(tc.id, tc.name, tc.input, tc.done, tc.kind || null, tc.meta || null);
      if (tc.done && tc.result) {
        updateToolCall(tc.id, tc.result);
      }
    }
  }

  function handleErrorMessage(msg) {
    const errorMsg = msg.message || '发生未知错误';
    appendError(errorMsg);
    // Also show toast for critical errors to ensure user notice
    if (msg.critical || msg.fatal) {
      showToast(`错误: ${errorMsg}`, null);
    }
    clearSessionLoading();
    if (!composeState.isGenerating && sessionState.currentSessionId) {
      setCurrentSessionRunningState(!!getSessionMeta(sessionState.currentSessionId)?.isRunning);
    }
    if (composeState.isGenerating) finishGenerating();
  }

  function handleBackgroundDoneMessage(msg) {
    showToast(`「${msg.title}」任务完成`, msg.sessionId);
    showBrowserNotification(msg.title);
    if (msg.sessionId === sessionState.currentSessionId) {
      openSession(msg.sessionId, { forceSync: true, blocking: false });
    } else {
      send({ type: 'list_sessions' });
    }
  }

  function handleModelConfigMessage(msg) {
    modelConfigCache = msg.config || null;
    emitWsEvent('model_config', msg.config);
  }

  function handleCodexConfigMessage(msg) {
    codexConfigCache = msg.config || null;
    emitWsEvent('codex_config', msg.config);
  }

  function handleProjectsConfigMessage(msg) {
    projects = msg.projects || [];
    renderSessionList();
    if (pendingProjectSaveCallback) {
      const cb = pendingProjectSaveCallback;
      pendingProjectSaveCallback = null;
      cb(projects);
    }
  }

  function handleGitResultMessage(msg) {
    const responseCwd = msg?.data?.cwd || msg?.cwd || null;
    const staleForCurrentView = !!(responseCwd && sessionState.currentCwd && responseCwd !== sessionState.currentCwd);

    if (!staleForCurrentView) {
      gitState.loading = false;
      if (msg.success) {
        gitState.lastError = '';
        if (msg.action === 'status') {
          const nextRepoRoot = msg.data?.repoRoot || null;
          const prevRepoRoot = gitState.status?.repoRoot || gitState.cwd || null;
          gitState.cwd = responseCwd || sessionState.currentCwd || null;
          gitState.status = msg.data || null;
          gitState.filesExpanded = false;
          if (nextRepoRoot !== prevRepoRoot) {
            gitState.collapsedTreeNodes = [];
          }
        } else if (msg.action === 'log') {
          gitState.logEntries = Array.isArray(msg.data?.entries) ? msg.data.entries : [];
        } else if (msg.action === 'branch' && Array.isArray(msg.data?.branches)) {
          gitState.branchEntries = msg.data.branches;
        }
      } else {
        gitState.lastError = msg.error || 'Git 操作失败';
        if (msg.action === 'status') gitState.status = null;
      }
      renderWorkspaceInsights();
      if (msg.action === 'status') {
        updateGitPanelBadge();
        if (gitState.panelOpen) renderGitPanel();
      }
    }

    emitWsEvent('git_result', msg);
  }

  const SERVER_MESSAGE_HANDLERS = Object.freeze({
    auth_result: handleAuthResultMessage,
    session_list: handleSessionListMessage,
    session_info: handleSessionInfoMessage,
    session_history_chunk: handleSessionHistoryChunkMessage,
    session_renamed: handleSessionRenamedMessage,
    text_delta: handleTextDeltaMessage,
    tool_start: handleToolStartMessage,
    tool_end: handleToolEndMessage,
    cost: handleCostMessage,
    usage: handleUsageMessage,
    done: (msg) => finishGenerating(msg.sessionId),
    system_message: (msg) => appendSystemMessage(msg.message),
    mode_changed: handleModeChangedMessage,
    model_changed: handleModelChangedMessage,
    model_list: handleModelListMessage,
    resume_generating: handleResumeGeneratingMessage,
    error: handleErrorMessage,
    notify_config: (msg) => {
      emitWsEvent('notify_config', msg.config);
    },
    notify_test_result: (msg) => {
      emitWsEvent('notify_test_result', msg);
    },
    tunnel_status: (msg) => {
      emitWsEvent('tunnel_status', msg);
    },
    tunnel_install_progress: (msg) => {
      emitWsEvent('tunnel_install_progress', msg);
    },
    model_config: handleModelConfigMessage,
    codex_config: handleCodexConfigMessage,
    fetch_models_result: (msg) => {
      emitWsEvent('fetch_models_result', msg);
    },
    background_done: handleBackgroundDoneMessage,
    password_changed: handlePasswordChanged,
    force_logout: handleForcedLogout,
    native_sessions: (msg) => { if (typeof _onNativeSessions === 'function') _onNativeSessions(msg.groups || []); },
    codex_sessions: (msg) => { if (typeof _onCodexSessions === 'function') _onCodexSessions(msg.sessions || []); },
    cwd_suggestions: (msg) => { if (typeof _onCwdSuggestions === 'function') _onCwdSuggestions(msg.paths || []); },
    directory_listing: (msg) => { if (typeof _onDirectoryListing === 'function') _onDirectoryListing(msg); },
    update_info: (msg) => { if (typeof window._ccOnUpdateInfo === 'function') window._ccOnUpdateInfo(msg); },
    git_result: handleGitResultMessage,
    projects_config: handleProjectsConfigMessage,
  });

  function handleServerMessage(msg) {
    const handler = SERVER_MESSAGE_HANDLERS[msg?.type];
    if (typeof handler === 'function') handler(msg);
  }

  // --- Generating State ---
  function startGenerating() {
    composeState.isGenerating = true;
    setCurrentSessionRunningState(true);
    composeState.pendingText = '';
    composeState.activeToolCalls.clear();
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    // 不禁用输入框，允许用户继续输入（但无法发送）

    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgEl = createMsgElement('assistant', '');
    msgEl.id = 'streaming-msg';
    const bubble = msgEl.querySelector('.msg-bubble');
    bubble.innerHTML = '';
    bubble.appendChild(createStreamingPlaceholder());
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
  }

  function finishGenerating(sessionId) {
    composeState.isGenerating = false;
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    setCurrentSessionRunningState(false);
    msgInput.focus();

    if (composeState.pendingText) flushRender();

    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) streamEl.removeAttribute('id');

    if (sessionId && (!sessionState.currentSessionId || sessionState.currentSessionId === sessionId)) {
      sessionState.currentSessionId = sessionId;
    }
    composeState.pendingText = '';
    composeState.activeToolCalls.clear();
  }

  // --- Rendering ---
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushRender();
    }, RENDER_DEBOUNCE);
  }

  function flushRender() {
    if (!composeState.pendingText) return;
    const textDiv = ensureStreamingTextSegment();
    if (!textDiv) return;
    const nextText = `${textDiv.dataset.rawText || ''}${composeState.pendingText}`;
    textDiv.dataset.rawText = nextText;
    textDiv.innerHTML = renderMarkdown(nextText);
    composeState.pendingText = '';
    scrollToBottom();
  }

  function renderMarkdown(text) {
    if (!text) return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    try { return marked.parse(text); }
    catch { return escapeHtml(text); }
  }

  function createStreamingPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'msg-segment msg-segment-pending';
    placeholder.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    return placeholder;
  }

  function createTextSegmentElement(text = '', options = {}) {
    const phase = options.phase === 'process' ? 'process' : 'final';
    const textDiv = document.createElement('div');
    textDiv.className = `msg-text msg-segment msg-segment-text msg-segment-${phase}`;
    textDiv.dataset.phase = phase;
    textDiv.dataset.rawText = text;
    textDiv.innerHTML = text ? renderMarkdown(text) : '';
    return textDiv;
  }

  function appendMessageAttachments(bubble, attachments = []) {
    if (!bubble || !Array.isArray(attachments) || attachments.length === 0) return;
    bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
  }

  function getStreamingBubble() {
    return document.querySelector('#streaming-msg .msg-bubble');
  }

  function clearStreamingPlaceholder(bubble) {
    const placeholder = bubble?.querySelector('.msg-segment-pending');
    if (placeholder) placeholder.remove();
  }

  function ensureStreamingTextSegment() {
    const bubble = getStreamingBubble();
    if (!bubble) return null;
    clearStreamingPlaceholder(bubble);
    const last = bubble.lastElementChild;
    if (last && last.classList.contains('msg-segment-text')) return last;
    const textDiv = createTextSegmentElement('', { phase: 'final' });
    bubble.appendChild(textDiv);
    return textDiv;
  }

  function createMsgElement(role, content, attachments = []) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;

    if (role === 'system') {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = content;
      div.appendChild(bubble);
      return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? 'U' : (sessionState.currentAgent === 'codex' ? 'O' : 'C');

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      if (content) {
        const textNode = document.createElement('div');
        textNode.className = 'msg-text';
        textNode.style.whiteSpace = 'pre-wrap';
        textNode.textContent = content;
        bubble.appendChild(textNode);
      }
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    } else {
      bubble.innerHTML = content ? renderMarkdown(content) : '';
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    return div;
  }

  let renderEpoch = 0;

  function toolKind(tool) {
    return tool?.kind || tool?.meta?.kind || '';
  }

  function toolTitle(tool) {
    if (tool?.meta?.title) return tool.meta.title;
    return tool?.name || 'Tool';
  }

  function toolSubtitle(tool) {
    if (tool?.meta?.subtitle) return tool.meta.subtitle;
    if (toolKind(tool) === 'command_execution') {
      return tool?.input?.command || '';
    }
    return '';
  }

  function stringifyToolValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolStateLabel(tool, done) {
    if (!done) return 'Running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number') {
      return `Exit ${tool.meta.exitCode}`;
    }
    return 'Done';
  }

  function toolStateClass(tool, done) {
    if (!done) return 'running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number' && tool.meta.exitCode !== 0) {
      return 'error';
    }
    return 'done';
  }

  function applyToolSummary(summary, tool, done) {
    summary.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = `tool-call-icon ${done ? 'done' : 'running'}`;

    const main = document.createElement('span');
    main.className = 'tool-call-summary-main';
    const label = document.createElement('span');
    label.className = 'tool-call-label';
    label.textContent = toolTitle(tool);
    main.appendChild(label);

    const subtitleText = toolSubtitle(tool);
    if (subtitleText) {
      const subtitle = document.createElement('span');
      subtitle.className = 'tool-call-subtitle';
      subtitle.textContent = subtitleText;
      main.appendChild(subtitle);
    }

    const state = document.createElement('span');
    state.className = `tool-call-state ${toolStateClass(tool, done)}`;
    state.textContent = toolStateLabel(tool, done);

    summary.appendChild(icon);
    summary.appendChild(main);
    summary.appendChild(state);
  }

  function buildStructuredToolSection(labelText, bodyText) {
    const section = document.createElement('div');
    section.className = 'tool-call-section';
    const label = document.createElement('div');
    label.className = 'tool-call-section-label';
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = 'tool-call-code';
    pre.textContent = bodyText;
    section.appendChild(label);
    section.appendChild(pre);
    return section;
  }

  function annotateMessageSegmentPhases(segments) {
    const list = Array.isArray(segments) ? segments.map((segment) => ({ ...segment })) : [];
    let finalTextIndex = -1;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const segment = list[index];
      if (segment?.type === 'text' && String(segment.text || '').trim()) {
        finalTextIndex = index;
        break;
      }
    }
    const conclusionTextIndex = finalTextIndex !== -1
      && !list.slice(finalTextIndex + 1).some((segment) => segment && segment.type !== 'text')
      ? finalTextIndex
      : -1;
    return list.map((segment, index) => {
      if (!segment || segment.type !== 'text') return segment;
      return {
        ...segment,
        phase: conclusionTextIndex !== -1 && index === conclusionTextIndex ? 'final' : 'process',
      };
    });
  }

  function normalizeSegmentsForDisplay(segments) {
    const normalized = (Array.isArray(segments) ? segments : [])
      .filter(Boolean)
      .map((segment) => {
        if (segment.type === 'tool_call') {
          return {
            ...segment,
            type: 'tool_call',
            done: segment.done !== false,
          };
        }
        return {
          type: 'text',
          text: typeof segment.text === 'string' ? segment.text : '',
        };
      })
      .filter((segment) => segment.type === 'tool_call' || segment.text);
    return annotateMessageSegmentPhases(collapseToolSegmentsForDisplay(normalized));
  }

  function normalizeMessageSegments(message) {
    if (Array.isArray(message?.segments) && message.segments.length > 0) {
      return normalizeSegmentsForDisplay(message.segments);
    }

    const fallback = [];
    if (typeof message?.content === 'string' && message.content) {
      fallback.push({ type: 'text', text: message.content });
    }
    if (Array.isArray(message?.toolCalls)) {
      message.toolCalls.forEach((tool) => {
        if (!tool) return;
        fallback.push({ type: 'tool_call', ...tool, done: tool.done !== false });
      });
    }
    return normalizeSegmentsForDisplay(fallback);
  }

  function collapseToolSegmentsForDisplay(segments) {
    const source = Array.isArray(segments) ? segments.filter(Boolean) : [];
    const collapsed = [];
    let toolRun = [];

    function flushToolRun() {
      if (toolRun.length === 0) return;
      if (toolRun.length >= TOOL_GROUP_THRESHOLD) {
        collapsed.push({
          type: 'tool_group',
          items: toolRun.map((tool) => ({ ...tool, done: tool.done !== false })),
        });
      } else {
        collapsed.push(...toolRun.map((tool) => ({ ...tool, done: tool.done !== false })));
      }
      toolRun = [];
    }

    source.forEach((segment) => {
      if (segment.type === 'tool_call') {
        toolRun.push(segment);
        return;
      }
      flushToolRun();
      collapsed.push(segment);
    });

    flushToolRun();
    return collapsed;
  }

  function toolGroupSummaryText(toolItems) {
    const items = Array.isArray(toolItems) ? toolItems : [];
    const total = items.length;
    const running = items.filter((item) => item?.done === false).length;
    const failed = items.filter((item) => toolKind(item) === 'command_execution' && typeof item?.meta?.exitCode === 'number' && item.meta.exitCode !== 0).length;
    if (running > 0) return `${total} 个工具调用 · ${running} 个运行中`;
    if (failed > 0) return `${total} 个工具调用 · ${failed} 个异常`;
    return `${total} 个工具调用`;
  }

  function refreshToolGroupSummary(group) {
    if (!group) return;
    const summary = group.querySelector('.tool-group-summary');
    const inner = group.querySelector('.tool-group-inner');
    if (!summary || !inner) return;
    const items = Array.from(inner.querySelectorAll(':scope > .tool-call')).map((call) => {
      const toolUseId = call.id ? call.id.replace(/^tool-/, '') : '';
      const active = toolUseId ? composeState.activeToolCalls.get(toolUseId) : null;
      const fallbackTool = {
        id: toolUseId,
        name: call.dataset.toolName || '',
        kind: call.dataset.toolKind || null,
        done: !call.querySelector('.tool-call-state.running'),
        meta: active?.meta || null,
      };
      return active ? { ...active, id: toolUseId } : fallbackTool;
    });
    summary.textContent = toolGroupSummaryText(items);
  }

  function createToolGroupElement(toolItems = []) {
    const group = document.createElement('details');
    group.className = 'tool-group msg-segment';
    const summary = document.createElement('summary');
    summary.className = 'tool-group-summary';
    group.appendChild(summary);
    const inner = document.createElement('div');
    inner.className = 'tool-group-inner';
    group.appendChild(inner);

    toolItems.forEach((tool) => {
      const details = createToolCallElement(tool.id || nextLocalId('saved'), tool, tool.done !== false);
      inner.appendChild(details);
    });

    refreshToolGroupSummary(group);
    return group;
  }

  function buildMessageSegmentElement(segment) {
    if (!segment) return null;
    if (segment.type === 'tool_group') {
      return createToolGroupElement(segment.items || []);
    }
    if (segment.type === 'tool_call') {
      const details = createToolCallElement(segment.id || nextLocalId('saved'), segment, segment.done !== false);
      details.classList.add('msg-segment');
      return details;
    }
    const text = typeof segment.text === 'string' ? segment.text : '';
    if (!text) return null;
    return createTextSegmentElement(text, { phase: segment.phase || 'final' });
  }

  function renderAssistantSegments(bubble, message) {
    if (!bubble) return;
    bubble.innerHTML = '';
    normalizeMessageSegments(message).forEach((segment) => {
      const segmentEl = buildMessageSegmentElement(segment);
      if (segmentEl) bubble.appendChild(segmentEl);
    });
    appendMessageAttachments(bubble, message?.attachments || []);
  }

  function renderStreamingSegments(segments) {
    const bubble = getStreamingBubble();
    if (!bubble) return;
    bubble.innerHTML = '';
    normalizeSegmentsForDisplay(segments).forEach((segment) => {
      const segmentEl = buildMessageSegmentElement(segment);
      if (segmentEl) bubble.appendChild(segmentEl);
    });
  }

  function markStreamingProcessTextSegments() {
    const bubble = getStreamingBubble();
    if (!bubble) return;
    bubble.querySelectorAll('.msg-segment-text').forEach((segment) => {
      segment.classList.remove('msg-segment-final');
      segment.classList.add('msg-segment-process');
      segment.dataset.phase = 'process';
    });
  }

  function buildMsgElement(m) {
    if (m.role !== 'assistant') return createMsgElement(m.role, m.content, m.attachments || []);
    const el = createMsgElement('assistant', '');
    renderAssistantSegments(el.querySelector('.msg-bubble'), m);
    return el;
  }

  function renderMessages(messages, options = {}) {
    renderEpoch++;
    const epoch = renderEpoch;
    _previewCodeMap.clear();
    _previewCodeId = 0;
    messagesDiv.classList.add('messages-switching');
    messagesDiv.innerHTML = '';
    if (messages.length === 0) {
      messagesDiv.innerHTML = buildWelcomeMarkup(sessionState.currentAgent);
      requestAnimationFrame(() => messagesDiv.classList.remove('messages-switching'));
      return;
    }
    if (options.immediate) {
      const frag = document.createDocumentFragment();
      messages.forEach((message) => frag.appendChild(buildMsgElement(message)));
      messagesDiv.appendChild(frag);
      scrollToBottom();
      requestAnimationFrame(() => messagesDiv.classList.remove('messages-switching'));
      return;
    }
    
    // Adaptive batch sizing based on message count for better performance
    const len = messages.length;
    const BATCH_SIZE = len > 100 ? 15 : (len > 50 ? 12 : 10);
    const BATCH_DELAY = len > 100 ? 24 : (len > 50 ? 20 : 16);
    
    // Calculate batches - render from newest to oldest
    const batches = [];
    // First batch: most recent messages (visible immediately)
    const firstBatchEnd = Math.min(BATCH_SIZE, len);
    batches.push([len - firstBatchEnd, len]);
    
    // Remaining batches: older messages
    let currentStart = len - firstBatchEnd;
    while (currentStart > 0) {
      const batchEnd = currentStart;
      const batchStart = Math.max(0, currentStart - BATCH_SIZE);
      batches.push([batchStart, batchEnd]);
      currentStart = batchStart;
    }

    // Render first batch immediately
    const frag0 = document.createDocumentFragment();
    for (let i = batches[0][0]; i < batches[0][1]; i++) frag0.appendChild(buildMsgElement(messages[i]));
    messagesDiv.appendChild(frag0);
    scrollToBottom();
    requestAnimationFrame(() => messagesDiv.classList.remove('messages-switching'));

    // Render remaining batches asynchronously with requestAnimationFrame
    // This prevents blocking the main thread and maintains responsiveness
    let batchIndex = 1;
    
    function renderNextBatch() {
      if (renderEpoch !== epoch || batchIndex >= batches.length) return;
      
      const [start, end] = batches[batchIndex];
      const prevHeight = messagesDiv.scrollHeight;
      const prevScrollTop = messagesDiv.scrollTop;
      
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) frag.appendChild(buildMsgElement(messages[i]));
      messagesDiv.insertBefore(frag, messagesDiv.firstChild);
      
      // Compensate scrollTop so visible area stays unchanged
      messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
      updateScrollbar();
      
      batchIndex++;
      if (batchIndex < batches.length) {
        // Use requestAnimationFrame for smoother rendering
        requestAnimationFrame(renderNextBatch);
      }
    }
    
    // Start async rendering after a short delay
    if (batches.length > 1) {
      setTimeout(() => requestAnimationFrame(renderNextBatch), BATCH_DELAY);
    }
  }

  function prependHistoryMessages(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const preserveScroll = options.preserveScroll !== false;
    const skipScrollbar = options.skipScrollbar === true;
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const frag = document.createDocumentFragment();
    messages.forEach((m) => frag.appendChild(buildMsgElement(m)));
    if (!preserveScroll) {
      messagesDiv.insertBefore(frag, messagesDiv.firstChild);
      if (!skipScrollbar) updateScrollbar();
      return;
    }
    const prevHeight = messagesDiv.scrollHeight;
    const prevScrollTop = messagesDiv.scrollTop;
    messagesDiv.insertBefore(frag, messagesDiv.firstChild);
    messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
    if (!skipScrollbar) updateScrollbar();
  }

  function normalizeAskUserInput(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    return input;
  }

  function extractAskUserQuestions(input) {
    const parsed = normalizeAskUserInput(input);
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions;
  }

  function appendAskOptionToInput(question, option) {
    const header = (question?.header || '').trim() || '问题';
    const line = `【${header}】${option?.label || ''}`;
    const current = msgInput.value.trim();
    msgInput.value = current ? `${current}\n${line}` : line;
    autoResize();
    msgInput.focus();
  }

  function createAskUserQuestionView(questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ask-user-question';

    questions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'ask-question-card';

      const header = document.createElement('div');
      header.className = 'ask-question-header';
      header.textContent = `${idx + 1}. ${q.header || '问题'}`;
      card.appendChild(header);

      const body = document.createElement('div');
      body.className = 'ask-question-text';
      body.textContent = q.question || '';
      card.appendChild(body);

      if (Array.isArray(q.options) && q.options.length > 0) {
        const hasDesc = q.options.some(o => o.description);

        // 左右分栏容器
        const layout = document.createElement('div');
        layout.className = 'ask-options-layout' + (hasDesc ? ' has-preview' : '');

        const opts = document.createElement('div');
        opts.className = 'ask-question-options';

        // 右侧预览区（仅在有 description 时创建）
        const preview = hasDesc ? document.createElement('div') : null;
        if (preview) {
          preview.className = 'ask-option-preview';
          // 默认显示第一项
          preview.textContent = q.options[0].description || '';
        }

        // 当前选中项（移动端 tap-to-preview 状态）
        let selectedOpt = null;
        let selectedBtn = null;

        q.options.forEach((opt, i) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ask-option-item';

          const title = document.createElement('div');
          title.className = 'ask-option-label';
          title.textContent = `${i + 1}. ${opt.label || ''}`;
          item.appendChild(title);

          // 桌面：hover 切换预览
          if (preview) {
            item.addEventListener('mouseenter', () => {
              preview.textContent = opt.description || '';
            });
          }

          item.addEventListener('click', (e) => {
            const isTouch = item.dataset.touchActivated === '1';
            item.dataset.touchActivated = '';

            if (isTouch) {
              // 移动端：第一次 tap = 选中预览，不发送
              if (selectedBtn !== item) {
                if (selectedBtn) selectedBtn.classList.remove('ask-option-selected');
                selectedBtn = item;
                selectedOpt = opt;
                item.classList.add('ask-option-selected');
                if (preview) preview.textContent = opt.description || '';
                return;
              }
              // 第二次 tap 同一项 = 发送
            }

            // 桌面直接发送
            appendAskOptionToInput(q, opt);
          });

          item.addEventListener('touchstart', () => {
            item.dataset.touchActivated = '1';
          }, { passive: true });

          opts.appendChild(item);
        });

        layout.appendChild(opts);
        if (preview) {
          layout.appendChild(preview);
          // 预览区最小高度 = 左侧选项列表总高度（渲染后同步）
          requestAnimationFrame(() => {
            preview.style.minHeight = opts.offsetHeight + 'px';
          });
        }

        // 移动端确认按钮
        if (hasDesc) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'ask-confirm-btn';
          confirmBtn.textContent = '确认选择';
          confirmBtn.addEventListener('click', () => {
            if (selectedOpt) {
              appendAskOptionToInput(q, selectedOpt);
            } else if (q.options.length > 0) {
              appendAskOptionToInput(q, q.options[0]);
            }
          });
          layout.appendChild(confirmBtn);
        }

        card.appendChild(layout);
      }

      wrapper.appendChild(card);
    });

    return wrapper;
  }

  function buildToolContentElement(name, input) {
    const tool = typeof name === 'object' && name !== null ? name : { name, input };
    const effectiveName = tool.name || name;
    const effectiveInput = tool.input !== undefined ? tool.input : input;
    const effectiveResult = tool.result;
    const kind = toolKind(tool);
    if (effectiveName === 'AskUserQuestion') {
      const questions = extractAskUserQuestions(effectiveInput);
      if (questions.length > 0) {
        return createAskUserQuestionView(questions);
      }
    }

    if (kind === 'command_execution') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content command';
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      const commandText = effectiveInput?.command || tool?.meta?.subtitle || '';
      if (commandText) stack.appendChild(buildStructuredToolSection('Command', commandText));
      if (effectiveResult) {
        stack.appendChild(buildStructuredToolSection('Output', stringifyToolValue(effectiveResult)));
      } else if (!tool.done) {
        const empty = document.createElement('div');
        empty.className = 'tool-call-empty';
        empty.textContent = '等待命令输出…';
        stack.appendChild(empty);
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    if (kind === 'reasoning') {
      const content = document.createElement('div');
      content.className = 'tool-call-content reasoning';
      const text = stringifyToolValue(effectiveResult || effectiveInput);
      content.innerHTML = text ? renderMarkdown(text) : '<div class="tool-call-empty">暂无推理内容</div>';
      return content;
    }

    if (kind === 'file_change' || kind === 'mcp_tool_call') {
      const wrapper = document.createElement('div');
      wrapper.className = `tool-call-content ${kind === 'file_change' ? 'file-change' : ''}`.trim();
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      if (tool?.meta?.subtitle) {
        stack.appendChild(buildStructuredToolSection(kind === 'file_change' ? 'Target' : 'Tool', tool.meta.subtitle));
      }
      const payloadText = stringifyToolValue(effectiveResult || effectiveInput);
      if (payloadText) {
        stack.appendChild(buildStructuredToolSection('Payload', payloadText));
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    const inputStr = stringifyToolValue(effectiveResult || effectiveInput);
    const content = document.createElement('div');
    content.className = 'tool-call-content';
    content.textContent = inputStr;
    return content;
  }

  function createToolCallElement(toolUseId, tool, done) {
    const details = document.createElement('details');
    details.className = 'tool-call msg-segment';
    details.id = `tool-${toolUseId}`;
    details.dataset.toolName = tool.name || '';
    if (toolKind(tool)) {
      details.dataset.toolKind = toolKind(tool);
      details.classList.add(`codex-${toolKind(tool).replace(/_/g, '-')}`);
    }

    const summary = document.createElement('summary');
    applyToolSummary(summary, tool, done);
    details.appendChild(summary);
    details.appendChild(buildToolContentElement({ ...tool, done }));
    return details;
  }

  function appendToolCall(toolUseId, name, input, done, kind = null, meta = null) {
    const bubble = getStreamingBubble();
    if (!bubble) return;
    clearStreamingPlaceholder(bubble);

    const tool = { id: toolUseId, name, input, kind, meta, done };
    const details = createToolCallElement(toolUseId, tool, done);

    const trailingCluster = [];
    for (let node = bubble.lastElementChild; node; node = node.previousElementSibling) {
      if (node.classList.contains('tool-call') || node.classList.contains('tool-group')) {
        trailingCluster.unshift(node);
        continue;
      }
      break;
    }

    const trailingGroup = trailingCluster.length === 1 && trailingCluster[0].classList.contains('tool-group')
      ? trailingCluster[0]
      : null;

    if (trailingGroup) {
      const inner = trailingGroup.querySelector('.tool-group-inner');
      inner.appendChild(details);
      refreshToolGroupSummary(trailingGroup);
    } else if (trailingCluster.length + 1 >= TOOL_GROUP_THRESHOLD) {
      const group = createToolGroupElement([]);
      if (trailingCluster[0]) bubble.insertBefore(group, trailingCluster[0]);
      else bubble.appendChild(group);
      const inner = group.querySelector('.tool-group-inner');
      trailingCluster.forEach((child) => inner.appendChild(child));
      inner.appendChild(details);
      refreshToolGroupSummary(group);
    } else {
      bubble.appendChild(details);
    }
    scrollToBottom();
  }

  function updateToolCall(toolUseId, result) {
    const el = document.getElementById(`tool-${toolUseId}`);
    if (!el) return;
    const tool = composeState.activeToolCalls.get(toolUseId) || {
      id: toolUseId,
      name: el.dataset.toolName || '',
      kind: el.dataset.toolKind || null,
      done: true,
    };
    tool.done = true;
    if (result !== undefined) tool.result = result;
    const summary = el.querySelector('summary');
    if (summary) applyToolSummary(summary, tool, true);
    if (tool.name !== 'AskUserQuestion') {
      const nextContent = buildToolContentElement(tool);
      const content = el.querySelector('.tool-call-content');
      if (content) content.replaceWith(nextContent);
    }
    refreshToolGroupSummary(el.closest('.tool-group'));
  }

  function getDeleteConfirmMessage(agent) {
    const normalized = normalizeAgent(agent);
    if (normalized === 'codex') {
      return '删除本会话将同步删去本地 Codex rollout 历史与线程记录，不可恢复。确认删除？';
    }
    return '删除本会话将同步删去本地 Claude 中的会话历史，不可恢复。确认删除？';
  }

  function showDeleteConfirm(agent, onConfirm) {
    const { overlay, panel: box, close } = createOverlayPanel({
      zIndex: '10002',
      panelHtml: `
      <div style="font-size:0.9em;color:var(--text-primary);margin-bottom:20px;line-height:1.7">${escapeHtml(getDeleteConfirmMessage(agent))}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="del-confirm-ok" style="width:100%;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:0.95em;font-weight:600;cursor:pointer;font-family:inherit">确认删除</button>
        <button id="del-confirm-skip" style="width:100%;padding:9px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:0.85em;cursor:pointer;font-family:inherit">确认且不再提示</button>
        <button id="del-confirm-cancel" style="width:100%;padding:9px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.85em;cursor:pointer;font-family:inherit">取消</button>
      </div>
    `,
    });
    box.querySelector('#del-confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    box.querySelector('#del-confirm-skip').addEventListener('click', () => {
      skipDeleteConfirm = true;
      localStorage.setItem('webcoding-skip-delete-confirm', '1');
      close();
      onConfirm();
    });
    box.querySelector('#del-confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  function appendSystemMessage(message) {
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    messagesDiv.appendChild(createMsgElement('system', message));
    scrollToBottom();
  }

  function appendError(message, options = {}) {
    const errorType = options.type || 'error';
    const dismissible = options.dismissible !== false;
    
    const div = document.createElement('div');
    div.className = 'msg system error-msg';
    div.setAttribute('data-error-type', errorType);
    
    const bubbleStyle = options.style || 'border-color:var(--danger);color:var(--danger)';
    const icon = options.icon || '⚠';
    
    div.innerHTML = `<div class="msg-bubble" style="${bubbleStyle}">${icon} ${escapeHtml(message)}${dismissible ? '<button class="error-dismiss-btn" aria-label="关闭">×</button>' : ''}</div>`;
    
    if (dismissible) {
      const dismissBtn = div.querySelector('.error-dismiss-btn');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => div.remove());
      }
    }
    
    messagesDiv.appendChild(div);
    scrollToBottom();
    
    // Auto-scroll to make error visible
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
      updateScrollbar();
    });
  }

  // --- Custom Scrollbar ---
  const scrollbarEl = document.getElementById('custom-scrollbar');
  const thumbEl = document.getElementById('custom-scrollbar-thumb');

  function updateScrollbar() {
    if (!scrollbarEl || !thumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesDiv;
    if (scrollHeight <= clientHeight) {
      thumbEl.style.display = 'none';
      return;
    }
    thumbEl.style.display = '';
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * (trackH - thumbH);
    thumbEl.style.height = thumbH + 'px';
    thumbEl.style.top = thumbTop + 'px';
  }

  messagesDiv.addEventListener('scroll', () => {
    updateScrollbar();
    // 移动端：滚动时短暂显示滑块，停止后淡出
    scrollbarEl.classList.add('scrolling');
    clearTimeout(scrollbarEl._hideTimer);
    scrollbarEl._hideTimer = setTimeout(() => {
      if (!isDragging) scrollbarEl.classList.remove('scrolling');
    }, 1200);
  }, { passive: true });
  new ResizeObserver(updateScrollbar).observe(messagesDiv);

  // Drag logic
  let dragStartY = 0, dragStartScrollTop = 0, isDragging = false;

  function onDragStart(e) {
    isDragging = true;
    dragStartY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    dragStartScrollTop = messagesDiv.scrollTop;
    thumbEl.classList.add('dragging');
    scrollbarEl.classList.add('active');
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dy = clientY - dragStartY;
    const { scrollHeight, clientHeight } = messagesDiv;
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const ratio = (scrollHeight - clientHeight) / (trackH - thumbH);
    messagesDiv.scrollTop = dragStartScrollTop + dy * ratio;
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    thumbEl.classList.remove('dragging');
    scrollbarEl.classList.remove('active');
  }

  thumbEl.addEventListener('mousedown', onDragStart);
  thumbEl.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchend', onDragEnd);

  updateScrollbar();


  function getSessionUpdatedTimestamp(session) {
    const next = new Date(session?.updated || 0).getTime();
    return Number.isFinite(next) ? next : 0;
  }

  function getLatestSessionTimestamp(groupSessions, timestampCache = null) {
    return (Array.isArray(groupSessions) ? groupSessions : []).reduce((latest, session) => {
      const next = timestampCache?.get(session?.id) ?? getSessionUpdatedTimestamp(session);
      return next > latest ? next : latest;
    }, 0);
  }

  function normalizeComparablePath(pathValue) {
    if (!pathValue) return '';
    const normalized = String(pathValue).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized || '/';
  }

  function getPathLeaf(pathValue) {
    const normalized = normalizeComparablePath(pathValue);
    if (!normalized || normalized === '/') return pathValue || '/';
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  function decodeClaudeProjectDir(projectDir) {
    const raw = String(projectDir || '').trim();
    if (!raw) return null;
    if (raw.startsWith('-') && !raw.includes('/') && !raw.includes('\\')) {
      const parts = raw.split('-').filter(Boolean);
      if (parts.length > 0) return `/${parts.join('/')}`;
    }
    return raw;
  }

  function formatClaudeImportGroupPath(projectDir) {
    const raw = String(projectDir || '').trim();
    if (!raw) return '/';
    const decoded = decodeClaudeProjectDir(raw);
    if (decoded && decoded !== raw) {
      return normalizeComparablePath(decoded);
    }
    let readablePath = raw.replace(/-/g, '/');
    if (!readablePath.startsWith('/')) readablePath = '/' + readablePath;
    return readablePath.replace(/\/+/g, '/');
  }

  function isSameOrChildPath(parentPath, childPath) {
    const parent = normalizeComparablePath(parentPath);
    const child = normalizeComparablePath(childPath);
    if (!parent || !child) return false;
    if (parent === child) return true;
    if (parent === '/') return child.startsWith('/');
    return child.startsWith(`${parent}/`);
  }

  function findBestProjectForSession(session, projectsById) {
    const comparablePath = session.cwd || decodeClaudeProjectDir(session.importedFrom);
    if (session.projectId && projectsById.has(session.projectId)) {
      return projectsById.get(session.projectId);
    }
    if (!comparablePath) return null;
    let matchedProject = null;
    let matchedPathLength = -1;
    for (const project of projects) {
      if (!project?.path || !isSameOrChildPath(project.path, comparablePath)) continue;
      const projectPathLength = normalizeComparablePath(project.path).length;
      if (projectPathLength > matchedPathLength) {
        matchedProject = project;
        matchedPathLength = projectPathLength;
      }
    }
    return matchedProject;
  }

  function buildVirtualProjectFromCwd(cwd) {
    const normalizedCwd = normalizeComparablePath(cwd);
    return {
      id: `__cwd__:${normalizedCwd || cwd}`,
      name: getPathLeaf(normalizedCwd || cwd) || '当前目录',
      path: cwd,
      isVirtualCwd: true,
    };
  }

  function buildVirtualProjectFromSession(session) {
    const derivedPath = session.cwd || decodeClaudeProjectDir(session.importedFrom);
    if (!derivedPath) return null;
    return buildVirtualProjectFromCwd(derivedPath);
  }

  function getProjectParentPath(project) {
    const p = project.path;
    if (!p) return '';
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return p;
    return p.substring(0, idx);
  }

  function findProjectGroupElement(projectId) {
    return [...sessionList.querySelectorAll('.project-group')].find((node) => node.dataset.projectId === projectId) || null;
  }

  function focusProjectGroup(projectId, options = {}) {
    if (!projectId) return false;

    if (collapsedProjects.has(projectId)) {
      collapsedProjects.delete(projectId);
      saveCollapsedProjects();
      renderSessionList();
    }

    const target = findProjectGroupElement(projectId);
    if (!target) return false;

    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'nearest', behavior: options.instant ? 'auto' : 'smooth' });
      target.classList.remove('project-group-focused');
      void target.offsetWidth;
      target.classList.add('project-group-focused');
      window.setTimeout(() => target.classList.remove('project-group-focused'), 1400);
    });

    if (options.toast) showToast(options.toast);
    return true;
  }

  function buildSessionItem(s) {
    const item = document.createElement('div');
    item.className = `session-item${s.id === sessionState.currentSessionId ? ' active' : ''}${s.hasUnread ? ' has-unread' : ''}${s.isRunning ? ' is-running' : ''}`;
    item.dataset.id = s.id;
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `会话: ${s.title || 'Untitled'}`);

    const leading = document.createElement('span');
    leading.className = 'session-item-leading';
    leading.setAttribute('aria-hidden', 'true');

    const marker = document.createElement('span');
    marker.className = 'session-item-marker';
    leading.appendChild(marker);

    const content = document.createElement('div');
    content.className = 'session-item-content';

    const title = document.createElement('span');
    title.className = 'session-item-title';
    title.textContent = s.title || 'Untitled';
    title.title = s.title || 'Untitled';

    const right = document.createElement('div');
    right.className = 'session-item-right';

    if (s.hasUnread) {
      const unread = document.createElement('span');
      unread.className = 'session-unread-dot';
      right.appendChild(unread);
    }

    if (s.isRunning) {
      const status = document.createElement('span');
      status.className = 'session-item-status';
      status.textContent = '运行中';
      right.appendChild(status);
    }

    const agentBadge = document.createElement('span');
    agentBadge.className = 'session-item-agent';
    const agentLabel = AGENT_LABELS[normalizeAgent(s.agent)] || 'Agent';
    agentBadge.textContent = agentLabel;
    right.appendChild(agentBadge);

    const editBtn = document.createElement('button');
    editBtn.className = 'session-item-btn edit';
    editBtn.title = '重命名';
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', '重命名会话');
    editBtn.textContent = '✎';
    right.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'session-item-btn delete';
    deleteBtn.title = '删除';
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', '删除会话');
    deleteBtn.textContent = '×';
    right.appendChild(deleteBtn);

    content.appendChild(title);
    content.appendChild(right);

    item.appendChild(leading);
    item.appendChild(content);

    item.addEventListener('click', (e) => {
      const actionBtn = e.target instanceof Element ? e.target.closest('button') : null;
      if (actionBtn?.classList.contains('delete')) {
        e.stopPropagation();
        const doDelete = () => {
          const sessionAgent = normalizeAgent(s.agent);
          if (getLastSessionForAgent(sessionAgent) === s.id) {
            localStorage.removeItem(getAgentSessionStorageKey(sessionAgent));
          }
          if (localStorage.getItem('webcoding-session') === s.id) localStorage.removeItem('webcoding-session');
          invalidateSessionCache(s.id);
          send({ type: 'delete_session', sessionId: s.id });
          if (s.id === sessionState.currentSessionId) {
            resetChatView(selectedAgent);
          }
        };
        if (skipDeleteConfirm) {
          doDelete();
        } else {
          showDeleteConfirm(s.agent, doDelete);
        }
        return;
      }
      if (actionBtn?.classList.contains('edit')) {
        e.stopPropagation();
        startEditSessionTitle(item, s);
        return;
      }
      openSession(s.id);
    });

    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSession(s.id);
      }
    });

    return item;
  }

  function saveCollapsedProjects() {
    localStorage.setItem('webcoding-collapsed-projects', JSON.stringify([...collapsedProjects]));
  }

  function renderProjectGroup(project, groupSessions, container, timestampCache) {
    const isVirtualCwd = Boolean(project.isVirtualCwd);
    const containsCurrentSession = groupSessions.some((session) => session.id === sessionState.currentSessionId);
    const isCollapsed = collapsedProjects.has(project.id);
    const runningCount = groupSessions.reduce((count, session) => count + (session.isRunning ? 1 : 0), 0);
    const unreadCount = groupSessions.reduce((count, session) => count + (session.hasUnread ? 1 : 0), 0);

    const group = document.createElement('section');
    group.className = 'project-group'
      + (containsCurrentSession ? ' active-project' : '')
      + (groupSessions.length === 0 ? ' empty-project' : '')
      + (runningCount ? ' has-running' : '')
      + (unreadCount ? ' has-unread' : '');
    group.dataset.projectId = project.id;
    group.dataset.sessionCount = String(groupSessions.length);
    if (runningCount) group.dataset.runningCount = String(runningCount);
    if (unreadCount) group.dataset.unreadCount = String(unreadCount);

    const header = document.createElement('div');
    header.className = 'project-group-header' + (isCollapsed ? ' collapsed' : '');
    header.dataset.projectId = project.id;
    header.setAttribute('aria-expanded', String(!isCollapsed));
    header.setAttribute('aria-label', `${project.name}，${groupSessions.length} 个会话`);

    const main = document.createElement('div');
    main.className = 'project-group-main';

    const chevron = document.createElement('span');
    chevron.className = 'project-group-chevron';
    chevron.textContent = '▸';

    const copy = document.createElement('div');
    copy.className = 'project-group-copy';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'project-group-name';
    nameSpan.textContent = project.name;
    nameSpan.title = project.name;

    const pathLine = document.createElement('div');
    pathLine.className = 'project-group-path';
    const parentPath = getProjectParentPath(project);
    pathLine.textContent = parentPath;
    if (project.path) pathLine.title = project.path;

    const countBadge = document.createElement('span');
    countBadge.className = 'project-group-count';
    countBadge.textContent = String(groupSessions.length);
    countBadge.title = `${groupSessions.length} 个会话`;

    copy.appendChild(nameSpan);
    if (parentPath) copy.appendChild(pathLine);

    main.appendChild(chevron);
    main.appendChild(copy);
    main.appendChild(countBadge);

    const actions = document.createElement('div');
    actions.className = 'project-group-actions';
    const createBtn = document.createElement('button');
    createBtn.className = 'project-group-create-btn';
    createBtn.title = '在此项目下新建会话';
    createBtn.type = 'button';
    createBtn.textContent = '+';
    createBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextMode = getSavedModeForAgent(selectedAgent);
      send(isVirtualCwd
        ? { type: 'new_session', cwd: project.path, agent: selectedAgent, mode: nextMode }
        : { type: 'new_session', projectId: project.id, agent: selectedAgent, mode: nextMode });
    });
    actions.appendChild(createBtn);
    const renameBtn = document.createElement('button');
    renameBtn.className = 'project-group-btn';
    renameBtn.title = '重命名';
    renameBtn.type = 'button';
    renameBtn.setAttribute('aria-label', '重命名项目');
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isVirtualCwd) {
        pendingProjectSaveCallback = (updatedProjects) => {
          const saved = updatedProjects.find((p) => p.path === project.path);
          if (saved) {
            const groupEl = findProjectGroupElement(saved.id);
            const headerEl = groupEl?.querySelector('.project-group-header');
            if (headerEl) startEditProjectName(headerEl, saved);
          }
        };
        send({ type: 'save_project', path: project.path, name: project.name });
      } else {
        startEditProjectName(header, project);
      }
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'project-group-btn';
    deleteBtn.title = '移除项目';
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', '移除项目');
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isVirtualCwd) {
        if (confirm(`确定移除「${project.name}」分组？\n（会话将变为独立显示）`)) {
          pendingProjectSaveCallback = (updatedProjects) => {
            const saved = updatedProjects.find((p) => p.path === project.path);
            if (saved) send({ type: 'delete_project', projectId: saved.id });
          };
          send({ type: 'save_project', path: project.path, name: project.name });
        }
      } else {
        if (confirm(`确定移除项目「${project.name}」？\n（不会删除会话，会话仍会保留）`)) {
          send({ type: 'delete_project', projectId: project.id });
        }
      }
    });
    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    header.appendChild(main);
    if (actions.childElementCount) header.appendChild(actions);

    header.addEventListener('click', () => {
      if (isCollapsed) {
        collapsedProjects.delete(project.id);
      } else {
        collapsedProjects.add(project.id);
      }
      saveCollapsedProjects();
      renderSessionList();
    });
    group.appendChild(header);

    const body = document.createElement('div');
    body.className = 'project-group-body' + (isCollapsed ? ' collapsed' : '');
    if (!isCollapsed) {
      const sortedSessions = [...groupSessions].sort((a, b) => {
        const bTs = timestampCache?.get(b.id) ?? getSessionUpdatedTimestamp(b);
        const aTs = timestampCache?.get(a.id) ?? getSessionUpdatedTimestamp(a);
        return bTs - aTs;
      });
      for (const s of sortedSessions) {
        body.appendChild(buildSessionItem(s));
      }
      if (sortedSessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-group-empty';
        empty.textContent = '这个项目下还没有对话。';
        body.appendChild(empty);
      }
    }
    group.appendChild(body);
    container.appendChild(group);
  }

  function startEditProjectName(headerEl, project) {
    const nameEl = headerEl.querySelector('.project-group-name');
    const currentName = project.name || '';
    const input = document.createElement('input');
    input.className = 'session-item-edit-input';
    input.value = currentName;
    input.maxLength = 50;
    input.style.fontSize = '12px';
    input.style.fontWeight = '700';

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const actionsEl = headerEl.querySelector('.project-group-actions');
    if (actionsEl) actionsEl.style.display = 'none';

    function save() {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        send({ type: 'rename_project', projectId: project.id, name: newName });
      }
      renderSessionList();
    }
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  function renderSessionList() {
    const savedScrollTop = sessionList.scrollTop;
    sessionList.innerHTML = '';
    const visibleSessions = getVisibleSessions();
    const listFragment = document.createDocumentFragment();
    const hasProjects = projects.length > 0;
    const sessionTimestampCache = new Map();
    for (const session of visibleSessions) {
      sessionTimestampCache.set(session.id, getSessionUpdatedTimestamp(session));
    }

    if (visibleSessions.length === 0 && !hasProjects) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = '暂无会话，点击“新建/打开项目”开始。';
      listFragment.appendChild(empty);
      sessionList.appendChild(listFragment);
      renderWorkspaceInsights();
      return;
    }

    if (visibleSessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = '当前还没有会话，你可以从下面任意项目继续新建。';
      listFragment.appendChild(empty);
    }

    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const grouped = new Map();
    const virtualProjectsById = new Map();
    const ungrouped = [];
    for (const s of visibleSessions) {
      const matchedProject = findBestProjectForSession(s, projectsById);
      if (matchedProject) {
        if (!grouped.has(matchedProject.id)) grouped.set(matchedProject.id, []);
        grouped.get(matchedProject.id).push(s);
        continue;
      }
      const virtualProject = buildVirtualProjectFromSession(s);
      if (virtualProject) {
        if (!virtualProjectsById.has(virtualProject.id)) {
          virtualProjectsById.set(virtualProject.id, virtualProject);
        }
        if (!grouped.has(virtualProject.id)) grouped.set(virtualProject.id, []);
        grouped.get(virtualProject.id).push(s);
        continue;
      }
      ungrouped.push(s);
    }

    const groupEntries = projects.map((project) => ({
      project,
      groupSessions: grouped.get(project.id) || [],
      containsCurrentSession: (grouped.get(project.id) || []).some((session) => session.id === sessionState.currentSessionId),
      isVirtual: false,
      latestTimestamp: getLatestSessionTimestamp(grouped.get(project.id) || [], sessionTimestampCache),
    }));

    for (const project of virtualProjectsById.values()) {
      const groupSessions = grouped.get(project.id) || [];
      groupEntries.push({
        project,
        groupSessions,
        containsCurrentSession: groupSessions.some((session) => session.id === sessionState.currentSessionId),
        isVirtual: true,
        latestTimestamp: getLatestSessionTimestamp(groupSessions, sessionTimestampCache),
      });
    }

    groupEntries.sort((a, b) => {
      if (a.containsCurrentSession !== b.containsCurrentSession) {
        return a.containsCurrentSession ? -1 : 1;
      }
      const aHasSessions = a.groupSessions.length > 0;
      const bHasSessions = b.groupSessions.length > 0;
      if (aHasSessions !== bHasSessions) {
        return aHasSessions ? -1 : 1;
      }
      const latestDiff = b.latestTimestamp - a.latestTimestamp;
      if (latestDiff !== 0) return latestDiff;
      return SESSION_LIST_COLLATOR.compare(a.project.name || '', b.project.name || '');
    });

    for (const entry of groupEntries) {
      renderProjectGroup(entry.project, entry.groupSessions, listFragment, sessionTimestampCache);
    }
    if (ungrouped.length > 0) {
      const sortedUngrouped = [...ungrouped].sort((a, b) => {
        const bTs = sessionTimestampCache.get(b.id) ?? getSessionUpdatedTimestamp(b);
        const aTs = sessionTimestampCache.get(a.id) ?? getSessionUpdatedTimestamp(a);
        return bTs - aTs;
      });
      for (const session of sortedUngrouped) {
        listFragment.appendChild(buildSessionItem(session));
      }
    }
    sessionList.appendChild(listFragment);
    renderWorkspaceInsights();
    sessionList.scrollTop = savedScrollTop;
  }

  function startEditSessionTitle(itemEl, session) {
    const titleEl = itemEl.querySelector('.session-item-title');
    const currentTitle = session.title || '';
    const input = document.createElement('input');
    input.className = 'session-item-edit-input';
    input.value = currentTitle;
    input.maxLength = 100;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide right-side controls during edit
    const rightEl = itemEl.querySelector('.session-item-right');
    if (rightEl) rightEl.style.display = 'none';

    function save() {
      const newTitle = input.value.trim() || currentTitle;
      if (newTitle !== currentTitle) {
        send({ type: 'rename_session', sessionId: session.id, title: newTitle });
      }
      const span = document.createElement('span');
      span.className = 'session-item-title';
      span.textContent = newTitle;
      input.replaceWith(span);
      if (rightEl) rightEl.style.display = '';
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  }

  function highlightActiveSession() {
    document.querySelectorAll('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === sessionState.currentSessionId);
    });
  }

  // --- Header title editing (contenteditable) ---
  chatTitle.addEventListener('click', () => {
    if (!sessionState.currentSessionId || chatTitle.contentEditable === 'true') return;
    const originalText = chatTitle.textContent;
    chatTitle.contentEditable = 'true';
    chatTitle.style.background = 'var(--chat-title-edit-bg)';
    chatTitle.style.outline = '1px solid var(--accent)';
    chatTitle.style.borderRadius = '6px';
    chatTitle.style.padding = '2px 8px';
    chatTitle.style.minWidth = '96px';
    chatTitle.style.whiteSpace = 'normal';
    chatTitle.style.overflow = 'visible';
    chatTitle.style.textOverflow = 'clip';
    chatTitle.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(chatTitle);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish(save) {
      chatTitle.removeEventListener('keydown', handler);
      chatTitle.contentEditable = 'false';
      chatTitle.style.background = '';
      chatTitle.style.outline = '';
      chatTitle.style.borderRadius = '';
      chatTitle.style.padding = '';
      chatTitle.style.minWidth = '';
      chatTitle.style.whiteSpace = '';
      chatTitle.style.overflow = '';
      chatTitle.style.textOverflow = '';
      const newTitle = chatTitle.textContent.trim() || originalText;
      chatTitle.textContent = newTitle;
      if (save && newTitle !== originalText && sessionState.currentSessionId) {
        send({ type: 'rename_session', sessionId: sessionState.currentSessionId, title: newTitle });
      }
    }

    chatTitle.addEventListener('blur', () => finish(true), { once: true });
    function handler(e) {
      if (e.key === 'Enter') { e.preventDefault(); chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
      if (e.key === 'Escape') { chatTitle.textContent = originalText; chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
    }
    chatTitle.addEventListener('keydown', handler);
  });

  // --- Sidebar ---
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.hidden = false;
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.hidden = true;
  }

  function canOpenSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (sidebar.classList.contains('open')) return false;
    if (sessionLoadingOverlay && !sessionLoadingOverlay.hidden) return false;
    if (!chatMain || !target || !chatMain.contains(target)) return false;
    if (!app.hidden && target && target.closest('input, textarea, select, button, .modal-panel, .settings-panel, .option-picker, .cmd-menu')) {
      return false;
    }
    return true;
  }

  function canCloseSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (!sidebar.classList.contains('open')) return false;
    if (!target) return false;
    if (target.closest('#session-list')) return false;
    return sidebar.contains(target) || target === sidebarOverlay;
  }

  function handleSidebarSwipeStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (canCloseSidebarBySwipe(e.target)) {
      sidebarSwipe = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: true,
        mode: 'close',
      };
      return;
    }
    if (!canOpenSidebarBySwipe(e.target)) {
      sidebarSwipe = null;
      return;
    }
    sidebarSwipe = {
      startX: touch.clientX,
      startY: touch.clientY,
      active: true,
      mode: 'open',
    };
  }

  function handleSidebarSwipeMove(e) {
    if (!sidebarSwipe?.active || !e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - sidebarSwipe.startX;
    const deltaY = touch.clientY - sidebarSwipe.startY;
    if (Math.abs(deltaY) > SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT && Math.abs(deltaY) > Math.abs(deltaX)) {
      sidebarSwipe = null;
      return;
    }
    const horizontalIntent = sidebarSwipe.mode === 'open' ? deltaX > 12 : deltaX < -12;
    if (horizontalIntent && Math.abs(deltaY) < SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT) {
      e.preventDefault();
    }
  }

  function handleSidebarSwipeEnd(e) {
    if (!sidebarSwipe?.active) return;
    const touch = e.changedTouches && e.changedTouches[0];
    const endX = touch ? touch.clientX : sidebarSwipe.startX;
    const endY = touch ? touch.clientY : sidebarSwipe.startY;
    const deltaX = endX - sidebarSwipe.startX;
    const deltaY = endY - sidebarSwipe.startY;
    const shouldOpen = sidebarSwipe.mode === 'open' &&
      deltaX >= SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    const shouldClose = sidebarSwipe.mode === 'close' &&
      deltaX <= -SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    sidebarSwipe = null;
    if (shouldOpen) {
      openSidebar();
    } else if (shouldClose) {
      closeSidebar();
    }
  }

  function handleSidebarResizeStart(e) {
    if (!canResizeSidebar()) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    sidebarResizeState = {
      startX: e.clientX,
      startWidth: sidebar.getBoundingClientRect().width,
    };
    document.body.classList.add('sidebar-resizing');
    if (typeof sidebarResizer?.setPointerCapture === 'function' && e.pointerId !== undefined) {
      sidebarResizer.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
  }

  function handleSidebarResizeMove(e) {
    if (!sidebarResizeState) return;
    const deltaX = e.clientX - sidebarResizeState.startX;
    applySidebarWidth(sidebarResizeState.startWidth + deltaX, { skipPersist: true });
  }

  function handleSidebarResizeEnd(e) {
    if (!sidebarResizeState) return;
    const releasedPointerId = e?.pointerId;
    if (typeof sidebarResizer?.releasePointerCapture === 'function' && releasedPointerId !== undefined) {
      try { sidebarResizer.releasePointerCapture(releasedPointerId); } catch {}
    }
    const currentWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10)
      || sidebar.getBoundingClientRect().width
      || SIDEBAR_DEFAULT_WIDTH;
    applySidebarWidth(currentWidth);
    sidebarResizeState = null;
    document.body.classList.remove('sidebar-resizing');
  }

  function handleGitPanelResizeStart(e) {
    if (!gitState.panelOpen || !canResizeGitPanel()) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    gitPanelResizeState = {
      startX: e.clientX,
      startWidth: gitPanelEl.getBoundingClientRect().width,
    };
    document.body.classList.add('git-panel-resizing');
    const resizer = ensureGitPanelResizer();
    if (typeof resizer?.setPointerCapture === 'function' && e.pointerId !== undefined) {
      resizer.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
  }

  function handleGitPanelResizeMove(e) {
    if (!gitPanelResizeState) return;
    const deltaX = gitPanelResizeState.startX - e.clientX;
    applyGitPanelWidth(gitPanelResizeState.startWidth + deltaX, { skipPersist: true });
  }

  function handleGitPanelResizeEnd(e) {
    if (!gitPanelResizeState) return;
    const releasedPointerId = e?.pointerId;
    const resizer = ensureGitPanelResizer();
    if (typeof resizer?.releasePointerCapture === 'function' && releasedPointerId !== undefined) {
      try { resizer.releasePointerCapture(releasedPointerId); } catch {}
    }
    const currentWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--git-panel-width'), 10)
      || gitPanelEl.getBoundingClientRect().width
      || GIT_PANEL_DEFAULT_WIDTH;
    applyGitPanelWidth(currentWidth);
    gitPanelResizeState = null;
    document.body.classList.remove('git-panel-resizing');
  }

  // --- Slash Command Menu ---
  function applySlashCommandSelection(cmd) {
    if (!cmd) return;
    if (cmd === '/model') {
      hideCmdMenu();
      msgInput.value = '';
      showModelPicker();
      return;
    }
    if (cmd === '/mode') {
      hideCmdMenu();
      msgInput.value = '';
      showModePicker();
      return;
    }
    msgInput.value = `${cmd} `;
    hideCmdMenu();
    msgInput.focus();
  }

  function ensureCmdMenuDelegation() {
    if (cmdMenuDelegated) return;
    cmdMenuDelegated = true;
    cmdMenu.addEventListener('click', (event) => {
      const cmdItem = event.target instanceof Element ? event.target.closest('.cmd-item') : null;
      if (!cmdItem || !cmdMenu.contains(cmdItem)) return;
      applySlashCommandSelection(cmdItem.dataset.cmd || '');
    });
  }

  function showCmdMenu(filter) {
    const filtered = SLASH_COMMANDS.filter(c =>
      c.cmd.startsWith(filter) || c.desc.includes(filter.slice(1))
    );
    // Exact match first (fixes /mode vs /model ambiguity)
    filtered.sort((a, b) => (b.cmd === filter ? 1 : 0) - (a.cmd === filter ? 1 : 0));
    if (filtered.length === 0) {
      hideCmdMenu();
      return;
    }
    cmdMenuIndex = 0;
    cmdMenu.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-item${i === 0 ? ' active' : ''}" data-cmd="${escapeHtml(c.cmd)}">
        <span class="cmd-item-cmd">${escapeHtml(c.cmd)}</span>
        <span class="cmd-item-desc">${escapeHtml(c.desc)}</span>
      </div>`
    ).join('');
    cmdMenu.hidden = false;
    ensureCmdMenuDelegation();
  }

  function hideCmdMenu() {
    cmdMenu.hidden = true;
    cmdMenuIndex = -1;
  }

  function navigateCmdMenu(direction) {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (items.length === 0) return;
    items[cmdMenuIndex]?.classList.remove('active');
    cmdMenuIndex = (cmdMenuIndex + direction + items.length) % items.length;
    items[cmdMenuIndex]?.classList.add('active');
  }

  function selectCmdMenuItem() {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (cmdMenuIndex >= 0 && items[cmdMenuIndex]) {
      applySlashCommandSelection(items[cmdMenuIndex].dataset.cmd || '');
    }
  }

  // --- Option Picker (generic) ---
  function showOptionPicker(title, options, currentValue, onSelect) {
    hideOptionPicker();

    const picker = document.createElement('div');
    picker.className = 'option-picker';
    picker.id = 'option-picker';

    picker.innerHTML = `
      <div class="option-picker-title">${escapeHtml(title)}</div>
      <div class="option-picker-list">
        ${options.map(opt => `
          <div class="option-picker-item${opt.value === currentValue ? ' active' : ''}" data-value="${opt.value}">
            <div class="option-picker-item-info">
              <div class="option-picker-item-label">${escapeHtml(opt.label)}</div>
              <div class="option-picker-item-desc">${escapeHtml(opt.desc)}</div>
            </div>
            ${opt.value === currentValue ? '<span class="option-picker-item-check">✓</span>' : ''}
          </div>
        `).join('')}
      </div>
    `;

    const chatMain = document.querySelector('.chat-main');
    chatMain.appendChild(picker);

    const activeItem = picker.querySelector('.option-picker-item.active');
    if (activeItem) {
      requestAnimationFrame(() => activeItem.scrollIntoView({ block: 'nearest' }));
    }

    picker.querySelectorAll('.option-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        onSelect(el.dataset.value);
        hideOptionPicker();
      });
    });

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', _pickerOutsideClick);
    }, 0);
    document.addEventListener('keydown', _pickerEscape);
  }

  function hideOptionPicker() {
    const picker = document.getElementById('option-picker');
    if (picker) {
      if (picker._keyHandler) document.removeEventListener('keydown', picker._keyHandler);
      picker.remove();
    }
    document.removeEventListener('click', _pickerOutsideClick);
    document.removeEventListener('keydown', _pickerEscape);
  }

  function _pickerOutsideClick(e) {
    const picker = document.getElementById('option-picker');
    if (picker && !picker.contains(e.target)) {
      hideOptionPicker();
    }
  }

  function _pickerEscape(e) {
    if (e.key === 'Escape') {
      hideOptionPicker();
    }
  }

  function showModelPicker() {
    if (sessionState.currentAgent === 'codex') {
      send({ type: 'message', text: '/model', sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
      return;
    }
    // Request real model list from server — server responds with model_list event
    send({ type: 'message', text: '/model', sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
  }

  function showClaudeModelPicker(menuEntries, models, currentAlias, currentFull) {
    hideOptionPicker();

    const picker = document.createElement('div');
    picker.className = 'option-picker model-picker-claude';
    picker.id = 'option-picker';

    // Determine which entry is currently active
    let activeAlias = 'default';
    if (currentFull) {
      const fullToAlias = {};
      if (models.opus) fullToAlias[models.opus] = 'opus';
      if (models.sonnet) fullToAlias[models.sonnet] = 'sonnet';
      if (models.haiku) fullToAlias[models.haiku] = 'haiku';
      activeAlias = fullToAlias[currentFull] || currentAlias || currentFull;
    } else if (currentAlias && currentAlias !== 'default' && currentAlias !== '') {
      activeAlias = currentAlias;
    }

    const entries = (Array.isArray(menuEntries) && menuEntries.length > 0)
      ? menuEntries.map((entry) => Object.assign({}, entry, { value: entry.value || entry.alias }))
      : CLAUDE_MODEL_ENTRIES.map((entry) => Object.assign({}, entry));

    // If current model isn't in the list, add it
    const isStandard = entries.some((e) => e.alias === activeAlias || (currentFull && (e.value || e.alias) === currentFull));
    if (!isStandard && currentFull) {
      entries.push({
        alias: currentAlias || currentFull,
        value: currentFull,
        label: currentAlias || currentFull,
        desc: currentFull,
        pricing: '',
      });
    }

    let focusIdx = entries.findIndex((e) => e.alias === activeAlias || (currentFull && (e.value || e.alias) === currentFull));
    if (focusIdx < 0) focusIdx = 0;

    // Build items HTML
    const itemsHtml = entries.map((e, i) => {
      const itemValue = e.value || e.alias;
      const isCurrent = e.alias === activeAlias || (currentFull && itemValue === currentFull);
      const isFocused = i === focusIdx;
      const descText = e.desc + (e.pricing ? ' \u00b7 ' + e.pricing : '');
      return `
        <div class="option-picker-item${isCurrent ? ' active' : ''}${isFocused ? ' focused' : ''}" data-value="${escapeHtml(itemValue)}" data-index="${i}">
          <span class="mp-cursor">${isFocused ? '\u276f' : '\u2003'}</span>
          <span class="mp-num">${i + 1}.</span>
          <div class="option-picker-item-info">
            <div class="option-picker-item-label">${escapeHtml(e.label)}${isCurrent ? ' <span class="mp-check">\u2714</span>' : ''}</div>
            <div class="option-picker-item-desc">${escapeHtml(descText)}</div>
          </div>
        </div>
      `;
    }).join('');

    picker.innerHTML = `
      <div class="mp-header">
        <div class="option-picker-title">选择模型</div>
        <div class="mp-subtitle">切换当前会话使用的 Claude 模型。<br>如果要指定其他或旧版模型名，请使用 <code>--model</code>。</div>
      </div>
      <div class="mp-items">${itemsHtml}</div>
      <div class="mp-custom">
        <input type="text" id="model-custom-input" class="mp-custom-input" placeholder="输入自定义模型 ID，例如 claude-sonnet-4-6">
      </div>
      <div class="mp-hint">回车确认 \u00b7 Esc 关闭</div>
    `;

    const chatMain = document.querySelector('.chat-main');
    chatMain.appendChild(picker);
    const itemsContainer = picker.querySelector('.mp-items');

    function scrollFocusedItemIntoView() {
      const activeEl = picker.querySelector(`.option-picker-item[data-index="${focusIdx}"]`);
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    // Update focus indicators without full re-render
    function updateFocus(newIdx) {
      focusIdx = newIdx;
      picker.querySelectorAll('.option-picker-item').forEach((el, i) => {
        el.classList.toggle('focused', i === focusIdx);
        const cur = el.querySelector('.mp-cursor');
        if (cur) cur.textContent = i === focusIdx ? '\u276f' : '\u2003';
      });
      if (itemsContainer) scrollFocusedItemIntoView();
    }

    // Click & hover on items
    picker.querySelectorAll('.option-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        send({ type: 'message', text: `/model ${el.dataset.value}`, sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
        hideOptionPicker();
      });
      el.addEventListener('mouseenter', () => updateFocus(parseInt(el.dataset.index)));
    });

    // Keyboard navigation
    function handleKeyDown(e) {
      const customInput = picker.querySelector('#model-custom-input');
      if (document.activeElement === customInput) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = customInput.value.trim();
          if (val) {
            send({ type: 'message', text: `/model ${val}`, sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
            hideOptionPicker();
          }
        } else if (e.key === 'Escape') {
          hideOptionPicker();
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        updateFocus((focusIdx + 1) % entries.length);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        updateFocus((focusIdx - 1 + entries.length) % entries.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        send({ type: 'message', text: `/model ${entries[focusIdx].value || entries[focusIdx].alias}`, sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
        hideOptionPicker();
      } else if (e.key === 'Escape') {
        hideOptionPicker();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < entries.length) {
          e.preventDefault();
          updateFocus(idx);
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    picker._keyHandler = handleKeyDown;

    requestAnimationFrame(() => {
      if (itemsContainer) scrollFocusedItemIntoView();
    });

    setTimeout(() => {
      document.addEventListener('click', _pickerOutsideClick);
    }, 0);
  }

  function showModePicker() {
    showOptionPicker('选择权限模式', MODE_PICKER_OPTIONS, sessionState.currentMode, (value) => {
      sessionState.currentMode = value;
      modeSelect.value = sessionState.currentMode;
      localStorage.setItem(getAgentModeStorageKey(sessionState.currentAgent), sessionState.currentMode);
      if (sessionState.currentSessionId) {
        send({ type: 'set_mode', sessionId: sessionState.currentSessionId, mode: sessionState.currentMode });
      }
      updateAgentScopedUI();
      renderWorkspaceInsights();
    });
  }

  // --- Send Message ---
  function sendMessage() {
    const text = msgInput.value.trim();
    const isPlanModeActive = sessionState.currentMode === 'plan' && sessionState.currentAgent === 'claude';
    if ((!text && composeState.pendingAttachments.length === 0) || isBlockingSessionLoad()) return;
    if (composeState.isGenerating && !isPlanModeActive) return;
    hideCmdMenu();
    hideOptionPicker();

    // Slash commands: don't show as user bubble
    if (text.startsWith('/')) {
      if (composeState.pendingAttachments.length > 0) {
        appendError('命令消息暂不支持附带图片，请先移除图片或发送普通消息。');
        return;
      }
      // /model without argument → show interactive picker
      if (text === '/model' || text === '/model ') {
        showModelPicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      // /mode without argument → show interactive picker
      if (text === '/mode' || text === '/mode ') {
        showModePicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      send({ type: 'message', text, sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
      msgInput.value = '';
      autoResize();
      return;
    }

    // Regular message
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const attachments = composeState.pendingAttachments.map((attachment) => ({ ...attachment }));
    messagesDiv.appendChild(createMsgElement('user', text, attachments));
    scrollToBottom();

    send({ type: 'message', text, attachments, sessionId: sessionState.currentSessionId, mode: sessionState.currentMode, agent: sessionState.currentAgent });
    msgInput.value = '';
    composeState.pendingAttachments = [];
    renderPendingAttachments();
    autoResize();
    if (!composeState.isGenerating) startGenerating();
  }

  function autoResize() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, cachedInputMaxHeight) + 'px';
  }

  function isMobileInputMode() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  // --- Event Listeners ---
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = loginPassword.value;
    if (!pw) return;
    pendingAuthPassword = pw;
    loginError.hidden = true;
    send({ type: 'auth', password: pw });
    // Request notification permission on first user interaction
    requestNotificationPermission();
  });
  if (rememberPw) {
    rememberPw.addEventListener('change', () => {
      if (!rememberPw.checked) clearRememberedPassword();
    });
  }

  menuBtn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  sidebarOverlay.addEventListener('click', closeSidebar);
  if (sidebarResizer) {
    sidebarResizer.addEventListener('pointerdown', handleSidebarResizeStart);
    sidebarResizer.addEventListener('dblclick', () => applySidebarWidth(SIDEBAR_DEFAULT_WIDTH));
    window.addEventListener('pointermove', handleSidebarResizeMove);
    window.addEventListener('pointerup', handleSidebarResizeEnd);
    window.addEventListener('pointercancel', handleSidebarResizeEnd);
  }
  const gitPanelResizer = ensureGitPanelResizer();
  if (gitPanelResizer) {
    gitPanelResizer.addEventListener('pointerdown', handleGitPanelResizeStart);
    gitPanelResizer.addEventListener('dblclick', () => applyGitPanelWidth(GIT_PANEL_DEFAULT_WIDTH));
    window.addEventListener('pointermove', handleGitPanelResizeMove);
    window.addEventListener('pointerup', handleGitPanelResizeEnd);
    window.addEventListener('pointercancel', handleGitPanelResizeEnd);
  }
  document.addEventListener('touchstart', handleSidebarSwipeStart, { passive: true });
  document.addEventListener('touchmove', handleSidebarSwipeMove, { passive: false });
  document.addEventListener('touchend', handleSidebarSwipeEnd, { passive: true });
  document.addEventListener('touchcancel', () => { sidebarSwipe = null; }, { passive: true });

  // Agent tabs
  document.querySelectorAll('.agent-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetAgent = normalizeAgent(btn.dataset.agent);
      handleAgentSelectionChange(targetAgent);
    });
  });

  // Mobile agent select
  const mobileAgentSelect = document.getElementById('mobile-agent-select');
  const mobileModeSelect = document.getElementById('mobile-mode-select');
  if (mobileAgentSelect) {
    mobileAgentSelect.addEventListener('change', () => {
      const targetAgent = normalizeAgent(mobileAgentSelect.value);
      handleAgentSelectionChange(targetAgent);
    });
  }
  if (mobileModeSelect) {
    mobileModeSelect.addEventListener('change', () => {
      const mode = mobileModeSelect.value;
      sessionState.currentMode = mode;
      modeSelect.value = mode;
      localStorage.setItem(getAgentModeStorageKey(sessionState.currentAgent), sessionState.currentMode);
      updateAgentScopedUI();
      if (sessionState.currentSessionId) send({ type: 'set_mode', sessionId: sessionState.currentSessionId, mode: sessionState.currentMode });
      renderWorkspaceInsights();
    });
  }

  function handleWorkspaceActionClick(actionBtn, event) {
    if (!actionBtn) return;
    event.preventDefault();
    const action = actionBtn.dataset.workspaceAction;
    if (action === 'new-session') {
      showNewSessionModal();
      return;
    }
    if (action === 'import-session') {
      if (selectedAgent === 'codex') {
        showImportCodexSessionModal();
      } else {
        showImportSessionModal();
      }
      return;
    }
    if (action === 'switch-model') {
      showModelPicker();
      return;
    }
    if (action === 'switch-mode') {
      showModePicker();
      return;
    }
    if (action === 'open-settings') {
      showSettingsPanel();
      return;
    }
    if (action === 'focus-project' && actionBtn.dataset.projectId) {
      focusProjectGroup(actionBtn.dataset.projectId, { toast: '已定位到当前项目。' });
      return;
    }
    if (action === 'refresh-git') {
      requestGitStatus();
      return;
    }
    if (action === 'show-git-diff') {
      showGitDiffModal();
      return;
    }
    if (action === 'show-git-staged-diff') {
      showGitDiffModal({ staged: true });
      return;
    }
    if (action === 'show-git-log') {
      showGitLogModal();
      return;
    }
    if (action === 'git-add-all') {
      performGitAdd('.');
      return;
    }
    if (action === 'git-commit') {
      showGitCommitModal();
      return;
    }
    if (action === 'git-checkout') {
      showGitBranchPicker();
      return;
    }
    if (action === 'git-create-branch') {
      promptCreateGitBranch();
      return;
    }
  }

  function handleGlobalDocumentClick(event) {
    const target = event.target;

    // Git panel toggle button
    if (target instanceof Element && (target === gitPanelBtn || target.closest('#git-panel-btn'))) {
      toggleGitPanel();
      return;
    }
    // Git panel close button
    if (target instanceof Element && (target.id === 'git-panel-close' || target.closest('#git-panel-close'))) {
      closeGitPanel();
      return;
    }
    // Git panel tab switching
    const gitTab = target instanceof Element ? target.closest('[data-git-view]') : null;
    if (gitTab && gitPanelEl?.contains(gitTab)) {
      event.preventDefault();
      const newView = gitTab.dataset.gitView;
      gitState.activePanelView = newView;
      renderGitPanel();
      if (newView === 'log' && !gitState.panelLogEntries.length) {
        showGitLogModal();
      } else if (newView === 'diff' && !gitState.panelDiffContent) {
        showGitDiffModal();
      }
      return;
    }

    const gitBtn = target instanceof Element ? target.closest('[data-git-action]') : null;
    if (gitBtn) {
      event.preventDefault();
      const gitAction = gitBtn.dataset.gitAction;
      const gitFile = gitBtn.dataset.gitFile || '';
      const gitStaged = gitBtn.dataset.gitStaged === '1';
      if (gitAction === 'show-diff') {
        showGitDiffModal({ file: gitFile, staged: gitStaged });
        return;
      }
      if (gitAction === 'add') {
        performGitAdd(gitFile || '.');
        return;
      }
      if (gitAction === 'expand-files') {
        gitState.filesExpanded = true;
        renderGitPanel();
        renderWorkspaceInsights();
        return;
      }
      if (gitAction === 'toggle-tree-node') {
        const nodeKey = gitBtn.dataset.gitNode || '';
        const collapsed = new Set(Array.isArray(gitState.collapsedTreeNodes) ? gitState.collapsedTreeNodes : []);
        if (collapsed.has(nodeKey)) {
          collapsed.delete(nodeKey);
        } else {
          collapsed.add(nodeKey);
        }
        gitState.collapsedTreeNodes = [...collapsed];
        renderGitPanel();
        return;
      }
    }
    const actionBtn = target instanceof Element ? target.closest('[data-workspace-action]') : null;
    handleWorkspaceActionClick(actionBtn, event);

    if (!newChatDropdown.hidden &&
        !newChatDropdown.contains(target) &&
        target !== newChatArrow) {
      newChatDropdown.hidden = true;
    }

    if (!cmdMenu.contains(target) && target !== msgInput) {
      hideCmdMenu();
    }
  }

  document.addEventListener('click', handleGlobalDocumentClick);

  // Split new-chat button
  newChatBtn.addEventListener('click', () => showNewSessionModal());
  newChatArrow.addEventListener('click', (e) => {
    e.stopPropagation();
    newChatDropdown.hidden = !newChatDropdown.hidden;
  });
  importSessionBtn.addEventListener('click', () => {
    newChatDropdown.hidden = true;
    if (selectedAgent === 'codex') {
      showImportCodexSessionModal();
    } else {
      showImportSessionModal();
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => send({ type: 'abort' }));
  if (attachBtn && imageUploadInput) {
    attachBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', () => {
      handleSelectedImageFiles(imageUploadInput.files);
    });
  }
  if (inputWrapper) {
    inputWrapper.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      inputWrapper.classList.add('drag-active');
    });
    inputWrapper.addEventListener('dragleave', (e) => {
      if (e.target === inputWrapper) inputWrapper.classList.remove('drag-active');
    });
    inputWrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      inputWrapper.classList.remove('drag-active');
      handleSelectedImageFiles(e.dataTransfer?.files);
    });
  }

  // Mode selector (hidden select kept for legacy sync)
  modeSelect.value = sessionState.currentMode;
  // Sync mode-tabs initial state
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === sessionState.currentMode));
  // Mode tabs click
  document.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      sessionState.currentMode = mode;
      modeSelect.value = mode;
      localStorage.setItem(getAgentModeStorageKey(sessionState.currentAgent), sessionState.currentMode);
      updateAgentScopedUI();
      if (sessionState.currentSessionId) {
        send({ type: 'set_mode', sessionId: sessionState.currentSessionId, mode: sessionState.currentMode });
      }
      renderWorkspaceInsights();
    });
  });
  modeSelect.addEventListener('change', () => {
    sessionState.currentMode = modeSelect.value;
    localStorage.setItem(getAgentModeStorageKey(sessionState.currentAgent), sessionState.currentMode);
    updateAgentScopedUI();
    if (sessionState.currentSessionId) {
      send({ type: 'set_mode', sessionId: sessionState.currentSessionId, mode: sessionState.currentMode });
    }
    renderWorkspaceInsights();
  });

  msgInput.addEventListener('input', () => {
    autoResize();
    const val = msgInput.value;
    // Show slash command menu
    if (val.startsWith('/') && !val.includes('\n')) {
      showCmdMenu(val);
    } else {
      hideCmdMenu();
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    // Command menu navigation
    if (!cmdMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateCmdMenu(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateCmdMenu(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); selectCmdMenuItem(); return; }
      if (e.key === 'Escape') { hideCmdMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isMobileInputMode()) {
        if (!cmdMenu.hidden) {
          e.preventDefault();
          selectCmdMenuItem();
        }
        return;
      }

      if (!cmdMenu.hidden) {
        e.preventDefault();
        // If menu is open and user presses Enter, select the item
        selectCmdMenuItem();
      } else if (e.ctrlKey) {
        e.preventDefault();
        sendMessage();
      }
    }
  });

  msgInput.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file' && /^image\//.test(item.type || ''))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      handleSelectedImageFiles(files);
    }
  });

  // --- Toast Notification ---
  function consumeToastQueue() {
    if (activeToast || toastQueue.length === 0) return;
    const next = toastQueue.shift();
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = next.text;

    const closeToast = () => {
      if (!activeToast || activeToast.element !== toast) return;
      clearTimeout(activeToast.hideTimer);
      toast.classList.remove('show');
      activeToast.removeTimer = setTimeout(() => {
        toast.remove();
        activeToast = null;
        consumeToastQueue();
      }, 300);
    };

    if (next.sessionId) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        openSession(next.sessionId);
        closeToast();
      });
    }

    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    const hideTimer = setTimeout(closeToast, 5000);
    activeToast = {
      element: toast,
      hideTimer,
      removeTimer: null,
    };
  }

  function showToast(text, sessionId) {
    if (!text) return;
    toastQueue.push({ text: String(text), sessionId: sessionId || null });
    consumeToastQueue();
  }

  // --- Browser Notification (via Service Worker for mobile) ---
  function showBrowserNotification(title) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('Webcoding', {
          body: `「${title}」任务完成`,
          tag: 'webcoding-task',
          renotify: true,
        });
      }).catch((error) => {
        console.warn('[notify] failed to show notification', error);
      });
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      const result = Notification.requestPermission();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn('[notify] request permission failed', error);
        });
      }
    }
  }

  // --- Settings Panel ---
  let _onCodexSessions = null;

  function renderFetchModelsResult(fetchStatus, datalist, result) {
    if (result.success) {
      datalist.innerHTML = (result.models || []).map((model) => `<option value="${escapeHtml(model)}">`).join('');
      fetchStatus.textContent = result.message || `获取到 ${result.models.length} 个模型`;
      fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
      return;
    }
    fetchStatus.textContent = result.message || '获取失败';
    fetchStatus.style.color = 'var(--text-error, #e85d5d)';
  }

  const settingsBtn = $('#settings-btn');

  const PROVIDER_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'pushplus', label: 'PushPlus' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'feishu', label: '飞书机器人' },
    { value: 'qqbot', label: 'QQ（Qmsg）' },
  ];

  function buildUnifiedSettingsPanelHtml(providerOptions) {
    return `
      <h3>
        ⚙ 系统设置
        <button class="settings-close" title="关闭">&times;</button>
      </h3>

      <div class="settings-section-title">代理渠道</div>
      <div class="settings-field">
        <label>Claude 渠道</label>
        <select class="settings-select" id="unified-claude-mode"></select>
      </div>
      <div class="settings-field">
        <label>Codex 渠道</label>
        <select class="settings-select" id="unified-codex-mode"></select>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">AI 提供商</div>
      <div id="unified-template-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="unified-save-btn">保存渠道配置</button>
      </div>
      <div class="settings-status" id="unified-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">通知设置</div>
      <div class="settings-field">
        <label>通知方式</label>
        <select class="settings-select" id="notify-provider">
          ${providerOptions.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div id="notify-fields"></div>
      <div class="settings-actions">
        <button class="btn-test" id="notify-test-btn">测试</button>
        <button class="btn-save" id="notify-save-btn">保存</button>
      </div>
      <div class="settings-status" id="notify-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">界面主题</div>
      <div class="settings-field">
        <label>配色方案</label>
        <select class="settings-select" id="theme-select">
          <option value="default">默认主题</option>
          <option value="localhost">极简主题</option>
        </select>
      </div>
      <div class="settings-inline-note">切换工作台外观，不影响功能或会话数据。</div>
      <div class="settings-status" id="theme-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">系统</div>
      <div class="settings-actions" style="margin-top:0;flex-wrap:wrap;gap:10px">
        <button class="btn-test" id="pw-open-modal-btn" style="padding:6px 16px">修改密码</button>
        <button class="btn-test" id="check-update-btn" style="padding:6px 16px">检查更新</button>
      </div>
      <div class="settings-status" id="update-status" style="margin-top:8px"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">远程访问 (Cloudflare Tunnel)</div>
      <div id="tunnel-panel-content">
        <div class="settings-status" id="tunnel-install-status" style="margin-bottom:8px"></div>
        <div class="settings-actions" style="margin-top:0;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn-save" id="tunnel-install-btn" style="padding:6px 16px;display:none">一键安装 cloudflared</button>
          <button class="btn-save" id="tunnel-start-btn" style="padding:6px 16px;display:none">开启 Tunnel</button>
          <button class="btn-test" id="tunnel-stop-btn" style="padding:6px 16px;display:none">关闭 Tunnel</button>
        </div>
        <div class="settings-status" id="tunnel-status" style="margin-top:8px"></div>
        <div id="tunnel-qr-area" style="margin-top:12px;display:none;text-align:center">
          <div id="tunnel-qr-canvas" style="display:inline-block;padding:10px;background:#fff;border-radius:8px"></div>
          <div style="font-size:11px;color:var(--text-secondary,#888);margin-top:6px">扫码访问</div>
        </div>
      </div>
    `;
  }

  function buildUnifiedTemplateModalHtml(current, draft) {
    return `
      <div class="settings-header">
        <h3>${current ? `编辑提供商: ${escapeHtml(current.name)}` : '新建 AI 提供商'}</h3>
        <button class="settings-close" id="unified-template-modal-close">&times;</button>
      </div>
      <div class="settings-field">
        <label>提供商名称</label>
        <input type="text" id="unified-template-name" value="${escapeHtml(draft.name || '')}">
      </div>
      <div class="settings-field">
        <label>API Key</label>
        <input type="text" id="unified-template-apikey" placeholder="sk-..." value="${escapeHtml(draft.apiKey || '')}">
      </div>
      <div class="settings-field">
        <label>API Base URL</label>
        <input type="text" id="unified-template-apibase" placeholder="https://api.openai.com/v1" value="${escapeHtml(draft.apiBase || '')}">
      </div>
      <div class="settings-field">
        <label>上游协议</label>
        <select class="settings-select" id="unified-template-upstream-type">
          <option value="openai" ${draft.upstreamType === 'anthropic' ? '' : 'selected'}>OpenAI / Responses</option>
          <option value="anthropic" ${draft.upstreamType === 'anthropic' ? 'selected' : ''}>Anthropic / Messages</option>
        </select>
      </div>

      <div class="settings-divider" style="margin:12px 0"></div>

      <div class="settings-field">
        <div class="tpl-fetch-toolbar">
          <div class="tpl-fetch-toolbar-title">获取上游模型列表</div>
          <button class="btn-test tpl-fetch-toolbar-btn" id="unified-template-fetch-models">获取模型</button>
          <span id="unified-template-fetch-status" class="tpl-fetch-toolbar-status"></span>
        </div>
      </div>

      <div class="settings-divider" style="margin:12px 0"></div>

      <div class="settings-field">
        <label>默认模型</label>
        <input type="text" id="unified-template-default" list="unified-template-models" placeholder="例如 claude-sonnet-4-6 / gpt-5.4 / gemini-2.5-pro" value="${escapeHtml(draft.defaultModel || '')}" autocomplete="off">
      </div>
      <div class="settings-field">
        <label>Opus 模型名</label>
        <input type="text" id="unified-template-opus" list="unified-template-models" placeholder="claude-opus-4-6" value="${escapeHtml(draft.opusModel || '')}" autocomplete="off">
      </div>
      <div class="settings-field">
        <label>Sonnet 模型名</label>
        <input type="text" id="unified-template-sonnet" list="unified-template-models" placeholder="claude-sonnet-4-6" value="${escapeHtml(draft.sonnetModel || '')}" autocomplete="off">
      </div>
      <div class="settings-field">
        <label>Haiku 模型名</label>
        <input type="text" id="unified-template-haiku" list="unified-template-models" placeholder="claude-haiku-4-5" value="${escapeHtml(draft.haikuModel || '')}" autocomplete="off">
      </div>
      <datalist id="unified-template-models"></datalist>
      <div class="settings-inline-note">
        这套 AI 提供商配置会出现在 Claude 和 Codex 的渠道下拉框里。Codex 主要使用 API Key、API Base URL 和“默认模型”；Claude 还会读取 Opus / Sonnet / Haiku 这三个模型映射。
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="unified-template-ok">确定</button>
      </div>
    `;
  }

  function buildPasswordModalHtml() {
    return `
      <div class="settings-header">
        <h3>修改密码</h3>
        <button class="settings-close" id="pw-modal-close">&times;</button>
      </div>
      <div class="settings-field">
        <label>当前密码</label>
        <input type="password" id="pw-modal-current" placeholder="输入当前密码" autocomplete="current-password">
      </div>
      <div class="settings-field">
        <label>新密码</label>
        <input type="password" id="pw-modal-new" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="pw-modal-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
      </div>
      <div class="settings-field">
        <label>确认新密码</label>
        <input type="password" id="pw-modal-confirm" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="pw-modal-submit" disabled>修改密码</button>
      </div>
      <div class="settings-status" id="pw-modal-status"></div>
    `;
  }

  function showUnifiedSettingsPanel() {
    clearSettingsPanelSubscriptions();
    const { overlay, panel } = createOverlayPanel({
      overlayId: 'settings-overlay',
      panelHtml: buildUnifiedSettingsPanelHtml(PROVIDER_OPTIONS),
    });

    const closeBtn = panel.querySelector('.settings-close');
    const claudeModeSelect = panel.querySelector('#unified-claude-mode');
    const codexModeSelect = panel.querySelector('#unified-codex-mode');
    const templateArea = panel.querySelector('#unified-template-area');
    const unifiedSaveBtn = panel.querySelector('#unified-save-btn');
    const unifiedStatusDiv = panel.querySelector('#unified-status');

    const providerSelect = panel.querySelector('#notify-provider');
    const fieldsDiv = panel.querySelector('#notify-fields');
    const notifyStatusDiv = panel.querySelector('#notify-status');
    const testBtn = panel.querySelector('#notify-test-btn');
    const saveBtn = panel.querySelector('#notify-save-btn');

    const themeSelect = panel.querySelector('#theme-select');
    const themeStatusDiv = panel.querySelector('#theme-status');

    const pwOpenModalBtn = panel.querySelector('#pw-open-modal-btn');
    const checkUpdateBtn = panel.querySelector('#check-update-btn');
    const updateStatusEl = panel.querySelector('#update-status');

    const tunnelInstallBtn = panel.querySelector('#tunnel-install-btn');
    const tunnelStartBtn = panel.querySelector('#tunnel-start-btn');
    const tunnelStopBtn = panel.querySelector('#tunnel-stop-btn');
    const tunnelStatusEl = panel.querySelector('#tunnel-status');
    const tunnelInstallStatusEl = panel.querySelector('#tunnel-install-status');
    const tunnelQrArea = panel.querySelector('#tunnel-qr-area');
    const tunnelQrCanvas = panel.querySelector('#tunnel-qr-canvas');

    function drawQrCode(url) {
      tunnelQrCanvas.innerHTML = '';
      try {
        if (typeof QRCode === 'undefined') throw new Error('QRCode not loaded');
        new QRCode(tunnelQrCanvas, {
          text: url,
          width: 160,
          height: 160,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        tunnelQrArea.style.display = 'block';
      } catch (e) {
        console.error('[tunnel] QR generation failed:', e);
        tunnelQrArea.style.display = 'none';
      }
    }

    function applyTunnelStatus({ running, url, installed }) {
      tunnelInstallBtn.style.display = (!installed) ? '' : 'none';
      tunnelStartBtn.style.display = (installed && !running) ? '' : 'none';
      tunnelStopBtn.style.display = (installed && running) ? '' : 'none';

      if (!installed) {
        tunnelInstallStatusEl.textContent = 'cloudflared 未安装，点击下方按钮自动安装（约 30-50 MB）';
        tunnelInstallStatusEl.className = 'settings-status';
        tunnelStatusEl.textContent = '';
        tunnelQrArea.style.display = 'none';
      } else if (running) {
        tunnelInstallStatusEl.textContent = '';
        if (url) {
          tunnelStatusEl.innerHTML = '<div style="margin-top:4px"><div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">公网地址</div><div style="display:flex;align-items:stretch;border:2px solid var(--line)"><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" style="flex:1;min-width:0;font-size:11px;word-break:break-all;padding:6px 8px;background:var(--bg-secondary);color:var(--text-primary);font-family:var(--font-mono)">' + escapeHtml(url) + '</a><button id="tunnel-copy-btn">复制</button></div></div>';
          tunnelStatusEl.className = 'settings-status';
          const copyBtn = tunnelStatusEl.querySelector('#tunnel-copy-btn');
          if (copyBtn) copyBtn.addEventListener('click', () => { navigator.clipboard?.writeText(url); copyBtn.textContent = '已复制'; setTimeout(() => { copyBtn.textContent = '复制'; }, 2000); });
          drawQrCode(url);
        } else {
          tunnelStatusEl.textContent = '正在获取公网 URL...';
          tunnelStatusEl.className = 'settings-status';
          tunnelQrArea.style.display = 'none';
        }
      } else {
        tunnelInstallStatusEl.textContent = '';
        tunnelStatusEl.textContent = '';
        tunnelQrArea.style.display = 'none';
      }
    }

    tunnelInstallBtn.addEventListener('click', () => {
      tunnelInstallBtn.disabled = true;
      tunnelInstallStatusEl.textContent = '正在下载安装，请稍候...';
      tunnelInstallStatusEl.className = 'settings-status';
      send({ type: 'install_cloudflared' });
    });
    tunnelStartBtn.addEventListener('click', () => {
      tunnelStartBtn.disabled = true;
      tunnelStatusEl.textContent = '正在启动，请稍候（首次可能需要 30 秒）...';
      tunnelStatusEl.className = 'settings-status';
      send({ type: 'tunnel_start' });
    });
    tunnelStopBtn.addEventListener('click', () => {
      tunnelStopBtn.disabled = true;
      send({ type: 'tunnel_stop' });
    });

    let currentNotifyConfig = null;
    let currentCodexConfig = null;
    let modelConfigLoaded = false;
    let codexConfigLoaded = false;
    let modelEditingTemplates = [];
    let providerEditorSelection = '';
    let selectedClaudeChannel = 'local';
    let selectedCodexChannel = 'local';
    let _onUpdateInfo = null;

    function syncUnifiedControlsState() {
      const ready = modelConfigLoaded && codexConfigLoaded;
      claudeModeSelect.disabled = !ready;
      codexModeSelect.disabled = !ready;
      unifiedSaveBtn.disabled = !ready;
    }

    function applyModelConfigToPanel(config, markLoaded = true) {
      const normalized = config || { mode: 'local', activeTemplate: '', templates: [] };
      if (markLoaded) modelConfigLoaded = true;
      modelEditingTemplates = (normalized.templates || []).map((template) => ({
        ...template,
        originalName: template.originalName || template.name || '',
      }));
      providerEditorSelection = normalized.activeTemplate || providerEditorSelection || (modelEditingTemplates[0]?.name || '');
      selectedClaudeChannel = normalized.mode === 'custom'
        ? (normalized.activeTemplate || modelEditingTemplates[0]?.name || 'local')
        : 'local';
    }

    function applyCodexConfigToPanel(config, markLoaded = true) {
      if (markLoaded) codexConfigLoaded = true;
      currentCodexConfig = config || { mode: 'local', legacyMode: '' };
      selectedCodexChannel = currentCodexConfig.mode === 'unified'
        ? (currentCodexConfig.sharedTemplate || modelEditingTemplates[0]?.name || 'local')
        : 'local';
    }

    function showUnifiedStatus(msg, type) {
      unifiedStatusDiv.textContent = msg;
      unifiedStatusDiv.className = 'settings-status ' + (type || '');
    }

    function showNotifyStatus(msg, type) {
      notifyStatusDiv.textContent = msg;
      notifyStatusDiv.className = 'settings-status ' + (type || '');
    }

    function showThemeStatus(msg, type) {
      themeStatusDiv.textContent = msg;
      themeStatusDiv.className = 'settings-status ' + (type || '');
    }

    function renderFields(provider) {
      renderNotifyFields(fieldsDiv, currentNotifyConfig, provider);
    }

    function collectNotifyConfig() {
      return collectNotifyConfigFromPanel(panel, currentNotifyConfig, providerSelect.value);
    }

    function ensureChannelSelections() {
      if (!modelEditingTemplates.length) {
        providerEditorSelection = '';
        selectedClaudeChannel = 'local';
        selectedCodexChannel = 'local';
        return;
      }

      const names = new Set(modelEditingTemplates.map((template) => template.name));
      if (!names.has(providerEditorSelection)) {
        providerEditorSelection = modelEditingTemplates[0].name;
      }
      if (selectedClaudeChannel !== 'local' && !names.has(selectedClaudeChannel)) {
        selectedClaudeChannel = modelEditingTemplates[0].name;
      }
      if (selectedCodexChannel !== 'local' && !names.has(selectedCodexChannel)) {
        selectedCodexChannel = modelEditingTemplates[0].name;
      }
    }

    function renderAgentChannelOptions() {
      ensureChannelSelections();
      const providerOptions = modelEditingTemplates.map((template) =>
        `<option value="${escapeHtml(template.name)}">${escapeHtml(template.name)}</option>`
      ).join('');
      claudeModeSelect.innerHTML = `
        <option value="local">读取本地 Claude 配置</option>
        ${providerOptions}
      `;
      codexModeSelect.innerHTML = `
        <option value="local">读取本机 Codex 登录态 / ~/.codex/config.toml</option>
        ${providerOptions}
      `;
      claudeModeSelect.value = selectedClaudeChannel;
      codexModeSelect.value = selectedCodexChannel;
    }

    function renderTemplateArea() {
      if (!modelConfigLoaded || !codexConfigLoaded) {
        templateArea.innerHTML = `
          <div class="settings-inline-note">
            正在加载 AI 提供商配置...
          </div>
        `;
        return;
      }

      renderAgentChannelOptions();
      const legacyMode = currentCodexConfig?.legacyMode || '';
      const legacyNote = legacyMode === 'custom'
        ? '检测到旧版 Codex 独立配置。当前页面不再维护那套分叉逻辑；你保存后，Codex 会改为从上面的 AI 提供商列表里单独选渠道。'
        : (legacyMode === 'shared'
          ? '检测到旧版“复用 Claude 配置”模式。当前页面已经改成独立渠道逻辑，保存后 Claude 和 Codex 可以分别选择不同的 AI 提供商。'
          : '');

      if (!modelEditingTemplates.length) {
        templateArea.innerHTML = `
          <div class="settings-inline-note">
            AI 提供商列表为空。只要 Claude 或 Codex 有一个需要走远程接口，就先在这里新建至少一套提供商配置。
          </div>
          ${legacyNote ? `<div class="settings-inline-note warning">${legacyNote}</div>` : ''}
          <div class="settings-actions" style="margin-top:0">
            <button class="btn-test" id="unified-template-add-first">+ 新建提供商</button>
          </div>
        `;
        panel.querySelector('#unified-template-add-first').addEventListener('click', () => openUnifiedTemplateModal());
        return;
      }

      const options = modelEditingTemplates.map((template) =>
        `<option value="${escapeHtml(template.name)}" ${template.name === providerEditorSelection ? 'selected' : ''}>${escapeHtml(template.name)}</option>`
      ).join('');
      templateArea.innerHTML = `
        ${legacyNote ? `<div class="settings-inline-note warning">${legacyNote}</div>` : ''}
        <div class="settings-field">
          <label>提供商列表</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="unified-template-select" style="flex:1">
              ${options}
              <option value="__new__">+ 新建提供商</option>
            </select>
            <button class="btn-test" id="unified-template-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="unified-template-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
      `;

      panel.querySelector('#unified-template-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openUnifiedTemplateModal();
          return;
        }
        providerEditorSelection = e.target.value;
        renderTemplateArea();
      });

      panel.querySelector('#unified-template-edit').addEventListener('click', () => {
        openUnifiedTemplateModal(providerEditorSelection);
      });

      panel.querySelector('#unified-template-del').addEventListener('click', () => {
        if (!providerEditorSelection) return;
        if (!confirm(`确认删除提供商「${providerEditorSelection}」?`)) return;
        modelEditingTemplates = modelEditingTemplates.filter((template) => template.name !== providerEditorSelection);
        providerEditorSelection = modelEditingTemplates[0]?.name || '';
        renderTemplateArea();
      });
    }

    function openUnifiedTemplateModal(templateName = '') {
      const current = templateName
        ? modelEditingTemplates.find((template) => template.name === templateName)
        : null;
      const draft = current || {
        name: '',
        originalName: '',
        apiKey: '',
        apiBase: '',
        upstreamType: 'openai',
        defaultModel: '',
        opusModel: '',
        sonnetModel: '',
        haikuModel: '',
      };

      const { overlay: modalOverlay, panel: modal, close: closeModal } = createOverlayPanel({
        zIndex: '10001',
        maxWidth: '460px',
        panelHtml: buildUnifiedTemplateModalHtml(current, draft),
      });

      const fetchBtn = modal.querySelector('#unified-template-fetch-models');
      const fetchStatus = modal.querySelector('#unified-template-fetch-status');
      const datalist = modal.querySelector('#unified-template-models');
      let disposeFetchModelsResult = null;

      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#unified-template-apibase').value.trim();
        const apiKey = modal.querySelector('#unified-template-apikey').value.trim();
        const upstreamType = modal.querySelector('#unified-template-upstream-type').value;
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';

        if (disposeFetchModelsResult) disposeFetchModelsResult();
        disposeFetchModelsResult = onWsEvent('fetch_models_result', (result) => {
          disposeFetchModelsResult = null;
          fetchBtn.disabled = false;
          renderFetchModelsResult(fetchStatus, datalist, result);
        }, { once: true });

        send({
          type: 'fetch_models',
          apiBase,
          apiKey,
          upstreamType,
          templateName: current?.name || modal.querySelector('#unified-template-name').value.trim(),
        });
      });

      const closeTemplateModal = () => {
        if (disposeFetchModelsResult) {
          disposeFetchModelsResult();
          disposeFetchModelsResult = null;
        }
        closeModal();
      };

      modal.querySelector('#unified-template-modal-close').addEventListener('click', closeTemplateModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeTemplateModal(); });

      modal.querySelector('#unified-template-ok').addEventListener('click', () => {
        const name = modal.querySelector('#unified-template-name').value.trim();
        const apiKey = modal.querySelector('#unified-template-apikey').value.trim();
        const apiBase = modal.querySelector('#unified-template-apibase').value.trim();
        const upstreamType = modal.querySelector('#unified-template-upstream-type').value;
        const defaultModel = modal.querySelector('#unified-template-default').value.trim();
        const opusModel = modal.querySelector('#unified-template-opus').value.trim();
        const sonnetModel = modal.querySelector('#unified-template-sonnet').value.trim();
        const haikuModel = modal.querySelector('#unified-template-haiku').value.trim();

        if (!name) {
          alert('请填写提供商名称');
          return;
        }
        if (!apiKey) {
          alert('请填写 API Key');
          return;
        }
        if (!apiBase) {
          alert('请填写 API Base URL');
          return;
        }

        const existing = modelEditingTemplates.find((template) => template.name === name);
        if (existing && existing !== current) {
          alert('提供商名称已存在');
          return;
        }

        if (current) {
          const previousName = current.name;
          if (!current.originalName) current.originalName = current.name;
          current.name = name;
          current.apiKey = apiKey;
          current.apiBase = apiBase;
          current.upstreamType = upstreamType;
          current.defaultModel = defaultModel;
          current.opusModel = opusModel;
          current.sonnetModel = sonnetModel;
          current.haikuModel = haikuModel;
          if (providerEditorSelection === previousName) providerEditorSelection = name;
          if (selectedClaudeChannel === previousName) selectedClaudeChannel = name;
          if (selectedCodexChannel === previousName) selectedCodexChannel = name;
        } else {
          modelEditingTemplates.push({
            name,
            originalName: '',
            apiKey,
            apiBase,
            upstreamType,
            defaultModel,
            opusModel,
            sonnetModel,
            haikuModel,
          });
          if (!providerEditorSelection) providerEditorSelection = name;
        }

        providerEditorSelection = name;
        closeTemplateModal();
        renderTemplateArea();
      });
    }

    claudeModeSelect.addEventListener('change', () => {
      selectedClaudeChannel = claudeModeSelect.value;
      renderTemplateArea();
    });
    codexModeSelect.addEventListener('change', () => {
      selectedCodexChannel = codexModeSelect.value;
      renderTemplateArea();
    });
    themeSelect.value = getStoredTheme();
    themeSelect.addEventListener('change', () => {
      const nextTheme = applyTheme(themeSelect.value);
      themeSelect.value = nextTheme;
      showThemeStatus(`已切换为 ${THEME_LABELS[nextTheme]}`, 'success');
    });
    providerSelect.addEventListener('change', () => renderFields(providerSelect.value));

    unifiedSaveBtn.addEventListener('click', async () => {
      if (!modelConfigLoaded || !codexConfigLoaded) {
        showUnifiedStatus('正在同步当前配置，请稍后再保存', 'error');
        return;
      }

      ensureChannelSelections();
      const claudeUsesProvider = selectedClaudeChannel !== 'local';
      const codexUsesProvider = selectedCodexChannel !== 'local';
      const needsProvider = claudeUsesProvider || codexUsesProvider;
      if (needsProvider && modelEditingTemplates.length === 0) {
        showUnifiedStatus('至少需要一个 AI 提供商配置', 'error');
        return;
      }

      const claudeTemplate = claudeUsesProvider
        ? modelEditingTemplates.find((template) => template.name === selectedClaudeChannel) || null
        : null;
      const codexTemplate = codexUsesProvider
        ? modelEditingTemplates.find((template) => template.name === selectedCodexChannel) || null
        : null;

      if (claudeUsesProvider && (!claudeTemplate || !claudeTemplate.apiKey || !claudeTemplate.apiBase)) {
        showUnifiedStatus('Claude 选中的 AI 提供商缺少 API Key 或 API Base URL', 'error');
        return;
      }
      if (codexUsesProvider && (!codexTemplate || !codexTemplate.apiKey || !codexTemplate.apiBase)) {
        showUnifiedStatus('Codex 选中的 AI 提供商缺少 API Key 或 API Base URL', 'error');
        return;
      }

      showUnifiedStatus('正在保存...', '');
      const waitModelConfig = waitForWsEvent('model_config', { timeoutMs: 8000 });
      const waitCodexConfig = waitForWsEvent('codex_config', { timeoutMs: 8000 });
      send({
        type: 'save_model_config',
        config: {
          mode: claudeUsesProvider ? 'custom' : 'local',
          activeTemplate: claudeUsesProvider ? selectedClaudeChannel : '',
          templates: modelEditingTemplates,
        },
      });
      send({
        type: 'save_codex_config',
        config: {
          mode: codexUsesProvider ? 'unified' : 'local',
          legacyMode: '',
          sharedTemplate: codexUsesProvider ? selectedCodexChannel : '',
          enableSearch: false,
        },
      });
      try {
        await Promise.all([waitModelConfig, waitCodexConfig]);
        showUnifiedStatus('已保存', 'success');
      } catch (error) {
        showUnifiedStatus(error?.message || '保存失败，请重试', 'error');
      }
    });

    testBtn.addEventListener('click', () => {
      const config = collectNotifyConfig();
      send({ type: 'save_notify_config', config });
      showNotifyStatus('正在发送测试消息...', '');
      send({ type: 'test_notify' });
    });

    saveBtn.addEventListener('click', async () => {
      const config = collectNotifyConfig();
      showNotifyStatus('正在保存...', '');
      const waitNotifyConfig = waitForWsEvent('notify_config', { timeoutMs: 8000 });
      send({ type: 'save_notify_config', config });
      try {
        await waitNotifyConfig;
        showNotifyStatus('已保存', 'success');
      } catch (error) {
        showNotifyStatus(error?.message || '保存失败，请重试', 'error');
      }
    });

    pwOpenModalBtn.addEventListener('click', openPasswordModal);

    checkUpdateBtn.addEventListener('click', () => {
      updateStatusEl.textContent = '正在检查...';
      updateStatusEl.className = 'settings-status';
      _onUpdateInfo = (info) => {
        _onUpdateInfo = null;
        if (info.error) {
          updateStatusEl.textContent = '检查失败: ' + info.error;
          updateStatusEl.className = 'settings-status error';
          return;
        }
        if (info.hasUpdate) {
          updateStatusEl.innerHTML = buildUpdateStatusHtml(info);
          updateStatusEl.className = 'settings-status success';
        } else {
          updateStatusEl.textContent = `已是最新版本 v${info.localVersion}`;
          updateStatusEl.className = 'settings-status success';
        }
      };
      send({ type: 'check_update' });
    });

    registerSettingsPanelHandler('notify_config', (config) => {
      currentNotifyConfig = config;
      providerSelect.value = config.provider || 'off';
      renderFields(config.provider || 'off');
    });

    registerSettingsPanelHandler('notify_test_result', (msg) => {
      showNotifyStatus(msg.message, msg.success ? 'success' : 'error');
    });

    registerSettingsPanelHandler('model_config', (config) => {
      applyModelConfigToPanel(config);
      syncUnifiedControlsState();
      renderTemplateArea();
    });

    registerSettingsPanelHandler('codex_config', (config) => {
      applyCodexConfigToPanel(config);
      syncUnifiedControlsState();
      renderTemplateArea();
    });

    registerSettingsPanelHandler('tunnel_status', (msg) => {
      applyTunnelStatus(msg);
    });

    registerSettingsPanelHandler('tunnel_install_progress', (msg) => {
      if (msg.error) {
        tunnelInstallStatusEl.textContent = '安装失败：' + msg.error;
        tunnelInstallStatusEl.className = 'settings-status error';
        tunnelInstallBtn.disabled = false;
      } else if (msg.done) {
        tunnelInstallStatusEl.textContent = msg.message || '安装完成！';
        tunnelInstallStatusEl.className = 'settings-status success';
        tunnelInstallBtn.disabled = false;
      } else {
        tunnelInstallStatusEl.textContent = msg.message || '安装中...';
        tunnelInstallStatusEl.className = 'settings-status';
      }
    });

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });
    window._ccOnUpdateInfo = (info) => { if (_onUpdateInfo) _onUpdateInfo(info); };
    document.addEventListener('keydown', _settingsEscape);

    if (modelConfigCache) applyModelConfigToPanel(modelConfigCache, false);
    if (codexConfigCache) applyCodexConfigToPanel(codexConfigCache, false);
    syncUnifiedControlsState();
    renderTemplateArea();
    send({ type: 'get_notify_config' });
    send({ type: 'get_model_config' });
    send({ type: 'get_codex_config' });
    send({ type: 'get_tunnel_status' });
  }

  function buildNotifyFieldsHtml(config, provider) {
    if (provider === 'pushplus') {
      return `
        <div class="settings-field">
          <label>Token</label>
          <input type="text" id="notify-pushplus-token" placeholder="PushPlus Token" value="${escapeHtml(config?.pushplus?.token || '')}">
        </div>
      `;
    }
    if (provider === 'telegram') {
      return `
        <div class="settings-field">
          <label>Bot Token</label>
          <input type="text" id="notify-tg-bottoken" placeholder="123456:ABC-DEF..." value="${escapeHtml(config?.telegram?.botToken || '')}">
        </div>
        <div class="settings-field">
          <label>Chat ID</label>
          <input type="text" id="notify-tg-chatid" placeholder="Chat ID" value="${escapeHtml(config?.telegram?.chatId || '')}">
        </div>
      `;
    }
    if (provider === 'serverchan') {
      return `
        <div class="settings-field">
          <label>SendKey</label>
          <input type="text" id="notify-sc-sendkey" placeholder="Server酱 SendKey" value="${escapeHtml(config?.serverchan?.sendKey || '')}">
        </div>
      `;
    }
    if (provider === 'feishu') {
      return `
        <div class="settings-field">
          <label>Webhook 地址</label>
          <input type="text" id="notify-feishu-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value="${escapeHtml(config?.feishu?.webhook || '')}">
        </div>
      `;
    }
    if (provider === 'qqbot') {
      return `
        <div class="settings-field">
          <label>Qmsg Key</label>
          <input type="text" id="notify-qmsg-key" placeholder="Qmsg 推送 Key" value="${escapeHtml(config?.qqbot?.qmsgKey || '')}">
        </div>
      `;
    }
    return '';
  }

  function buildAgentContextCard(agent, title, copy) {
    const label = AGENT_LABELS[normalizeAgent(agent)] || AGENT_LABELS.claude;
    return `
      <div class="agent-context-card">
        <div class="agent-context-kicker">${escapeHtml(label)} Space</div>
        <div class="agent-context-title">${escapeHtml(title)}</div>
        <div class="agent-context-copy">${escapeHtml(copy)}</div>
      </div>
    `;
  }

  function buildImportModalBody(agent, title, copy, extraHtml = '') {
    return `${buildAgentContextCard(agent, title, copy)}${extraHtml}`;
  }

  function createImportSessionsModal({
    overlayId,
    title,
    closeBtnId,
    bodyId,
    agent,
    cardTitle,
    cardCopy,
    loadingText,
    onClose,
  }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = overlayId;
    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(title)}</span>
          <button class="modal-close-btn" id="${escapeHtml(closeBtnId)}">✕</button>
        </div>
        <div class="modal-body" id="${escapeHtml(bodyId)}">
          ${buildImportModalBody(agent, cardTitle, cardCopy, `<div class="modal-loading">${escapeHtml(loadingText)}</div>`)}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const body = overlay.querySelector(`#${bodyId}`);

    function renderBody(extraHtml = '') {
      if (!body) return null;
      body.innerHTML = buildImportModalBody(agent, cardTitle, cardCopy, extraHtml);
      return body;
    }

    function close() {
      overlay.remove();
      if (typeof onClose === 'function') onClose();
    }

    overlay.querySelector(`#${closeBtnId}`)?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    return {
      overlay,
      body,
      close,
      renderBody,
      renderEmpty: (message) => renderBody(`<div class="modal-empty">${escapeHtml(message)}</div>`),
    };
  }

  function renderNotifyFields(fieldsDiv, config, provider) {
    fieldsDiv.innerHTML = buildNotifyFieldsHtml(config, provider);
  }

  function collectNotifyConfigFromPanel(panel, currentConfig, provider) {
    const pp = panel.querySelector('#notify-pushplus-token');
    const tgBot = panel.querySelector('#notify-tg-bottoken');
    const tgChat = panel.querySelector('#notify-tg-chatid');
    const sc = panel.querySelector('#notify-sc-sendkey');
    const feishuWh = panel.querySelector('#notify-feishu-webhook');
    const qmsgKey = panel.querySelector('#notify-qmsg-key');
    return {
      provider,
      pushplus: { token: pp ? pp.value.trim() : (currentConfig?.pushplus?.token || '') },
      telegram: {
        botToken: tgBot ? tgBot.value.trim() : (currentConfig?.telegram?.botToken || ''),
        chatId: tgChat ? tgChat.value.trim() : (currentConfig?.telegram?.chatId || ''),
      },
      serverchan: { sendKey: sc ? sc.value.trim() : (currentConfig?.serverchan?.sendKey || '') },
      feishu: { webhook: feishuWh ? feishuWh.value.trim() : (currentConfig?.feishu?.webhook || '') },
      qqbot: { qmsgKey: qmsgKey ? qmsgKey.value.trim() : (currentConfig?.qqbot?.qmsgKey || '') },
    };
  }

  function openPasswordModal() {
    const { overlay: pwOverlay, panel: pwModal, close: closePwModal } = createOverlayPanel({
      zIndex: '10001',
      maxWidth: '400px',
      panelHtml: buildPasswordModalHtml(),
    });

    const newPwIn = pwModal.querySelector('#pw-modal-new');
    const confirmPwIn = pwModal.querySelector('#pw-modal-confirm');
    const currentPwIn = pwModal.querySelector('#pw-modal-current');
    const hint = pwModal.querySelector('#pw-modal-hint');
    const submitBtn = pwModal.querySelector('#pw-modal-submit');
    const status = pwModal.querySelector('#pw-modal-status');

    function checkPw() {
      const currentPw = currentPwIn.value;
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      
      // Check if current password is entered
      if (!currentPw) {
        submitBtn.disabled = true;
        return;
      }
      
      if (!newPw) {
        hint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hint.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(newPw);
      if (!result.valid) {
        hint.textContent = result.message;
        hint.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hint.textContent = '密码强度符合要求';
      hint.className = 'password-hint success';
      submitBtn.disabled = !confirmPw || confirmPw !== newPw;
    }

    currentPwIn.addEventListener('input', checkPw);
    newPwIn.addEventListener('input', checkPw);
    confirmPwIn.addEventListener('input', checkPw);

    // Password change timeout cleanup
    let pwChangeTimeoutId = null;
    const closePwModalWithCleanup = () => {
      clearTimeout(pwChangeTimeoutId);
      pwChangeTimeoutId = null;
      _onPasswordChanged = null;
      closePwModal();
    };

    pwModal.querySelector('#pw-modal-close').addEventListener('click', closePwModalWithCleanup);
    pwOverlay.addEventListener('click', (e) => { if (e.target === pwOverlay) closePwModalWithCleanup(); });

    submitBtn.addEventListener('click', () => {
      const currentPw = currentPwIn.value;
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      
      if (!currentPw) {
        status.textContent = '请输入当前密码';
        status.className = 'settings-status error';
        return;
      }
      if (newPw !== confirmPw) {
        status.textContent = '两次密码不一致';
        status.className = 'settings-status error';
        return;
      }
      submitBtn.disabled = true;
      status.textContent = '正在修改...';
      status.className = 'settings-status';
      _onPasswordChanged = (result) => {
        clearTimeout(pwChangeTimeoutId);
        pwChangeTimeoutId = null;
        if (result.success) {
          status.textContent = result.message || '密码修改成功';
          status.className = 'settings-status success';
          // Clear password fields on success
          currentPwIn.value = '';
          newPwIn.value = '';
          confirmPwIn.value = '';
          setTimeout(closePwModalWithCleanup, 1200);
        } else {
          status.textContent = result.message || '修改失败';
          status.className = 'settings-status error';
          submitBtn.disabled = false;
        }
      };
      // Timeout cleanup for password change callback
      pwChangeTimeoutId = setTimeout(() => {
        _onPasswordChanged = null;
        pwChangeTimeoutId = null;
        status.textContent = '请求超时，请重试';
        status.className = 'settings-status error';
        submitBtn.disabled = false;
      }, 15000);
      pendingPasswordChangeValue = newPw;
      send({ type: 'change_password', currentPassword: currentPw, newPassword: newPw });
    });

    newPwIn.focus();
  }

  function showSettingsPanel() {
    showUnifiedSettingsPanel();
  }

  function hideSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.remove();
    document.querySelectorAll('.settings-subpage-overlay').forEach((node) => node.remove());
    clearSettingsPanelSubscriptions();
    window._ccOnUpdateInfo = null;
    document.removeEventListener('keydown', _settingsEscape);
  }

  function _settingsEscape(e) {
    if (e.key === 'Escape') hideSettingsPanel();
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', showSettingsPanel);
  }

  // --- Force Change Password ---
  function showForceChangePassword() {
    const overlay = document.createElement('div');
    overlay.className = 'force-change-overlay';
    overlay.id = 'force-change-overlay';

    const panel = document.createElement('div');
    panel.className = 'force-change-panel';

    panel.innerHTML = `
      <div class="login-logo">CC</div>
      <h2>修改初始密码</h2>
      <p>首次登录需要设置新密码</p>
      <div class="force-change-form">
        <input type="password" id="fc-new-pw" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="fc-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
        <input type="password" id="fc-confirm-pw" placeholder="确认新密码" autocomplete="new-password">
        <button id="fc-submit-btn" class="fc-submit-btn" disabled>确认修改</button>
        <div class="fc-status" id="fc-status"></div>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const newPwInput = panel.querySelector('#fc-new-pw');
    const confirmPwInput = panel.querySelector('#fc-confirm-pw');
    const hintEl = panel.querySelector('#fc-hint');
    const submitBtn = panel.querySelector('#fc-submit-btn');
    const statusEl = panel.querySelector('#fc-status');

    function checkStrength() {
      const pw = newPwInput.value;
      const confirmPw = confirmPwInput.value;
      if (!pw) {
        hintEl.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hintEl.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(pw);
      if (!result.valid) {
        hintEl.textContent = result.message;
        hintEl.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hintEl.textContent = '密码强度符合要求';
      hintEl.className = 'password-hint success';
      submitBtn.disabled = !confirmPw || confirmPw !== pw;
    }

    newPwInput.addEventListener('input', checkStrength);
    confirmPwInput.addEventListener('input', checkStrength);

    submitBtn.addEventListener('click', () => {
      const newPw = newPwInput.value;
      const confirmPw = confirmPwInput.value;
      if (newPw !== confirmPw) {
        statusEl.textContent = '两次密码不一致';
        statusEl.className = 'fc-status error';
        return;
      }
      submitBtn.disabled = true;
      statusEl.textContent = '正在修改...';
      statusEl.className = 'fc-status';
      pendingPasswordChangeValue = newPw;
      send({ type: 'change_password', newPassword: newPw });
    });

    newPwInput.focus();
  }

  function hideForceChangePassword() {
    const overlay = document.getElementById('force-change-overlay');
    if (overlay) overlay.remove();
  }

  function clientValidatePassword(pw) {
    if (!pw || pw.length < 8) {
      return { valid: false, message: '密码长度至少 8 位' };
    }
    let types = 0;
    if (/[a-z]/.test(pw)) types++;
    if (/[A-Z]/.test(pw)) types++;
    if (/[0-9]/.test(pw)) types++;
    if (/[^a-zA-Z0-9]/.test(pw)) types++;
    if (types < 2) {
      return { valid: false, message: '需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
    }
    return { valid: true, message: '' };
  }

  // --- Password Changed Handler ---
  let _onPasswordChanged = null;

  function handlePasswordChanged(msg) {
    if (msg.success) {
      if (pendingPasswordChangeValue !== null) {
        if (rememberPw?.checked || hasRememberedPassword()) {
          saveRememberedPassword(pendingPasswordChangeValue);
          if (rememberPw) rememberPw.checked = true;
        }
        pendingPasswordChangeValue = null;
      }
      // Update token
      authToken = msg.token;
      localStorage.setItem('webcoding-token', msg.token);
      // If force-change overlay is open, close it and load sessions
      const fcOverlay = document.getElementById('force-change-overlay');
      if (fcOverlay) {
        hideForceChangePassword();
        restoreInitialSession(selectedAgent);
        showToast('密码修改成功');
      }

      // If settings panel change password
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: true, message: msg.message });
        _onPasswordChanged = null;
      }
    } else {
      // Force-change error
      const fcStatus = document.querySelector('#fc-status');
      if (fcStatus) {
        fcStatus.textContent = msg.message || '修改失败';
        fcStatus.className = 'fc-status error';
        const btn = document.querySelector('#fc-submit-btn');
        if (btn) btn.disabled = false;
      }

      // Settings panel error
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: false, message: msg.message });
        _onPasswordChanged = null;
      }
    }
  }

  function handleForcedLogout(msg) {
    authToken = null;
    localStorage.removeItem('webcoding-token');
    document.dispatchEvent(new CustomEvent('webcoding-auth-failed'));
    if (isGenerating) finishGenerating();
    hideForceChangePassword();
    loginOverlay.hidden = false;
    app.hidden = true;
    restoreRememberedPasswordInput();
    loginError.textContent = msg?.message || '登录状态已失效，请重新登录';
    loginError.hidden = false;
  }

  // --- New Session Modal ---
  let _onCwdSuggestions = null;
  let _onDirectoryListing = null;

  function buildNewSessionModalHtml() {
    return `
      <div class="modal-panel modal-panel-wide modal-panel-project">
        <div class="modal-header">
          <span class="modal-title">新建 / 打开项目</span>
          <button class="modal-close-btn" id="ns-close-btn">\u2715</button>
        </div>
        <div class="modal-body modal-body-project">
          <div class="modal-stack project-flow-shell" id="ns-step-projects" style="display:none">
            <div class="project-picker-head">
              <div class="project-picker-head-copy">
                <label class="modal-field-label">已保存项目</label>
                <div class="project-picker-summary" id="ns-project-summary">这里展示你已经保存的工作目录。</div>
              </div>
              <div class="project-picker-total" id="ns-project-count">0 个项目</div>
            </div>
            <div class="project-picker-list" id="ns-project-list"></div>
            <div class="project-picker-actions">
              <button class="project-picker-action-btn primary" id="ns-open-dir-btn">打开其他目录</button>
            </div>
            <div class="project-picker-helper">点击任意项目会直接创建新会话；选择其他目录时，也会自动加入左侧项目列表。</div>
          </div>

          <div class="modal-stack dir-browser-shell" id="ns-step-browser">
            <div class="dir-browser-current">
              <div class="dir-browser-current-label">当前目录</div>
              <div class="dir-browser-current-name" id="ns-current-name">正在定位…</div>
              <div class="dir-browser-current-path" id="ns-current-path">载入后会在这里显示你当前选中的完整路径。</div>
            </div>
            <div>
              <label class="modal-field-label">工作目录</label>
              <div class="dir-browser-pathbar" id="ns-pathbar">
                <div class="dir-browser-crumbs" id="ns-crumbs"></div>
                <button class="dir-browser-edit-btn" id="ns-edit-path-btn" title="直接输入路径">\u270E</button>
              </div>
              <div class="dir-browser-manual" id="ns-manual-row" style="display:none">
                <input type="text" id="ns-manual-input" class="modal-text-input" placeholder="输入绝对路径后回车">
                <button class="dir-browser-go-btn" id="ns-manual-go">前往</button>
              </div>
              <div class="dir-browser-list" id="ns-dir-list">
                <div class="dir-browser-empty">正在加载…</div>
              </div>
              <div class="dir-browser-toolbar">
                <label class="dir-browser-toggle">
                  <input type="checkbox" id="ns-show-hidden">
                  <span>显示隐藏目录</span>
                </label>
                <div class="dir-browser-selection-hint" id="ns-selection-hint">选中后会直接使用当前目录。</div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="ns-back-btn" style="display:none">返回</button>
          <button class="modal-btn-secondary" id="ns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="ns-select-btn">选择此目录</button>
        </div>
      </div>
    `;
  }

  function createProjectPickerItemElement(project, sessionCount, onClick) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'project-picker-item';
    card.innerHTML = `
      <span class="project-picker-item-top">
        <span class="project-picker-item-tag">项目</span>
        <span class="project-picker-item-count">${sessionCount > 0 ? `${sessionCount} 个会话` : '暂无会话'}</span>
      </span>
      <span class="project-picker-item-name">${escapeHtml(project.name)}</span>
      <span class="project-picker-item-path">${escapeHtml(project.path)}</span>
      <span class="project-picker-item-note">点击后会立刻进入这个项目，并创建一个新会话。</span>
      <span class="project-picker-item-arrow" aria-hidden="true">\u203A</span>
    `;
    card.addEventListener('click', onClick);
    return card;
  }

  function createDirBrowserItemElement(name, note, onClick, extraClass = '') {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `dir-browser-item${extraClass ? ` ${extraClass}` : ''}`;

    const icon = document.createElement('span');
    icon.className = 'dir-browser-item-icon';

    const copy = document.createElement('span');
    copy.className = 'dir-browser-item-copy';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'dir-browser-item-name';
    nameSpan.textContent = name;

    const noteSpan = document.createElement('span');
    noteSpan.className = 'dir-browser-item-note';
    noteSpan.textContent = note;

    const arrow = document.createElement('span');
    arrow.className = 'dir-browser-item-arrow';
    arrow.textContent = '\u203A';

    copy.appendChild(nameSpan);
    copy.appendChild(noteSpan);
    item.appendChild(icon);
    item.appendChild(copy);
    item.appendChild(arrow);
    item.addEventListener('click', onClick);
    return item;
  }

  function createDirBrowserMessageElement(className, text) {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    return div;
  }

  function setManualPathMode(enabled, manualRow, pathbar, manualInput, currentBrowsePath) {
    manualRow.style.display = enabled ? 'flex' : 'none';
    pathbar.style.display = enabled ? 'none' : 'flex';
    if (enabled) {
      manualInput.value = currentBrowsePath || '';
      manualInput.focus();
    }
  }

  function updateNewSessionBrowserChrome(selectionHintEl, selectBtn) {
    selectionHintEl.textContent = '确认后会把这个目录加入左侧项目列表，并立刻创建新会话。';
    selectBtn.textContent = '打开这个目录';
  }

  function updateNewSessionPathCard(currentNameEl, currentPathEl, pathValue, hasError = false) {
    if (!pathValue) {
      currentNameEl.textContent = '正在定位…';
      currentPathEl.textContent = '载入后会在这里显示你当前选中的完整路径。';
      return;
    }
    currentNameEl.textContent = getPathLeaf(pathValue);
    currentPathEl.textContent = hasError
      ? `${pathValue}（当前不可用，请换一个目录）`
      : pathValue;
  }

  function switchNewSessionModalStep({
    stepProjects,
    stepBrowser,
    selectBtn,
    backBtn,
    showBrowser,
    canGoBack = false,
  }) {
    stepProjects.style.display = showBrowser ? 'none' : '';
    stepBrowser.style.display = showBrowser ? '' : 'none';
    selectBtn.style.display = showBrowser ? '' : 'none';
    backBtn.style.display = showBrowser && canGoBack ? '' : 'none';
  }

  function renderNewSessionProjectPickerList({
    projectListEl,
    projectSummaryEl,
    projectCountEl,
    projectsList,
    getSessionCount,
    onProjectSelect,
  }) {
    projectListEl.innerHTML = '';
    projectCountEl.textContent = `${projectsList.length} 个项目`;
    projectSummaryEl.textContent = projectsList.length > 0
      ? '点击任意项目会直接创建新会话。'
      : '还没有保存项目，先选一个目录开始。';

    for (const project of projectsList) {
      const card = createProjectPickerItemElement(project, getSessionCount(project), () => onProjectSelect(project));
      projectListEl.appendChild(card);
    }
  }

  function renderNewSessionCrumbs(crumbsEl, fullPath, onNavigate) {
    crumbsEl.innerHTML = '';
    if (!fullPath) return;
    const parts = fullPath.split('/').filter(Boolean);
    const rootSpan = document.createElement(parts.length > 0 ? 'button' : 'span');
    if (parts.length > 0) rootSpan.type = 'button';
    rootSpan.className = parts.length > 0 ? 'dir-browser-crumb' : 'dir-browser-crumb-current';
    rootSpan.textContent = '/';
    if (parts.length > 0) {
      rootSpan.addEventListener('click', () => onNavigate('/'));
    }
    crumbsEl.appendChild(rootSpan);

    parts.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'dir-browser-crumb-sep';
      sep.textContent = '\u203A';
      crumbsEl.appendChild(sep);

      const isLast = i === parts.length - 1;
      const span = document.createElement(isLast ? 'span' : 'button');
      if (!isLast) span.type = 'button';
      span.className = isLast ? 'dir-browser-crumb-current' : 'dir-browser-crumb';
      span.textContent = seg;
      if (!isLast) {
        span.addEventListener('click', () => onNavigate('/' + parts.slice(0, i + 1).join('/')));
      }
      crumbsEl.appendChild(span);
    });

    crumbsEl.scrollLeft = crumbsEl.scrollWidth;
  }

  function renderNewSessionDirList({
    dirListEl,
    dirs,
    parentPath,
    error,
    currentBrowsePath,
    onNavigate,
  }) {
    dirListEl.innerHTML = '';
    if (error) {
      const errDiv = createDirBrowserMessageElement('dir-browser-error', error);
      if (parentPath) {
        const backLink = document.createElement('button');
        backLink.type = 'button';
        backLink.className = 'dir-browser-error-back';
        backLink.textContent = '返回上级目录';
        backLink.addEventListener('click', () => onNavigate(parentPath));
        errDiv.appendChild(backLink);
      }
      dirListEl.appendChild(errDiv);
      return;
    }
    if (parentPath) {
      dirListEl.appendChild(createDirBrowserItemElement('..', '返回上一级目录', () => onNavigate(parentPath), 'is-parent'));
    }
    if (!dirs || dirs.length === 0) {
      dirListEl.appendChild(createDirBrowserMessageElement('dir-browser-empty', '此目录下没有子目录'));
      return;
    }
    for (const name of dirs) {
      const item = createDirBrowserItemElement(name, '进入这个目录继续浏览', () => {
        const childPath = currentBrowsePath === '/' ? '/' + name : currentBrowsePath + '/' + name;
        onNavigate(childPath);
      });
      dirListEl.appendChild(item);
    }
  }

  function showNewSessionModal() {
    const targetAgent = selectedAgent;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'new-session-overlay';

    let currentBrowsePath = null;
    let showHidden = false;
    overlay.innerHTML = buildNewSessionModalHtml();

    document.body.appendChild(overlay);

    const stepProjects = overlay.querySelector('#ns-step-projects');
    const stepBrowser = overlay.querySelector('#ns-step-browser');
    const projectListEl = overlay.querySelector('#ns-project-list');
    const projectSummaryEl = overlay.querySelector('#ns-project-summary');
    const projectCountEl = overlay.querySelector('#ns-project-count');
    const backBtn = overlay.querySelector('#ns-back-btn');
    const selectBtn = overlay.querySelector('#ns-select-btn');
    const crumbsEl = overlay.querySelector('#ns-crumbs');
    const dirListEl = overlay.querySelector('#ns-dir-list');
    const manualRow = overlay.querySelector('#ns-manual-row');
    const manualInput = overlay.querySelector('#ns-manual-input');
    const pathbar = overlay.querySelector('#ns-pathbar');
    const currentNameEl = overlay.querySelector('#ns-current-name');
    const currentPathEl = overlay.querySelector('#ns-current-path');
    const selectionHintEl = overlay.querySelector('#ns-selection-hint');

    // --- Step 1: Render project list ---
    function renderProjectPicker() {
      renderNewSessionProjectPickerList({
        projectListEl,
        projectSummaryEl,
        projectCountEl,
        projectsList: projects,
        getSessionCount: (project) => getCurrentProjectSessionCount(project),
        onProjectSelect: (project) => {
          close();
          send({ type: 'new_session', projectId: project.id, agent: targetAgent, mode: getSavedModeForAgent(targetAgent) });
        },
      });
      if (projects.length === 0) {
        showBrowserStep(false);
        return;
      }
    }

    // --- Step 2: Directory browser (reused from original) ---
    function showBrowserStep(canGoBack) {
      switchNewSessionModalStep({
        stepProjects,
        stepBrowser,
        selectBtn,
        backBtn,
        showBrowser: true,
        canGoBack,
      });
      selectBtn.disabled = true;
      updateNewSessionBrowserChrome(selectionHintEl, selectBtn);
      updateNewSessionPathCard(currentNameEl, currentPathEl, currentBrowsePath);
      navigateTo(currentBrowsePath);
    }

    function showProjectStep() {
      switchNewSessionModalStep({
        stepProjects,
        stepBrowser,
        selectBtn,
        backBtn,
        showBrowser: false,
      });
    }

    function navigateTo(dirPath) {
      selectBtn.disabled = true;
      updateNewSessionPathCard(currentNameEl, currentPathEl, dirPath || currentBrowsePath);
      dirListEl.innerHTML = '<div class="dir-browser-empty">正在加载…</div>';
      send({ type: 'browse_directory', path: dirPath, showHidden });
    }

    _onDirectoryListing = (msg) => {
      currentBrowsePath = msg.path || '/';
      renderNewSessionCrumbs(crumbsEl, currentBrowsePath, navigateTo);
      renderNewSessionDirList({
        dirListEl,
        dirs: msg.dirs || [],
        parentPath: msg.parent,
        error: msg.error,
        currentBrowsePath,
        onNavigate: navigateTo,
      });
      updateNewSessionPathCard(currentNameEl, currentPathEl, currentBrowsePath, Boolean(msg.error));
      selectBtn.disabled = Boolean(msg.error);
    };

    // Manual path toggle
    let manualMode = false;
    overlay.querySelector('#ns-edit-path-btn').addEventListener('click', () => {
      manualMode = !manualMode;
      setManualPathMode(manualMode, manualRow, pathbar, manualInput, currentBrowsePath);
    });

    function goToManualPath() {
      const val = manualInput.value.trim();
      if (val) {
        manualMode = false;
        setManualPathMode(false, manualRow, pathbar, manualInput, currentBrowsePath);
        navigateTo(val);
      }
    }
    overlay.querySelector('#ns-manual-go').addEventListener('click', goToManualPath);
    manualInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goToManualPath();
      if (e.key === 'Escape') {
        manualMode = false;
        setManualPathMode(false, manualRow, pathbar, manualInput, currentBrowsePath);
      }
    });

    // Hidden toggle
    overlay.querySelector('#ns-show-hidden').addEventListener('change', (e) => {
      showHidden = e.target.checked;
      navigateTo(currentBrowsePath);
    });

    function close() {
      overlay.remove();
      _onDirectoryListing = null;
    }

    overlay.querySelector('#ns-close-btn').addEventListener('click', close);
    overlay.querySelector('#ns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Back button — return to project picker
    backBtn.addEventListener('click', () => {
      showProjectStep();
      renderProjectPicker();
    });

    overlay.querySelector('#ns-open-dir-btn').addEventListener('click', () => {
      showBrowserStep(true);
    });

    // Select button — create session and auto-persist project by cwd
    selectBtn.addEventListener('click', () => {
      const cwd = currentBrowsePath || null;
      if (!cwd) return;
      const normalizedCwd = normalizeComparablePath(cwd);
      const existingProject = projects.find((project) => normalizeComparablePath(project?.path) === normalizedCwd) || null;
      const projectId = existingProject?.id || crypto.randomUUID();
      close();
      send(existingProject
        ? { type: 'save_project', id: projectId, path: cwd }
        : { type: 'save_project', id: projectId, path: cwd, name: getPathLeaf(cwd) || cwd });
      send({ type: 'new_session', cwd, agent: targetAgent, mode: getSavedModeForAgent(targetAgent) });
    });

    // Initialize — default directly into directory browser
    showBrowserStep(false);
  }

  // --- Import Native Session Modal ---
  let _onNativeSessions = null;

  function showImportSessionModal() {
    if (selectedAgent !== 'claude') return;
    const modal = createImportSessionsModal({
      overlayId: 'import-session-overlay',
      title: '导入本地 CLI 会话',
      closeBtnId: 'is-close-btn',
      bodyId: 'is-body',
      agent: 'claude',
      cardTitle: '从 Claude 原生历史导入',
      cardCopy: '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。',
      loadingText: '正在加载…',
      onClose: () => {
        _onNativeSessions = null;
      },
    });

    _onNativeSessions = (groups) => {
      const body = modal.body;
      if (!body) return;
      if (!groups || groups.length === 0) {
        modal.renderEmpty('未找到本地 CLI 会话');
        return;
      }
      modal.renderBody();
      for (const group of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'import-group import-group-collapsed';

        const groupTitle = document.createElement('div');
        groupTitle.className = 'import-group-title import-group-title-toggle';
        groupTitle.textContent = formatClaudeImportGroupPath(group.dir);
        const arrow = document.createElement('span');
        arrow.className = 'import-group-arrow';
        arrow.textContent = '▶';
        groupTitle.prepend(arrow);

        const sessionList = document.createElement('div');
        sessionList.className = 'import-group-sessions';

        let sessionsRendered = false;
        const renderSessions = () => {
          if (sessionsRendered) return;
          sessionsRendered = true;
          for (const sess of group.sessions) {
            const item = document.createElement('div');
            item.className = 'import-item';
            const info = document.createElement('div');
            info.className = 'import-item-info';
            const titleEl = document.createElement('div');
            titleEl.className = 'import-item-title';
            titleEl.textContent = sess.title;
            const meta = document.createElement('div');
            meta.className = 'import-item-meta';
            const cwdText = sess.cwd ? sess.cwd : '';
            const timeText = sess.updatedAt ? timeAgo(sess.updatedAt) : '';
            meta.textContent = [cwdText, timeText].filter(Boolean).join(' · ');
            info.appendChild(titleEl);
            info.appendChild(meta);
            const btn = document.createElement('button');
            btn.className = 'import-item-btn';
            btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
            btn.addEventListener('click', () => {
              if (sess.alreadyImported) {
                if (!confirm('已导入过此会话，重新导入将覆盖已有内容。确认继续？')) return;
              } else {
                if (!confirm('由于 webcoding 与本地 CLI 的逻辑不同，导入会话需要解析后方可展示，导入后将覆盖已有内容。确认继续？')) return;
              }
              modal.close();
              send({ type: 'import_native_session', sessionId: sess.sessionId, projectDir: group.dir });
            });
            item.appendChild(info);
            item.appendChild(btn);
            sessionList.appendChild(item);
          }
        };

        groupTitle.addEventListener('click', () => {
          const collapsed = groupEl.classList.toggle('import-group-collapsed');
          arrow.textContent = collapsed ? '▶' : '▼';
          if (!collapsed) renderSessions();
        });

        groupEl.appendChild(groupTitle);
        groupEl.appendChild(sessionList);
        body.appendChild(groupEl);
      }
    };

    send({ type: 'list_native_sessions' });
  }

  function showImportCodexSessionModal() {
    if (selectedAgent !== 'codex') return;
    const modal = createImportSessionsModal({
      overlayId: 'import-codex-session-overlay',
      title: '导入本地 Codex 会话',
      closeBtnId: 'ics-close-btn',
      bodyId: 'ics-body',
      agent: 'codex',
      cardTitle: '从 Codex rollout 历史导入',
      cardCopy: '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。',
      loadingText: '正在加载 Codex 本地历史…',
      onClose: () => {
        _onCodexSessions = null;
      },
    });

    _onCodexSessions = (items) => {
      const body = modal.body;
      if (!body) return;
      if (!items || items.length === 0) {
        modal.renderEmpty('未找到本地 Codex 会话');
        return;
      }

      modal.renderBody();
      items.forEach((sess) => {
        const item = document.createElement('div');
        item.className = 'import-item';

        const info = document.createElement('div');
        info.className = 'import-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'import-item-title';
        titleEl.textContent = sess.title || sess.threadId;

        const meta = document.createElement('div');
        meta.className = 'import-item-meta';
        meta.textContent = [
          sess.cwd || '',
          sess.source ? `source:${sess.source}` : '',
          sess.updatedAt ? timeAgo(sess.updatedAt) : '',
        ].filter(Boolean).join(' · ');

        const tags = document.createElement('div');
        tags.className = 'import-item-tags';
        if (sess.cliVersion) {
          const ver = document.createElement('span');
          ver.className = 'import-item-tag';
          ver.textContent = `CLI ${sess.cliVersion}`;
          tags.appendChild(ver);
        }
        if (sess.source) {
          const source = document.createElement('span');
          source.className = 'import-item-tag';
          source.textContent = sess.source;
          tags.appendChild(source);
        }

        info.appendChild(titleEl);
        info.appendChild(meta);
        if (tags.children.length > 0) info.appendChild(tags);

        const btn = document.createElement('button');
        btn.className = 'import-item-btn';
        btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
        btn.addEventListener('click', () => {
          const confirmed = sess.alreadyImported
            ? confirm('已导入过此 Codex 会话，重新导入将覆盖已有内容。确认继续？')
            : confirm('将解析本地 Codex rollout 历史并导入当前 Web 视图。确认继续？');
          if (!confirmed) return;
          modal.close();
          send({ type: 'import_codex_session', threadId: sess.threadId, rolloutPath: sess.rolloutPath });
        });

        item.appendChild(info);
        item.appendChild(btn);
        body.appendChild(item);
      });
    };

    send({ type: 'list_codex_sessions' });
  }

  // --- Helpers ---

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function normalizeSafeHref(rawHref, options = {}) {
    const href = String(rawHref || '').trim();
    if (!href) return '';
    const externalOnly = options.externalOnly === true;
    const allowRelative = options.allowRelative !== false;
    const allowDataImage = options.allowDataImage === true;
    const lower = href.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) return '';
    if (lower.startsWith('data:')) {
      if (allowDataImage && /^data:image\/[a-z0-9.+-]+;base64,/i.test(href)) return href;
      return '';
    }
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) {
      try {
        const parsed = new URL(href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
        if (!externalOnly && (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:')) return parsed.toString();
        return '';
      } catch {
        return '';
      }
    }
    if (externalOnly || !allowRelative || href.startsWith('//')) return '';
    if (/^(#|\/|\.\.?\/|\?)/.test(href)) return href;
    return '';
  }

  function buildUpdateStatusHtml(info) {
    const latestVersion = escapeHtml(info?.latestVersion || '');
    const localVersion = escapeHtml(info?.localVersion || '');
    const safeReleaseUrl = normalizeSafeHref(info?.releaseUrl, { externalOnly: true, allowRelative: false });
    if (!safeReleaseUrl) {
      return `有新版本 <strong>v${latestVersion}</strong>（当前 v${localVersion}）`;
    }
    return `有新版本 <strong>v${latestVersion}</strong>（当前 v${localVersion}）&nbsp;<a href="${escapeHtml(safeReleaseUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">查看更新</a>`;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const timestamp = date.getTime();
    if (Number.isNaN(timestamp)) return '';
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return date.toLocaleDateString('zh-CN');
  }

  // --- Init ---
  setSelectedAgent(selectedAgent, { syncMode: true });
  resetChatView(selectedAgent);
  connect();
  window.addEventListener('resize', updateCwdBadge);
  window.addEventListener('online', () => {
    connectionState.reconnectAttempts = 0;
    if (!connectionState.ws || connectionState.ws.readyState > WebSocket.OPEN) connect();
  });

  // Register Service Worker for mobile push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[WEBCODING-SW]', 'service worker register failed', error);
    });
  }

  // Clear password remnants from older builds; remembered passwords are session-only now.
  localStorage.removeItem('webcoding-pw');
  localStorage.removeItem(REMEMBERED_PASSWORD_STORAGE_KEY);
  restoreRememberedPasswordInput();

  // Visibility change: re-sync state when user returns to tab (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastVisibilityResyncAt < VISIBILITY_RESYNC_THROTTLE_MS) return;
    lastVisibilityResyncAt = now;
    if (!connectionState.ws || connectionState.ws.readyState > WebSocket.OPEN) {
      // WS is dead, force reconnect
      connect();
    } else if (connectionState.ws.readyState === WebSocket.OPEN && sessionState.currentSessionId) {
      // Preserve active streaming UI when returning to foreground.
      if (composeState.isGenerating || sessionState.currentSessionRunning) {
        send({ type: 'load_session', sessionId: sessionState.currentSessionId });
      } else {
        beginSessionSwitch(sessionState.currentSessionId, { blocking: false, force: true });
      }
    }
  });

  if (!connectionState.authToken) {
    loginOverlay.hidden = false;
    app.hidden = true;
    restoreRememberedPasswordInput();
  } else {
    loginOverlay.hidden = true;
    app.hidden = false;
  }
})();
