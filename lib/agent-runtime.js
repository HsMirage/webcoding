const {
  classifyRuntimeEvent,
  buildInteractiveRequestPayload,
} = require('./runtime-capabilities');

function shouldUseShellForCommand(command) {
  if (process.platform !== 'win32') return false;
  const raw = String(command || '').trim();
  if (!raw) return false;
  const normalized = raw.replace(/^"+|"+$/g, '').toLowerCase();
  const hasPathSeparator = normalized.includes('\\') || normalized.includes('/');
  if (!hasPathSeparator) return true;
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat') || normalized.endsWith('.ps1');
}

function createAgentRuntime(deps) {
  const {
    processEnv,
    CLAUDE_PATH,
    CODEX_PATH,
    PI_PATH,
    SESSIONS_DIR,
    MODEL_MAP,
    loadModelConfig,
    applyCustomTemplateToSettings,
    getClaudeRuntimeFingerprint,
    loadCodexConfig,
    prepareCodexCustomRuntime,
    getCodexRuntimeFingerprint,
    loadPiConfig,
    preparePiCustomRuntime,
    getPiRuntimeFingerprint: getPiRuntimeFingerprintFromDeps,
    wsSend,
    truncateObj,
    sanitizeToolInput,
    loadSession,
    saveSession,
    getRuntimeSessionState,
    getFallbackRuntimeSessionState,
    setRuntimeSessionState,
    setRuntimeSessionId,
    getRuntimeSessionId,
    runtimeFingerprintsCompatible,
    onSlashCommandsDiscovered,
    plog = () => {},
  } = deps;

  /** Provider / Pi env keys re-injected after sanitize so headless pi can auth. */
  const PI_PASSTHROUGH_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_BASE_URL',
    'AZURE_OPENAI_RESOURCE_NAME',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
    'DEEPSEEK_API_KEY',
    'NVIDIA_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'XAI_API_KEY',
    'FIREWORKS_API_KEY',
    'TOGETHER_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_GATEWAY_API_KEY',
    'ZAI_API_KEY',
    'ZAI_CODING_CN_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'MOONSHOT_API_KEY',
    'OPENCODE_API_KEY',
    'KIMI_API_KEY',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_GATEWAY_ID',
    'XIAOMI_API_KEY',
    'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_REGION',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'PI_PACKAGE_DIR',
    'PI_OFFLINE',
    'PI_TELEMETRY',
    'PI_SHARE_VIEWER_URL',
  ];

  const CLAUDE_PASSTHROUGH_ENV_KEYS = [
    'CLAUDE_CONFIG_DIR',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'CLOUD_ML_REGION',
  ];
  const CLAUDE_PASSTHROUGH_ENV_PREFIXES = [
    'ANTHROPIC_',
    'CLAUDE_CODE_USE_',
    'AWS_',
  ];
  const CODEX_PASSTHROUGH_ENV_KEYS = [
    'CODEX_HOME',
  ];
  const CODEX_PASSTHROUGH_ENV_PREFIXES = [
    'OPENAI_',
    'AZURE_OPENAI_',
  ];
  const CHILD_ENV_DENYLIST = new Set([
    'CC_WEB_PASSWORD',
    'CLAUDECODE',
    'CLAUDE_CODE',
  ]);

  const CHILD_ENV_ALLOWLIST = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
    'APPDATA',
    'LOCALAPPDATA',
    'NO_COLOR',
    'COLORTERM',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'GPG_TTY',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]);
  const CHILD_ENV_PREFIX_ALLOWLIST = ['LC_'];
  const MAX_TOOL_RESULT_LENGTH = 2000;

  function ensureUserBinOnPath(pathValue) {
    const pathMod = require('path');
    const home = processEnv.HOME || processEnv.USERPROFILE || '';
    const extras = [];
    if (home) {
      // Claude Code installer → ~/.local/bin; Volta shims → ~/.volta/bin
      extras.push(pathMod.join(home, '.local', 'bin'));
      extras.push(pathMod.join(home, '.volta', 'bin'));
      extras.push(pathMod.join(home, '.cargo', 'bin'));
    }
    const parts = String(pathValue || processEnv.PATH || '').split(pathMod.delimiter).filter(Boolean);
    for (let i = extras.length - 1; i >= 0; i -= 1) {
      const dir = extras[i];
      if (dir && !parts.includes(dir)) parts.unshift(dir);
    }
    return parts.join(pathMod.delimiter);
  }

  function sanitizeChildEnv(extra = {}) {
    const env = {};
    for (const key of Object.keys(processEnv || {})) {
      if (CHILD_ENV_ALLOWLIST.has(key) || CHILD_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) {
        const value = processEnv[key];
        if (value !== undefined && value !== null) env[key] = String(value);
      }
    }

    // Explicitly remove known sensitive prefixes/keys even if inherited by platform env.
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_')) delete env[key];
      if (key === 'OPENAI_API_KEY' || key === 'OPENAI_BASE_URL') delete env[key];
    }
    for (const [key, value] of Object.entries(extra || {})) {
      if (value === undefined || value === null) {
        delete env[key];
      } else {
        env[key] = String(value);
      }
    }

    // These values belong to the Web server itself and must never reach agent tools.
    for (const key of CHILD_ENV_DENYLIST) delete env[key];

    // Headless servers often inherit a thin PATH; keep user install dirs available for bare CLI names.
    env.PATH = ensureUserBinOnPath(env.PATH || processEnv.PATH || '');
    return env;
  }

  function configuredCliPassthroughKeys() {
    return String(processEnv.CC_WEB_CLI_ENV_PASSTHROUGH || '')
      .split(/[\s,]+/)
      .map((key) => key.trim())
      .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !CHILD_ENV_DENYLIST.has(key));
  }

  function selectProcessEnv(keys = [], prefixes = []) {
    const selected = {};
    const exact = new Set([...keys, ...configuredCliPassthroughKeys()]);
    for (const [key, value] of Object.entries(processEnv || {})) {
      if (CHILD_ENV_DENYLIST.has(key)) continue;
      if (!exact.has(key) && !prefixes.some((prefix) => key.startsWith(prefix))) continue;
      if (value === undefined || value === null || String(value) === '') continue;
      selected[key] = String(value);
    }
    return selected;
  }

  function buildClaudeEnv(localMode) {
    const prefixes = localMode ? CLAUDE_PASSTHROUGH_ENV_PREFIXES : [];
    return sanitizeChildEnv(selectProcessEnv(CLAUDE_PASSTHROUGH_ENV_KEYS, prefixes));
  }

  function buildCodexEnv(runtimeConfig) {
    if (runtimeConfig?.mode === 'custom') {
      return sanitizeChildEnv({
        ...selectProcessEnv(),
        CODEX_HOME: runtimeConfig.homeDir,
        OPENAI_API_KEY: runtimeConfig.apiKey,
        OPENAI_BASE_URL: null,
      });
    }
    return sanitizeChildEnv(selectProcessEnv(
      CODEX_PASSTHROUGH_ENV_KEYS,
      CODEX_PASSTHROUGH_ENV_PREFIXES,
    ));
  }

  function resolveWorkingDir(session) {
    return session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd();
  }

  function truncateToolResult(text) {
    return String(text || '').slice(0, MAX_TOOL_RESULT_LENGTH);
  }

  function buildThreadResetMeta(agent, reason, previousRuntimeId) {
    return {
      agent,
      reason,
      previousRuntimeId: previousRuntimeId || null,
    };
  }

  function codexRuntimeStorageScope(descriptor) {
    const mode = String(descriptor?.mode || 'local').trim().toLowerCase();
    if (!mode || mode === 'error') return null;
    if (mode === 'local') return 'local';
    if (mode === 'legacy') {
      const hint = String(descriptor?.runtimeFingerprintHint || '').trim();
      if (!hint) return null;
      if (hint.toLowerCase() === 'local') return 'local';
      return /"mode"\s*:\s*"local"/.test(hint) ? 'local' : 'managed';
    }
    return 'managed';
  }

  function canStickyResumeFallback(agent, currentState, fallbackState) {
    if (!fallbackState?.entry?.runtimeId) return false;
    if (agent === 'codex') {
      const currentScope = codexRuntimeStorageScope(currentState?.descriptor || null);
      const fallbackScope = codexRuntimeStorageScope(fallbackState?.descriptor || null);
      if (!currentScope || !fallbackScope) return false;
      return currentScope === fallbackScope;
    }
    return true;
  }

  function resolvePiSessionDir(session) {
    const base = SESSIONS_DIR
      ? String(SESSIONS_DIR)
      : (processEnv.CC_WEB_SESSIONS_DIR || require('path').join(process.cwd(), 'sessions'));
    const pathMod = require('path');
    const fsMod = require('fs');
    const dir = pathMod.join(base, '_pi-sessions', String(session?.id || 'default'));
    try {
      fsMod.mkdirSync(dir, { recursive: true });
    } catch {}
    return dir;
  }

  function buildPiEnv() {
    return sanitizeChildEnv(selectProcessEnv(PI_PASSTHROUGH_ENV_KEYS));
  }

  function getPiRuntimeFingerprint(session) {
    if (typeof getPiRuntimeFingerprintFromDeps === 'function') {
      try {
        const piConfig = typeof loadPiConfig === 'function' ? loadPiConfig() : null;
        return getPiRuntimeFingerprintFromDeps(piConfig);
      } catch {}
    }
    // Fallback: session-local model/provider + host config dir.
    const model = String(session?.model || '').trim();
    const provider = String(session?.piProvider || '').trim();
    return JSON.stringify({
      agent: 'pi',
      model: model || null,
      provider: provider || null,
      configDir: processEnv.PI_CODING_AGENT_DIR || null,
    });
  }

  function selectRuntimeResumeState(agent, currentState, fallbackState) {
    if (currentState?.entry?.runtimeId) {
      return {
        state: currentState,
        fromFallback: false,
        blockedByStorageBoundary: false,
      };
    }
    if (canStickyResumeFallback(agent, currentState, fallbackState)) {
      return {
        state: fallbackState,
        fromFallback: true,
        blockedByStorageBoundary: false,
      };
    }
    return {
      state: currentState,
      fromFallback: false,
      blockedByStorageBoundary: !!(fallbackState?.entry?.runtimeId && agent === 'codex'),
    };
  }

  function buildClaudeSpawnSpec(session, options = {}) {
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    const modelCfg = loadModelConfig();
    const runtimeFingerprint = typeof getClaudeRuntimeFingerprint === 'function'
      ? getClaudeRuntimeFingerprint(modelCfg)
      : null;
    const currentState = typeof getRuntimeSessionState === 'function'
      ? getRuntimeSessionState(session, { agent: 'claude', modelConfig: modelCfg })
      : null;
    let runtimeId = currentState?.entry?.runtimeId || getRuntimeSessionId(session);
    const previousRuntimeId = runtimeId;
    const fallbackState = typeof getFallbackRuntimeSessionState === 'function'
      ? getFallbackRuntimeSessionState(session, {
          agent: 'claude',
          modelConfig: modelCfg,
          excludeChannelKey: currentState?.key || null,
        })
      : null;
    let warningMessage = null;
    let threadReset = null;
    const savedFingerprint = String(currentState?.entry?.runtimeFingerprint || '').trim();
    const shouldResetChangedThread = !!runtimeId
      && !!savedFingerprint
      && !!runtimeFingerprint
      && !(typeof runtimeFingerprintsCompatible === 'function'
        ? runtimeFingerprintsCompatible('claude', savedFingerprint, runtimeFingerprint)
        : savedFingerprint === runtimeFingerprint);
    const resumeSelection = selectRuntimeResumeState('claude', currentState, fallbackState);
    if (!runtimeId && resumeSelection.state?.entry?.runtimeId) {
      runtimeId = resumeSelection.state.entry.runtimeId;
    }
    if (shouldResetChangedThread) {
      warningMessage = '已原生续接之前的线程，完整上下文仍然有效。';
    } else if (!previousRuntimeId && resumeSelection.fromFallback) {
      warningMessage = '已原生续接之前的线程，完整上下文仍然有效。';
    }
    if (threadReset) {
      runtimeId = null;
    }

    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (hasAttachments) args.push('--input-format', 'stream-json');
    const permMode = session.permissionMode || 'yolo';
    switch (permMode) {
      case 'yolo':
        args.push('--permission-mode', 'bypassPermissions');
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'default':
        break;
    }
    if (runtimeId) {
      args.push('--resume', runtimeId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }

    const env = buildClaudeEnv(modelCfg.mode !== 'custom');

    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate);
      if (tpl) applyCustomTemplateToSettings(tpl);
    }

    const effectiveModel = session.model
      || (modelCfg.mode === 'custom' && modelCfg.activeTemplate
        ? ((modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate)?.defaultModel
          || (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate)?.sonnetModel
          || null)
        : null)
      || null;

    return {
      command: CLAUDE_PATH,
      args,
      env,
      cwd: resolveWorkingDir(session),
      parser: 'claude',
      mode: permMode,
      resume: !!runtimeId,
      runtimeFingerprint,
      channelKey: currentState?.key || null,
      channelDescriptor: currentState?.descriptor || null,
      warningMessage,
      threadReset,
      effectiveModel: effectiveModel ? String(effectiveModel) : null,
      useShell: shouldUseShellForCommand(CLAUDE_PATH),
    };
  }

  function buildCodexSpawnSpec(session, options = {}) {
    const reviewRequest = options.review && typeof options.review === 'object'
      ? options.review
      : null;
    const codexConfig = loadCodexConfig();
    const runtimeConfig = prepareCodexCustomRuntime(codexConfig);
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
    }
    const runtimeFingerprint = typeof getCodexRuntimeFingerprint === 'function'
      ? getCodexRuntimeFingerprint(codexConfig)
      : null;
    const currentState = typeof getRuntimeSessionState === 'function'
      ? getRuntimeSessionState(session, { agent: 'codex', codexConfig })
      : null;
    let runtimeId = currentState?.entry?.runtimeId || getRuntimeSessionId(session);
    const previousRuntimeId = runtimeId;
    const fallbackState = typeof getFallbackRuntimeSessionState === 'function'
      ? getFallbackRuntimeSessionState(session, {
          agent: 'codex',
          codexConfig,
          excludeChannelKey: currentState?.key || null,
        })
      : null;
    let warningMessage = null;
    let threadReset = null;
    const savedFingerprint = String(currentState?.entry?.runtimeFingerprint || '').trim();
    const shouldResetChangedThread = !!runtimeId
      && !!savedFingerprint
      && !!runtimeFingerprint
      && !(typeof runtimeFingerprintsCompatible === 'function'
        ? runtimeFingerprintsCompatible('codex', savedFingerprint, runtimeFingerprint)
        : savedFingerprint === runtimeFingerprint);
    const resumeSelection = selectRuntimeResumeState('codex', currentState, fallbackState);
    if (!runtimeId && resumeSelection.state?.entry?.runtimeId) {
      runtimeId = resumeSelection.state.entry.runtimeId;
    }
    if (shouldResetChangedThread) {
      warningMessage = '已原生续接之前的线程，完整上下文仍然有效。';
    } else if (!previousRuntimeId && resumeSelection.fromFallback) {
      warningMessage = '已原生续接之前的线程，完整上下文仍然有效。';
    } else if (!runtimeId && resumeSelection.blockedByStorageBoundary && fallbackState?.entry?.runtimeId) {
      runtimeId = fallbackState.entry.runtimeId;
      threadReset = buildThreadResetMeta('codex', 'channel_changed', runtimeId);
      warningMessage = '无法原生续接旧线程，已新开线程并补充历史摘要。';
    }
    if (threadReset) {
      runtimeId = null;
    }
    if (reviewRequest) {
      // `codex exec review` is a dedicated new turn and cannot resume an existing exec thread.
      runtimeId = null;
      warningMessage = null;
      threadReset = null;
    }
    const args = ['exec'];
    if (reviewRequest) args.push('review');
    else if (runtimeId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    if (runtimeConfig?.mode === 'custom') {
      const quoted = (value) => JSON.stringify(String(value || ''));
      args.push(
        '-c', `preferred_auth_method=${quoted('apikey')}`,
        '-c', `model_provider=${quoted('openai_compat')}`,
        '-c', `model_providers.openai_compat.name=${quoted(runtimeConfig.profileName || 'Unified API Config')}`,
        '-c', `model_providers.openai_compat.base_url=${quoted(runtimeConfig.apiBase || '')}`,
        '-c', `model_providers.openai_compat.env_key=${quoted('OPENAI_API_KEY')}`,
        '-c', `model_providers.openai_compat.wire_api=${quoted('responses')}`,
      );
      if (runtimeConfig.defaultModel) {
        args.push('-c', `model=${quoted(runtimeConfig.defaultModel)}`);
      }
    }

    const permMode = session.permissionMode || 'yolo';
    if (!reviewRequest) {
      switch (permMode) {
        case 'yolo':
          args.push('--dangerously-bypass-approvals-and-sandbox');
          break;
        case 'plan':
          args.push('-s', 'read-only');
          break;
        case 'default':
        default:
          args.push('--full-auto');
          break;
      }
    }

    if (session.model) args.push('--model', session.model);
    if (!reviewRequest && Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) args.push('--image', attachment.path);
      }
    }
    if (reviewRequest) {
      args.push('--uncommitted', '-');
    } else if (runtimeId) {
      args.push(runtimeId, '-');
    } else {
      if (session.cwd) args.push('-C', session.cwd);
      args.push('-');
    }

    const env = buildCodexEnv(runtimeConfig);

    const effectiveModel = session.model
      || (runtimeConfig?.mode === 'custom' ? runtimeConfig.defaultModel : null)
      || null;

    return {
      command: CODEX_PATH,
      args,
      env,
      cwd: resolveWorkingDir(session),
      parser: 'codex',
      mode: permMode,
      resume: !!runtimeId,
      runtimeFingerprint,
      channelKey: currentState?.key || null,
      channelDescriptor: currentState?.descriptor || null,
      warningMessage,
      threadReset,
      ...(reviewRequest ? { inputText: String(reviewRequest.instructions || '') } : {}),
      effectiveModel: effectiveModel ? String(effectiveModel) : null,
      useShell: shouldUseShellForCommand(CODEX_PATH),
    };
  }

  /**
   * Pi coding agent (`pi --mode rpc` or the compatibility `pi -p --mode json`).
   * Multi-turn state uses --session-id + a per-Webcoding session directory.
   * Headless attachments use @path args; RPC attachments travel in prompt commands.
   * Channel:
   *   - local: host ~/.pi/agent (or PI_CODING_AGENT_DIR)
   *   - unified: managed config/pi-runtime-home from selected AI provider template
   */
  function buildPiSpawnSpec(session, options = {}) {
    const useRpc = options.transport === 'rpc';
    const piConfig = typeof loadPiConfig === 'function' ? loadPiConfig() : { mode: 'local' };
    const runtimeConfig = typeof preparePiCustomRuntime === 'function'
      ? preparePiCustomRuntime(piConfig)
      : { mode: 'local' };
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
    }

    const runtimeFingerprint = getPiRuntimeFingerprint(session);
    const currentState = typeof getRuntimeSessionState === 'function'
      ? getRuntimeSessionState(session, { agent: 'pi', piConfig })
      : null;
    let runtimeId = currentState?.entry?.runtimeId || getRuntimeSessionId(session);
    const previousRuntimeId = runtimeId;
    const fallbackState = typeof getFallbackRuntimeSessionState === 'function'
      ? getFallbackRuntimeSessionState(session, {
          agent: 'pi',
          piConfig,
          excludeChannelKey: currentState?.key || null,
        })
      : null;
    let warningMessage = null;
    let threadReset = null;
    const savedFingerprint = String(currentState?.entry?.runtimeFingerprint || '').trim();
    const shouldResetChangedThread = !!runtimeId
      && !!savedFingerprint
      && !!runtimeFingerprint
      && !(typeof runtimeFingerprintsCompatible === 'function'
        ? runtimeFingerprintsCompatible('pi', savedFingerprint, runtimeFingerprint)
        : savedFingerprint === runtimeFingerprint);
    const resumeSelection = selectRuntimeResumeState('pi', currentState, fallbackState);
    if (!runtimeId && resumeSelection.state?.entry?.runtimeId) {
      runtimeId = resumeSelection.state.entry.runtimeId;
    }
    if (shouldResetChangedThread) {
      // Channel/model provider changed: keep runtime id (pi session file) but warn.
      warningMessage = '已原生续接之前的线程，完整上下文仍然有效。';
    } else if (!previousRuntimeId && resumeSelection.fromFallback) {
      warningMessage = '已原生续接之前的线程，完整上下文仍然有效。';
    }
    if (threadReset) {
      runtimeId = null;
    }

    // Prefer a stable id so resume works even if the first session event is lost.
    const sessionIdForPi = runtimeId || String(session?.id || '');
    const sessionDir = resolvePiSessionDir(session);

    const args = useRpc
      ? ['--mode', 'rpc', '--session-dir', sessionDir]
      : ['-p', '--mode', 'json', '--session-dir', sessionDir];
    if (sessionIdForPi) {
      args.push('--session-id', sessionIdForPi);
    }

    const permMode = session.permissionMode || 'yolo';
    switch (permMode) {
      case 'plan':
        // Read-only tools only — Pi has no built-in approval sandbox.
        args.push('--tools', 'read,grep,find,ls');
        break;
      case 'default':
        // Project-local extensions still require trust; otherwise full tools.
        args.push('--no-approve');
        break;
      case 'yolo':
      default:
        args.push('--approve');
        break;
    }

    // Provider/model: session override > managed channel > host defaults.
    const effectiveProvider = session.piProvider
      || (runtimeConfig?.mode === 'custom' ? runtimeConfig.provider : null);
    const effectiveModel = session.model
      || (runtimeConfig?.mode === 'custom' ? runtimeConfig.defaultModel : null);
    if (effectiveProvider) args.push('--provider', String(effectiveProvider));
    if (effectiveModel) args.push('--model', String(effectiveModel));
    if (session.thinking) {
      args.push('--thinking', String(session.thinking));
    }

    if (!useRpc && Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) args.push(`@${attachment.path}`);
      }
    }

    const envOverrides = {};
    if (runtimeConfig?.mode === 'custom') {
      envOverrides.PI_CODING_AGENT_DIR = runtimeConfig.homeDir;
      envOverrides.WEBCODING_PI_API_KEY = runtimeConfig.apiKey;
      // Also set common keys so provider templates that use $OPENAI_API_KEY style still work.
      if (runtimeConfig.upstreamType === 'anthropic') {
        envOverrides.ANTHROPIC_API_KEY = runtimeConfig.apiKey;
      } else {
        envOverrides.OPENAI_API_KEY = runtimeConfig.apiKey;
      }
    }
    const env = buildPiEnv();
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined || value === null) delete env[key];
      else env[key] = String(value);
    }

    return {
      command: PI_PATH || 'pi',
      args,
      env,
      cwd: resolveWorkingDir(session),
      parser: useRpc ? 'pi-rpc' : 'pi',
      transport: useRpc ? 'rpc' : 'headless',
      mode: permMode,
      resume: !!runtimeId,
      runtimeFingerprint,
      channelKey: currentState?.key || null,
      channelDescriptor: currentState?.descriptor || null,
      warningMessage,
      threadReset,
      effectiveModel: effectiveModel ? String(effectiveModel) : null,
      useShell: shouldUseShellForCommand(PI_PATH || 'pi'),
    };
  }

  function codexToolName(item) {
    switch (item?.type) {
      case 'command_execution':
        return 'CommandExecution';
      case 'mcp_tool_call':
        return 'McpToolCall';
      case 'file_change':
        return 'FileChange';
      case 'reasoning':
        return '思考';
      default:
        return item?.type || 'CodexItem';
    }
  }

  function codexToolInput(item) {
    if (!item) return null;
    if (item.type === 'command_execution') return { command: item.command || '' };
    return truncateObj(item, 500);
  }

  function codexToolMeta(item) {
    if (!item) return null;
    switch (item.type) {
      case 'command_execution':
        return {
          kind: 'command_execution',
          title: 'Shell Command',
          subtitle: item.command || '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: item.status || null,
        };
      case 'mcp_tool_call':
        return {
          kind: 'mcp_tool_call',
          title: 'MCP Tool',
          subtitle: item.tool_name || item.name || item.server_name || '',
          status: item.status || null,
        };
      case 'file_change':
        return {
          kind: 'file_change',
          title: 'File Change',
          subtitle: item.path || item.file_path || '',
          status: item.status || null,
        };
      case 'reasoning':
        return {
          kind: 'reasoning',
          title: '思考',
          subtitle: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
          status: item.status || null,
        };
      default:
        return {
          kind: item.type || 'codex_item',
          title: codexToolName(item),
          subtitle: '',
          status: item.status || null,
        };
    }
  }

  function codexToolResult(item) {
    if (!item) return '';
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) return item.aggregated_output;
    if (typeof item.text === 'string' && item.text) return item.text;
    return JSON.stringify(truncateObj(item, 1200));
  }

  function formatCodexItemErrorMessage(item) {
    const raw = String(item?.message || '').trim();
    if (!raw) return '';
    const metadataMatch = raw.match(/Model metadata for `([^`]+)` not found/i);
    if (metadataMatch) {
      return `Codex 提示：模型 ${metadataMatch[1]} 缺少内置元数据，已改用回退元数据继续执行。通常仍能正常回复，但模型能力识别可能不够准确。`;
    }
    return `Codex 提示：${raw}`;
  }

  function appendEntryTextSegment(entry, text, options = {}) {
    if (!entry || typeof text !== 'string' || !text) return;
    if (!Array.isArray(entry.segments)) entry.segments = [];
    const phase = options.phase === 'thinking' ? 'thinking' : null;
    const last = entry.segments[entry.segments.length - 1];
    if (last && last.type === 'text' && (last.phase || null) === phase) {
      last.text = `${last.text || ''}${text}`;
      return;
    }
    const segment = { type: 'text', text };
    if (phase) segment.phase = phase;
    entry.segments.push(segment);
  }

  function appendEntryToolSegment(entry, tool) {
    if (!entry || !tool || !tool.id) return;
    if (!Array.isArray(entry.segments)) entry.segments = [];
    entry.segments.push({
      type: 'tool_call',
      id: tool.id,
      name: tool.name || 'Tool',
      input: tool.input !== undefined ? tool.input : null,
      result: tool.result !== undefined ? tool.result : undefined,
      kind: tool.kind || null,
      meta: tool.meta || null,
      done: !!tool.done,
    });
  }

  function updateEntryToolSegment(entry, toolUseId, updates = {}) {
    if (!entry || !toolUseId || !Array.isArray(entry.segments)) return;
    const segment = entry.segments.find((item) => item && item.type === 'tool_call' && item.id === toolUseId);
    if (!segment) return;
    Object.assign(segment, updates);
  }

  function sendSessionEvent(entry, sessionId, payload) {
    if (!entry?.ws) return;
    wsSend(entry.ws, sessionId ? { ...payload, sessionId } : payload);
  }

  function ensureCodexToolCall(entry, item, sessionId) {
    let tc = entry.toolCalls.find((t) => t.id === item.id);
    if (tc) {
      tc.name = codexToolName(item);
      tc.kind = item.type || tc.kind || null;
      tc.meta = codexToolMeta(item) || tc.meta || null;
      if (tc.input == null) tc.input = codexToolInput(item);
      updateEntryToolSegment(entry, item.id, {
        name: tc.name,
        input: tc.input,
        kind: tc.kind,
        meta: tc.meta,
      });
      return tc;
    }
    tc = {
      name: codexToolName(item),
      id: item.id,
      kind: item.type || null,
      meta: codexToolMeta(item),
      input: codexToolInput(item),
      done: false,
    };
    entry.toolCalls.push(tc);
    appendEntryToolSegment(entry, tc);
    sendSessionEvent(entry, sessionId, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: item.id,
      input: tc.input,
      kind: tc.kind,
      meta: tc.meta,
    });
    return tc;
  }

  function stageClaudeSessionState(entry, updates = {}) {
    if (!entry) return;
    if (updates.sessionId) entry.claudeRuntimeSessionId = updates.sessionId;
    if (typeof updates.costDelta === 'number') {
      entry.claudePendingCostDelta = (entry.claudePendingCostDelta || 0) + updates.costDelta;
      entry.claudeSessionTotalCost = (entry.claudeSessionTotalCost || 0) + updates.costDelta;
    }
    if (typeof updates.costTotal === 'number' && Number.isFinite(updates.costTotal)) {
      entry.claudePendingCostTotal = updates.costTotal;
      entry.claudeSessionTotalCost = updates.costTotal;
    }
  }

  function persistClaudeSessionState(entry, sessionId) {
    if (!entry) return null;
    const pendingSessionId = entry.claudeRuntimeSessionId || null;
    const pendingCostDelta = entry.claudePendingCostDelta || 0;
    const pendingCostTotal = Number.isFinite(entry.claudePendingCostTotal) ? entry.claudePendingCostTotal : null;
    const needsSessionIdPersist = pendingSessionId && pendingSessionId !== entry.persistedClaudeSessionId;
    if (!needsSessionIdPersist && !pendingCostDelta && pendingCostTotal === null) return null;

    const session = loadSession(sessionId);
    if (!session) return null;

    if (pendingSessionId) {
      if (typeof setRuntimeSessionState === 'function') {
        setRuntimeSessionState(session, {
          runtimeId: pendingSessionId,
          runtimeFingerprint: entry.claudeRuntimeFingerprint || null,
          channelDescriptor: entry.runtimeChannelDescriptor || null,
        }, {
          agent: 'claude',
          channelKey: entry.runtimeChannelKey || null,
          channelDescriptor: entry.runtimeChannelDescriptor || null,
        });
      } else {
        session.claudeSessionId = pendingSessionId;
        session.claudeRuntimeFingerprint = entry.claudeRuntimeFingerprint || session.claudeRuntimeFingerprint || null;
      }
      entry.persistedClaudeSessionId = pendingSessionId;
    }
    if (pendingCostDelta) {
      session.totalCost = (session.totalCost || 0) + pendingCostDelta;
      entry.claudePendingCostDelta = 0;
    }
    if (pendingCostTotal !== null) {
      const currentTotal = Number(session.totalCost) || 0;
      session.totalCost = Math.max(currentTotal, pendingCostTotal);
      entry.claudePendingCostTotal = null;
    }
    entry.claudeSessionTotalCost = session.totalCost || 0;
    saveSession(session);
    return session;
  }

  // Quiet-by-default tracking (avoid log spam / UI noise).
  const reportedUnknownEventTypes = new Set();
  const reportedInteractiveEventTypes = new Set();

  function emitInteractiveRequest(entry, sessionId, agent, event, classification) {
    const uiKey = `${sessionId || 'none'}:${agent}:${classification.type}`;
    if (reportedInteractiveEventTypes.has(uiKey)) return;
    reportedInteractiveEventTypes.add(uiKey);
    entry.waitingForInteractive = true;
    const payload = buildInteractiveRequestPayload(agent, event, classification, sessionId);
    sendSessionEvent(entry, sessionId, payload);
    // Keep a plain system line for older clients / history readability.
    sendSessionEvent(entry, sessionId, {
      type: 'system_message',
      message: payload.message,
    });
    plog('WARN', 'interactive_request_unsupported', {
      agent,
      type: classification.type,
      kind: classification.interactiveKind,
      sessionId: String(sessionId || '').slice(0, 8),
    });
  }

  function handleUnclassifiedRuntimeEvent(entry, sessionId, agent, event) {
    const classification = classifyRuntimeEvent(agent, event);
    if (classification.kind === 'handled' || classification.kind === 'lifecycle') {
      return classification;
    }
    if (classification.kind === 'interactive') {
      emitInteractiveRequest(entry, sessionId, agent, event, classification);
      return classification;
    }
    if (classification.kind === 'goal') {
      sendSessionEvent(entry, sessionId, {
        type: 'system_message',
        message: classification.summary,
      });
      sendSessionEvent(entry, sessionId, {
        type: 'goal_update',
        sessionId,
        agent,
        summary: classification.summary,
        rawType: classification.type,
      });
      return classification;
    }
    // unknown
    const type = classification.type || 'unknown';
    const logKey = `${agent}:${type}`;
    if (!reportedUnknownEventTypes.has(logKey)) {
      reportedUnknownEventTypes.add(logKey);
      plog('WARN', 'unknown_runtime_event', {
        agent,
        type,
        keys: Object.keys(event || {}).slice(0, 16),
      });
    }
    return classification;
  }

  function processClaudeEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system':
        if (event.session_id) {
          stageClaudeSessionState(entry, { sessionId: event.session_id });
          persistClaudeSessionState(entry, sessionId);
        }
        if (event.model) {
          entry.resolvedModel = String(event.model);
        } else if (event.message?.model) {
          entry.resolvedModel = String(event.message.model);
        }
        if (Array.isArray(event.slash_commands) && typeof onSlashCommandsDiscovered === 'function') {
          onSlashCommandsDiscovered('claude', event.slash_commands);
        }
        // Some Claude builds surface permission prompts under system subtype.
        {
          const classification = classifyRuntimeEvent('claude', event);
          if (classification.kind === 'interactive') {
            emitInteractiveRequest(entry, sessionId, 'claude', event, classification);
          }
        }
        break;

      case 'assistant': {
        if (event.message?.model) {
          entry.resolvedModel = String(event.message.model);
        }
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            // Avoid duplicating text already streamed via stream_event deltas.
            const incoming = String(block.text);
            if (entry.fullText === incoming) {
              // already have exact content
            } else if (entry.fullText && incoming.startsWith(entry.fullText)) {
              const next = incoming.slice(entry.fullText.length);
              if (next) {
                entry.fullText = incoming;
                appendEntryTextSegment(entry, next);
                sendSessionEvent(entry, sessionId, { type: 'text_delta', text: next });
              }
            } else if (!entry.fullText || !entry.fullText.includes(incoming)) {
              entry.fullText = (entry.fullText || '') + incoming;
              appendEntryTextSegment(entry, incoming);
              sendSessionEvent(entry, sessionId, { type: 'text_delta', text: incoming });
            }
          } else if (
            (block.type === 'thinking' || block.type === 'redacted_thinking')
            && (block.thinking || block.text)
          ) {
            // Extended thinking: stream as process content, do not pollute final answer text.
            const thinkingText = String(block.thinking || block.text || '');
            if (!thinkingText) continue;
            appendEntryTextSegment(entry, thinkingText, { phase: 'thinking' });
            sendSessionEvent(entry, sessionId, { type: 'thinking_delta', text: thinkingText });
          } else if (block.type === 'tool_use') {
            const toolInput = sanitizeToolInput(block.name, block.input);
            const tc = { name: block.name, id: block.id, input: toolInput, done: false };
            entry.toolCalls.push(tc);
            appendEntryToolSegment(entry, tc);
            sendSessionEvent(entry, sessionId, {
              type: 'tool_start',
              name: block.name,
              toolUseId: block.id,
              input: tc.input,
            });
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => c.text || '').join('\n')
                : JSON.stringify(block.content);
            const truncatedResult = truncateToolResult(resultText);
            const tc = entry.toolCalls.find((t) => t.id === block.tool_use_id);
            if (tc) {
              tc.done = true;
              tc.result = truncatedResult;
            }
            updateEntryToolSegment(entry, block.tool_use_id, {
              done: true,
              result: truncatedResult,
            });
            sendSessionEvent(entry, sessionId, {
              type: 'tool_end',
              toolUseId: block.tool_use_id,
              result: truncatedResult,
            });
          }
        }

        if (event.session_id) {
          stageClaudeSessionState(entry, { sessionId: event.session_id });
          persistClaudeSessionState(entry, sessionId);
        }
        break;
      }

      case 'result': {
        const parsedCost = Number(event.total_cost_usd);
        const totalCostUsd = Number.isFinite(parsedCost) ? parsedCost : null;
        if (event.session_id) {
          stageClaudeSessionState(entry, { sessionId: event.session_id });
        }
        if (totalCostUsd !== null) {
          stageClaudeSessionState(entry, { costTotal: totalCostUsd });
        }
        // Some builds only put the final answer on result.result (no assistant text blocks).
        if (!entry.fullText && typeof event.result === 'string' && event.result.trim()) {
          const text = event.result;
          entry.fullText = text;
          appendEntryTextSegment(entry, text);
          sendSessionEvent(entry, sessionId, { type: 'text_delta', text });
        }
        if (event.model) entry.resolvedModel = String(event.model);
        persistClaudeSessionState(entry, sessionId);
        entry.lastCost = totalCostUsd;
        if (entry.ws && event.total_cost_usd !== undefined) {
          sendSessionEvent(entry, sessionId, { type: 'cost', costUsd: entry.claudeSessionTotalCost || 0 });
        }
        if (event.is_error && !entry.lastError) {
          const errMsg = typeof event.result === 'string' && event.result.trim()
            ? event.result.trim()
            : 'Claude 返回了错误结果';
          entry.lastError = errMsg;
        }
        // permission_denials is a field on result, not a separate event type.
        if (Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
          const count = event.permission_denials.length;
          sendSessionEvent(entry, sessionId, {
            type: 'system_message',
            message: `Claude 报告 ${count} 条权限拒绝（permission_denials）。若任务未完成，请切换 YOLO 或在原生 CLI 中处理审批。`,
          });
        }
        break;
      }

      case 'stream_event': {
        // Incremental stream-json (content_block_delta) used by some Claude Code builds.
        const inner = event.event || event.data || event;
        const innerType = inner?.type || '';
        if (innerType === 'content_block_delta') {
          const delta = inner.delta || {};
          if ((delta.type === 'text_delta' || delta.type === 'text') && delta.text) {
            entry.fullText = (entry.fullText || '') + delta.text;
            appendEntryTextSegment(entry, delta.text);
            sendSessionEvent(entry, sessionId, { type: 'text_delta', text: delta.text });
            entry._claudeStreamedText = true;
          } else if (
            (delta.type === 'thinking_delta' || delta.type === 'thinking')
            && (delta.thinking || delta.text)
          ) {
            const thinkingText = String(delta.thinking || delta.text || '');
            if (thinkingText) {
              appendEntryTextSegment(entry, thinkingText, { phase: 'thinking' });
              sendSessionEvent(entry, sessionId, { type: 'thinking_delta', text: thinkingText });
            }
          }
        } else if (innerType === 'content_block_start' && inner.content_block?.type === 'tool_use') {
          const block = inner.content_block;
          if (block.id && block.name) {
            const toolInput = sanitizeToolInput(block.name, block.input || {});
            const tc = { name: block.name, id: block.id, input: toolInput, done: false };
            if (!entry.toolCalls.find((t) => t.id === block.id)) {
              entry.toolCalls.push(tc);
              appendEntryToolSegment(entry, tc);
              sendSessionEvent(entry, sessionId, {
                type: 'tool_start',
                name: block.name,
                toolUseId: block.id,
                input: tc.input,
              });
            }
          }
        }
        break;
      }

      case 'user':
        // User echo in stream-json — ignore quietly.
        break;

      default:
        handleUnclassifiedRuntimeEvent(entry, sessionId, 'claude', event);
        break;
    }
  }

  function processCodexEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'thread.started': {
        if (!event.thread_id) break;
        const session = loadSession(sessionId);
        if (session) {
          if (typeof setRuntimeSessionState === 'function') {
            setRuntimeSessionState(session, {
              runtimeId: event.thread_id,
              runtimeFingerprint: entry.codexRuntimeFingerprint || null,
              channelDescriptor: entry.runtimeChannelDescriptor || null,
            }, {
              agent: 'codex',
              channelKey: entry.runtimeChannelKey || null,
              channelDescriptor: entry.runtimeChannelDescriptor || null,
            });
          } else {
            setRuntimeSessionId(session, event.thread_id);
            session.codexRuntimeFingerprint = entry.codexRuntimeFingerprint || session.codexRuntimeFingerprint || null;
          }
          saveSession(session);
        }
        break;
      }

      case 'item.started': {
        const item = event.item;
        if (!item || !item.id || item.type === 'agent_message') break;
        ensureCodexToolCall(entry, item, sessionId);
        break;
      }

      // Prefer incremental text when CLI emits item.updated / item.delta variants.
      case 'item.updated':
      case 'item.delta': {
        const item = event.item || event;
        if (!item) break;
        const deltaText = (typeof item.text === 'string' ? item.text : '')
          || (typeof item.delta === 'string' ? item.delta : '')
          || (typeof item.delta?.text === 'string' ? item.delta.text : '')
          || (typeof item.content === 'string' ? item.content : '');
        const isAgentMessage = !item.type || item.type === 'agent_message' || event.type === 'item.delta';
        if (isAgentMessage && deltaText) {
          // Avoid double-counting: only stream deltas that are true suffixes not already in fullText.
          if (entry.fullText && deltaText.startsWith(entry.fullText) && deltaText.length > entry.fullText.length) {
            const next = deltaText.slice(entry.fullText.length);
            entry.fullText = deltaText;
            appendEntryTextSegment(entry, next);
            sendSessionEvent(entry, sessionId, { type: 'text_delta', text: next });
          } else if (!entry.fullText || !entry.fullText.endsWith(deltaText)) {
            entry.fullText = (entry.fullText || '') + deltaText;
            appendEntryTextSegment(entry, deltaText);
            sendSessionEvent(entry, sessionId, { type: 'text_delta', text: deltaText });
          }
        }
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (!item || !item.id) break;
        if (item.type === 'agent_message') {
          if (item.text) {
            // If incremental streaming already built fullText, only send the remaining suffix.
            let nextText = '';
            if (!entry.fullText) {
              nextText = item.text;
              entry.fullText = item.text;
            } else if (entry.fullText === item.text) {
              nextText = '';
            } else if (item.text.startsWith(entry.fullText)) {
              nextText = item.text.slice(entry.fullText.length);
              entry.fullText = item.text;
            } else {
              nextText = item.text;
              entry.fullText += item.text;
            }
            if (nextText) {
              appendEntryTextSegment(entry, nextText);
              sendSessionEvent(entry, sessionId, { type: 'text_delta', text: nextText });
            }
          }
          break;
        }
        if (item.type === 'error') {
          const warningMessage = formatCodexItemErrorMessage(item);
          if (warningMessage) {
            sendSessionEvent(entry, sessionId, { type: 'system_message', message: warningMessage });
          }
          break;
        }
        const tc = ensureCodexToolCall(entry, item, sessionId);
        const resultText = truncateToolResult(codexToolResult(item));
        tc.done = true;
        tc.result = resultText;
        updateEntryToolSegment(entry, item.id, {
          done: true,
          result: resultText,
          kind: tc.kind,
          meta: tc.meta,
        });
        sendSessionEvent(entry, sessionId, {
          type: 'tool_end',
          toolUseId: item.id,
          result: resultText,
          kind: tc.kind,
          meta: tc.meta,
        });
        break;
      }

      case 'turn.completed': {
        const usage = event.usage || null;
        entry.lastUsage = usage;
        const session = loadSession(sessionId);
        if (session && usage) {
          session.totalUsage = {
            inputTokens: (session.totalUsage?.inputTokens || 0) + (usage.input_tokens || 0),
            cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + (usage.cached_input_tokens || 0),
            outputTokens: (session.totalUsage?.outputTokens || 0) + (usage.output_tokens || 0),
          };
          saveSession(session);
          sendSessionEvent(entry, sessionId, { type: 'usage', totalUsage: session.totalUsage });
        }
        break;
      }

      case 'turn.failed': {
        const message = event.error?.message || 'Codex 任务失败';
        entry.lastError = message;
        break;
      }

      case 'error':
        if (event.message) {
          if (/^Reconnecting\.\.\./.test(event.message)) {
            sendSessionEvent(entry, sessionId, { type: 'system_message', message: event.message });
          } else {
            entry.lastError = event.message;
          }
        }
        break;

      case 'turn.started':
        break;

      case 'thread.token_usage_updated':
      case 'item.reasoning':
      case 'mcp_startup_update':
      case 'mcp_startup_complete':
        // Harmless lifecycle / usage noise in recent Codex JSON streams.
        break;

      case 'thread_goal_updated':
        handleUnclassifiedRuntimeEvent(entry, sessionId, 'codex', event);
        break;

      case 'exec_approval_request':
      case 'apply_patch_approval_request':
      case 'request_permissions':
      case 'request_user_input':
      case 'elicitation_request':
      case 'guardian_assessment':
      case 'dynamic_tool_call_request':
        handleUnclassifiedRuntimeEvent(entry, sessionId, 'codex', event);
        break;

      default:
        handleUnclassifiedRuntimeEvent(entry, sessionId, 'codex', event);
        break;
    }
  }

  function piToolResultText(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result?.content)) {
      return result.content.map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'text') return c.text || '';
        return JSON.stringify(c);
      }).join('\n');
    }
    if (typeof result?.text === 'string') return result.text;
    return JSON.stringify(truncateObj(result, 1200));
  }

  function stagePiSessionState(entry, updates = {}) {
    if (!entry) return;
    if (updates.sessionId) entry.piRuntimeSessionId = updates.sessionId;
    if (typeof updates.costDelta === 'number' && Number.isFinite(updates.costDelta)) {
      entry.piPendingCostDelta = (entry.piPendingCostDelta || 0) + updates.costDelta;
      entry.piSessionTotalCost = (entry.piSessionTotalCost || 0) + updates.costDelta;
    }
    if (updates.usage && typeof updates.usage === 'object') {
      entry.piLastUsage = updates.usage;
    }
  }

  function persistPiSessionState(entry, sessionId) {
    if (!entry) return null;
    const pendingSessionId = entry.piRuntimeSessionId || null;
    const pendingCostDelta = entry.piPendingCostDelta || 0;
    const usage = entry.piLastUsage || null;
    const needsSessionIdPersist = pendingSessionId && pendingSessionId !== entry.persistedPiSessionId;
    if (!needsSessionIdPersist && !pendingCostDelta && !usage) return null;

    const session = loadSession(sessionId);
    if (!session) return null;

    if (pendingSessionId) {
      if (typeof setRuntimeSessionState === 'function') {
        setRuntimeSessionState(session, {
          runtimeId: pendingSessionId,
          runtimeFingerprint: entry.piRuntimeFingerprint || null,
          channelDescriptor: entry.runtimeChannelDescriptor || null,
        }, {
          agent: 'pi',
          channelKey: entry.runtimeChannelKey || null,
          channelDescriptor: entry.runtimeChannelDescriptor || null,
        });
      } else {
        setRuntimeSessionId(session, pendingSessionId);
      }
      entry.persistedPiSessionId = pendingSessionId;
    }
    if (pendingCostDelta) {
      session.totalCost = (session.totalCost || 0) + pendingCostDelta;
      entry.piPendingCostDelta = 0;
    }
    if (usage) {
      session.totalUsage = {
        inputTokens: (session.totalUsage?.inputTokens || 0) + (usage.input || usage.input_tokens || 0),
        cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + (usage.cacheRead || usage.cached_input_tokens || 0),
        outputTokens: (session.totalUsage?.outputTokens || 0) + (usage.output || usage.output_tokens || 0),
      };
      entry.piLastUsage = null;
      sendSessionEvent(entry, sessionId, { type: 'usage', totalUsage: session.totalUsage });
    }
    entry.piSessionTotalCost = session.totalCost || 0;
    saveSession(session);
    return session;
  }

  function ensurePiToolCall(entry, toolCallId, toolName, args, sessionId) {
    if (!toolCallId) return null;
    let tc = entry.toolCalls.find((t) => t.id === toolCallId);
    if (tc) {
      if (toolName) tc.name = toolName;
      if (args != null && tc.input == null) {
        tc.input = sanitizeToolInput(toolName || tc.name, args);
        updateEntryToolSegment(entry, toolCallId, { name: tc.name, input: tc.input });
      }
      return tc;
    }
    const input = args != null ? sanitizeToolInput(toolName, args) : null;
    tc = {
      name: toolName || 'Tool',
      id: toolCallId,
      input,
      done: false,
    };
    entry.toolCalls.push(tc);
    appendEntryToolSegment(entry, tc);
    sendSessionEvent(entry, sessionId, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: toolCallId,
      input: tc.input,
    });
    return tc;
  }

  function processPiEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'session': {
        if (event.id) {
          stagePiSessionState(entry, { sessionId: event.id });
          persistPiSessionState(entry, sessionId);
        }
        break;
      }

      case 'message_update': {
        const ae = event.assistantMessageEvent || {};
        const aeType = ae.type || '';
        if (aeType === 'text_delta' && typeof ae.delta === 'string' && ae.delta) {
          entry.fullText = (entry.fullText || '') + ae.delta;
          appendEntryTextSegment(entry, ae.delta);
          sendSessionEvent(entry, sessionId, { type: 'text_delta', text: ae.delta });
        } else if (aeType === 'thinking_delta' && typeof ae.delta === 'string' && ae.delta) {
          appendEntryTextSegment(entry, ae.delta, { phase: 'thinking' });
          sendSessionEvent(entry, sessionId, { type: 'thinking_delta', text: ae.delta });
        } else if ((aeType === 'toolcall_start' || aeType === 'toolcall_end') && ae.toolCall) {
          const tool = ae.toolCall;
          ensurePiToolCall(entry, tool.id, tool.name, tool.arguments || tool.args, sessionId);
        }
        break;
      }

      case 'message_end': {
        const msg = event.message;
        if (!msg) break;
        if (msg.role === 'assistant') {
          // Pi JSON mode can surface failures with stopReason=error and exit 0.
          if (msg.stopReason === 'error' || msg.stop_reason === 'error') {
            const errMsg = String(msg.errorMessage || msg.error_message || msg.error || '').trim()
              || 'Pi 请求失败';
            entry.lastError = errMsg;
            sendSessionEvent(entry, sessionId, {
              type: 'error',
              message: errMsg,
            });
            entry.errorSent = true;
          }
          if (msg.model) {
            const provider = msg.provider ? `${msg.provider}/` : '';
            // Prefer bare model id; prefix provider only when useful and not already present.
            const modelId = String(msg.model).includes('/')
              ? String(msg.model)
              : (provider ? `${msg.provider}/${msg.model}` : String(msg.model));
            entry.resolvedModel = modelId;
          }
          // Fallback: if streaming missed text, take final text blocks once.
          if (!entry.fullText && Array.isArray(msg.content)) {
            const text = msg.content
              .filter((b) => b && b.type === 'text' && b.text)
              .map((b) => b.text)
              .join('');
            if (text) {
              entry.fullText = text;
              appendEntryTextSegment(entry, text);
              sendSessionEvent(entry, sessionId, { type: 'text_delta', text });
            }
          }
          const usage = msg.usage || null;
          if (usage) {
            const cost = Number(usage.cost?.total);
            if (Number.isFinite(cost) && cost > 0) {
              stagePiSessionState(entry, { costDelta: cost });
              entry.lastCost = (entry.lastCost || 0) + cost;
            }
            stagePiSessionState(entry, { usage });
            persistPiSessionState(entry, sessionId);
            if (entry.ws && Number.isFinite(cost) && cost > 0) {
              sendSessionEvent(entry, sessionId, {
                type: 'cost',
                costUsd: entry.piSessionTotalCost || 0,
              });
            }
          }
        } else if (msg.role === 'toolResult' && msg.toolCallId) {
          // tool_execution_end usually lands first; only fill gaps if still open.
          const existing = entry.toolCalls.find((t) => t.id === msg.toolCallId);
          if (existing?.done) break;
          const resultText = truncateToolResult(piToolResultText(msg));
          const tc = ensurePiToolCall(entry, msg.toolCallId, msg.toolName, null, sessionId);
          if (tc) {
            tc.done = true;
            tc.result = resultText;
          }
          updateEntryToolSegment(entry, msg.toolCallId, { done: true, result: resultText });
          sendSessionEvent(entry, sessionId, {
            type: 'tool_end',
            toolUseId: msg.toolCallId,
            result: resultText,
          });
        }
        break;
      }

      case 'tool_execution_start': {
        ensurePiToolCall(
          entry,
          event.toolCallId,
          event.toolName,
          event.args,
          sessionId,
        );
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        if (!toolCallId) break;
        const resultText = truncateToolResult(piToolResultText(event.result));
        const tc = ensurePiToolCall(entry, toolCallId, event.toolName, event.args, sessionId);
        if (tc) {
          tc.done = true;
          tc.result = resultText;
        }
        updateEntryToolSegment(entry, toolCallId, { done: true, result: resultText });
        sendSessionEvent(entry, sessionId, {
          type: 'tool_end',
          toolUseId: toolCallId,
          result: resultText,
        });
        break;
      }

      case 'turn_end':
      case 'agent_end':
      case 'agent_start':
      case 'turn_start':
      case 'message_start':
      case 'tool_execution_update':
        // Lifecycle / partial tool noise — usage/cost applied on message_end.
        break;

      default:
        handleUnclassifiedRuntimeEvent(entry, sessionId, 'pi', event);
        break;
    }
  }

  function processRuntimeEvent(entry, event, sessionId) {
    if (entry.agent === 'codex') processCodexEvent(entry, event, sessionId);
    else if (entry.agent === 'pi') processPiEvent(entry, event, sessionId);
    else processClaudeEvent(entry, event, sessionId);
  }

  return {
    buildClaudeSpawnSpec,
    buildCodexSpawnSpec,
    buildPiSpawnSpec,
    processClaudeEvent,
    processCodexEvent,
    processPiEvent,
    processRuntimeEvent,
  };
}

module.exports = { createAgentRuntime };
