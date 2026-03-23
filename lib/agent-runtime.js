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
    MODEL_MAP,
    loadModelConfig,
    applyCustomTemplateToSettings,
    getClaudeRuntimeFingerprint,
    loadCodexConfig,
    prepareCodexCustomRuntime,
    getCodexRuntimeFingerprint,
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
  } = deps;

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
    'NO_PROXY',
  ]);
  const CHILD_ENV_PREFIX_ALLOWLIST = ['LC_'];
  const MAX_TOOL_RESULT_LENGTH = 2000;

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
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;

    for (const [key, value] of Object.entries(extra || {})) {
      if (value === undefined || value === null) {
        delete env[key];
      } else {
        env[key] = String(value);
      }
    }
    return env;
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
    if (agent !== 'codex') return true;
    const currentScope = codexRuntimeStorageScope(currentState?.descriptor || null);
    const fallbackScope = codexRuntimeStorageScope(fallbackState?.descriptor || null);
    if (!currentScope || !fallbackScope) return false;
    return currentScope === fallbackScope;
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

    const env = sanitizeChildEnv();

    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate);
      if (tpl) applyCustomTemplateToSettings(tpl);
    }

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
      useShell: shouldUseShellForCommand(CLAUDE_PATH),
    };
  }

  function buildCodexSpawnSpec(session, options = {}) {
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
    const args = ['exec'];
    if (runtimeId) args.push('resume');
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

    if (session.model) args.push('--model', session.model);
    if (Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) args.push('--image', attachment.path);
      }
    }
    if (runtimeId) {
      args.push(runtimeId, '-');
    } else {
      if (session.cwd) args.push('-C', session.cwd);
      args.push('-');
    }

    const envOverrides = {};
    if (runtimeConfig?.mode === 'custom') {
      envOverrides.CODEX_HOME = runtimeConfig.homeDir;
      envOverrides.OPENAI_API_KEY = runtimeConfig.apiKey;
      envOverrides.OPENAI_BASE_URL = null;
    }
    const env = sanitizeChildEnv(envOverrides);

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
      useShell: shouldUseShellForCommand(CODEX_PATH),
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
        return 'Reasoning';
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
          title: 'Reasoning',
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

  function appendEntryTextSegment(entry, text) {
    if (!entry || typeof text !== 'string' || !text) return;
    if (!Array.isArray(entry.segments)) entry.segments = [];
    const last = entry.segments[entry.segments.length - 1];
    if (last && last.type === 'text') {
      last.text = `${last.text || ''}${text}`;
      return;
    }
    entry.segments.push({ type: 'text', text });
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

  function ensureCodexToolCall(entry, item) {
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
    wsSend(entry.ws, {
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

  function processClaudeEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system':
        if (event.session_id) {
          stageClaudeSessionState(entry, { sessionId: event.session_id });
          persistClaudeSessionState(entry, sessionId);
        }
        break;

      case 'assistant': {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            entry.fullText += block.text;
            appendEntryTextSegment(entry, block.text);
            wsSend(entry.ws, { type: 'text_delta', text: block.text });
          } else if (block.type === 'tool_use') {
            const toolInput = sanitizeToolInput(block.name, block.input);
            const tc = { name: block.name, id: block.id, input: toolInput, done: false };
            entry.toolCalls.push(tc);
            appendEntryToolSegment(entry, tc);
            wsSend(entry.ws, { type: 'tool_start', name: block.name, toolUseId: block.id, input: tc.input });
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
            wsSend(entry.ws, { type: 'tool_end', toolUseId: block.tool_use_id, result: truncatedResult });
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
        persistClaudeSessionState(entry, sessionId);
        entry.lastCost = totalCostUsd;
        if (entry.ws && event.total_cost_usd !== undefined) {
          wsSend(entry.ws, { type: 'cost', costUsd: entry.claudeSessionTotalCost || 0 });
        }
        break;
      }
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
        ensureCodexToolCall(entry, item);
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (!item || !item.id) break;
        if (item.type === 'agent_message') {
          if (item.text) {
            entry.fullText += item.text;
            appendEntryTextSegment(entry, item.text);
            wsSend(entry.ws, { type: 'text_delta', text: item.text });
          }
          break;
        }
        if (item.type === 'error') {
          const warningMessage = formatCodexItemErrorMessage(item);
          if (warningMessage) {
            wsSend(entry.ws, { type: 'system_message', message: warningMessage });
          }
          break;
        }
        const tc = ensureCodexToolCall(entry, item);
        const resultText = truncateToolResult(codexToolResult(item));
        tc.done = true;
        tc.result = resultText;
        updateEntryToolSegment(entry, item.id, {
          done: true,
          result: resultText,
          kind: tc.kind,
          meta: tc.meta,
        });
        wsSend(entry.ws, {
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
          wsSend(entry.ws, { type: 'usage', totalUsage: session.totalUsage });
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
            wsSend(entry.ws, { type: 'system_message', message: event.message });
          } else {
            entry.lastError = event.message;
          }
        }
        break;
    }
  }

  function processRuntimeEvent(entry, event, sessionId) {
    if (entry.agent === 'codex') processCodexEvent(entry, event, sessionId);
    else processClaudeEvent(entry, event, sessionId);
  }

  return {
    buildClaudeSpawnSpec,
    buildCodexSpawnSpec,
    processClaudeEvent,
    processCodexEvent,
    processRuntimeEvent,
  };
}

module.exports = { createAgentRuntime };
