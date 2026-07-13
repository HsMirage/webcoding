/**
 * Headless runtime capability catalog & event classifier.
 *
 * Claude/Codex use stream-json / `codex exec --json`; Pi can use this catalog
 * for its compatibility headless transport. The server overrides Pi capabilities
 * when the bidirectional RPC transport is active.
 * Interactive approvals and AskUser protocols are catalogued here so we can:
 *  1) classify events honestly (no silent drop of approval requests)
 *  2) advertise what headless mode can / cannot do
 *  3) avoid inventing fake approval UI until a bidirectional channel exists
 *
 * Event names for Codex are taken from the CLI binary + live probes (2026-07).
 * Claude stream-json probe (plan mode, simple prompt): system.init, assistant, result.
 */

'use strict';

/** Codex JSON stream types that are normal headless lifecycle / work events. */
const CODEX_HANDLED_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.delta',
  'item.completed',
  'error',
]);

/** Codex noise we intentionally ignore (no UI spam). */
const CODEX_LIFECYCLE_NOISE = new Set([
  'thread.token_usage_updated',
  'item.reasoning',
  'mcp_startup_update',
  'mcp_startup_complete',
]);

/**
 * Codex interactive / approval / elicitation event types observed in CLI binary.
 * These require a bidirectional client in TUI/app-server; headless exec has no reply channel.
 */
const CODEX_INTERACTIVE_TYPES = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'request_permissions',
  'request_user_input',
  'elicitation_request',
  'guardian_assessment',
  'dynamic_tool_call_request',
]);

/** Codex structured goal updates (stable feature flag: goals). */
const CODEX_GOAL_TYPES = new Set([
  'thread_goal_updated',
  'thread_goal_cleared',
]);

/** Claude stream-json types handled by processClaudeEvent. */
const CLAUDE_HANDLED_TYPES = new Set([
  'system',
  'assistant',
  'result',
  'user',
  'stream_event',
]);

/**
 * Claude interactive markers (subtype / type). Headless `-p` has no permission reply channel.
 * permission_denials also appears on result as a list field (not a separate event type).
 */
const CLAUDE_INTERACTIVE_SUBTYPES = new Set([
  'permission_prompt',
  'can_use_tool',
  'ask_user',
  'user_input',
  'approval',
]);

/** Pi `pi -p --mode json` event types handled by processPiEvent. */
const PI_HANDLED_TYPES = new Set([
  'session',
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
]);

/** Pi interactive markers (rare in print mode; Pi has no built-in permission system). */
const PI_INTERACTIVE_TYPES = new Set([
  'permission_request',
  'ask_user',
  'user_input_request',
]);

function normalizeEventType(event) {
  return String(event?.type || '').trim();
}

function interactiveKindFromType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('patch') || t.includes('apply_patch')) return 'patch_approval';
  if (t.includes('exec') && t.includes('approval')) return 'exec_approval';
  if (t.includes('permission')) return 'permission';
  if (t.includes('elicitation')) return 'elicitation';
  if (t.includes('user_input') || t.includes('ask_user') || t.includes('request_user')) return 'user_input';
  if (t.includes('guardian')) return 'guardian';
  if (t.includes('goal')) return 'goal';
  return 'interactive';
}

/**
 * Classify a single runtime event for headless Webcoding.
 * @returns {{
 *   kind: 'handled'|'lifecycle'|'interactive'|'goal'|'unknown',
 *   type: string,
 *   interactiveKind?: string,
 *   respondable: boolean,
 *   summary: string,
 * }}
 */
function normalizeAgentName(agent) {
  if (agent === 'codex') return 'codex';
  if (agent === 'pi') return 'pi';
  return 'claude';
}

function classifyRuntimeEvent(agent, event) {
  const normalizedAgent = normalizeAgentName(agent);
  const type = normalizeEventType(event);
  if (!type) {
    return {
      kind: 'unknown',
      type: 'unknown',
      respondable: false,
      summary: 'empty event type',
    };
  }

  if (normalizedAgent === 'codex') {
    if (CODEX_HANDLED_TYPES.has(type)) {
      return { kind: 'handled', type, respondable: false, summary: type };
    }
    if (CODEX_LIFECYCLE_NOISE.has(type)) {
      return { kind: 'lifecycle', type, respondable: false, summary: type };
    }
    if (CODEX_GOAL_TYPES.has(type)) {
      return {
        kind: 'goal',
        type,
        interactiveKind: 'goal',
        respondable: false,
        summary: summarizeCodexGoalEvent(event),
      };
    }
    if (CODEX_INTERACTIVE_TYPES.has(type)) {
      return {
        kind: 'interactive',
        type,
        interactiveKind: interactiveKindFromType(type),
        respondable: false,
        summary: summarizeCodexInteractiveEvent(event),
      };
    }
    // Nested item-shaped interactive markers (defensive)
    const itemType = event?.item?.type;
    if (itemType && CODEX_INTERACTIVE_TYPES.has(itemType)) {
      return {
        kind: 'interactive',
        type: itemType,
        interactiveKind: interactiveKindFromType(itemType),
        respondable: false,
        summary: summarizeCodexInteractiveEvent({ ...event, type: itemType }),
      };
    }
    return {
      kind: 'unknown',
      type,
      respondable: false,
      summary: `unknown codex event: ${type}`,
    };
  }

  if (normalizedAgent === 'pi') {
    if (PI_HANDLED_TYPES.has(type)) {
      return { kind: 'handled', type, respondable: false, summary: type };
    }
    if (PI_INTERACTIVE_TYPES.has(type) || /permission|approval|ask_user|user_input/i.test(type)) {
      return {
        kind: 'interactive',
        type,
        interactiveKind: interactiveKindFromType(type),
        respondable: false,
        summary: `Pi interactive event: ${type}`,
      };
    }
    return {
      kind: 'unknown',
      type,
      respondable: false,
      summary: `unknown pi event: ${type}`,
    };
  }

  // Claude
  if (CLAUDE_HANDLED_TYPES.has(type)) {
    const subtype = String(event?.subtype || '');
    if (type === 'system' && subtype && CLAUDE_INTERACTIVE_SUBTYPES.has(subtype)) {
      return {
        kind: 'interactive',
        type: `system.${subtype}`,
        interactiveKind: interactiveKindFromType(subtype),
        respondable: false,
        summary: `Claude interactive system subtype: ${subtype}`,
      };
    }
    return { kind: 'handled', type, respondable: false, summary: type };
  }
  if (CLAUDE_INTERACTIVE_SUBTYPES.has(type) || /permission|approval|ask_user|user_input|can_use_tool/i.test(type)) {
    return {
      kind: 'interactive',
      type,
      interactiveKind: interactiveKindFromType(type),
      respondable: false,
      summary: `Claude interactive event: ${type}`,
    };
  }
  return {
    kind: 'unknown',
    type,
    respondable: false,
    summary: `unknown claude event: ${type}`,
  };
}

function summarizeCodexInteractiveEvent(event) {
  const type = normalizeEventType(event);
  const item = event?.item || event;
  const command = item?.command || item?.cmd || event?.command || '';
  const path = item?.path || item?.file_path || '';
  const reason = item?.reason || event?.reason || '';
  const parts = [`Codex 交互请求: ${type}`];
  if (command) parts.push(`命令: ${String(command).slice(0, 160)}`);
  if (path) parts.push(`路径: ${String(path).slice(0, 120)}`);
  if (reason) parts.push(`原因: ${String(reason).slice(0, 160)}`);
  return parts.join('\n');
}

function summarizeCodexGoalEvent(event) {
  const goal = event?.goal || event?.thread_goal || event?.item || event;
  if (normalizeEventType(event) === 'thread_goal_cleared') return 'Codex Goals 已清除';
  const title = goal?.objective || goal?.title || goal?.name || goal?.text || '';
  const status = goal?.status || goal?.state || '';
  const parts = ['Codex Goals 更新'];
  if (title) parts.push(`目标: ${String(title).slice(0, 160)}`);
  if (status) parts.push(`状态: ${status}`);
  return parts.join('\n');
}

/**
 * Static headless capability matrix (protocol-level; not a TUI feature list).
 */
function getStaticHeadlessCapabilities(agent, extras = {}) {
  const normalizedAgent = normalizeAgentName(agent);
  const protocol = normalizedAgent === 'codex'
    ? 'codex-exec-json'
    : normalizedAgent === 'pi'
      ? 'pi-print-json'
      : 'claude-stream-json';
  const knownInteractive = normalizedAgent === 'codex'
    ? [...CODEX_INTERACTIVE_TYPES]
    : normalizedAgent === 'pi'
      ? [...PI_INTERACTIVE_TYPES]
      : [...CLAUDE_INTERACTIVE_SUBTYPES];
  const knownHandled = normalizedAgent === 'codex'
    ? [...CODEX_HANDLED_TYPES]
    : normalizedAgent === 'pi'
      ? [...PI_HANDLED_TYPES]
      : [...CLAUDE_HANDLED_TYPES];
  return {
    agent: normalizedAgent,
    headless: true,
    protocol,
    // Bidirectional interactive channels — not available in file-I/O headless spawn.
    interactiveApproval: false,
    askUser: false,
    planConfirmUi: false,
    goalsStructured: normalizedAgent === 'codex', // can *observe* thread_goal_updated if emitted
    goalsWritable: false,
    respondableInteractiveKinds: [],
    knownInteractiveEventTypes: knownInteractive,
    knownHandledEventTypes: knownHandled,
    notes: [
      'Webcoding 通过 headless CLI 运行（Claude stream-json / Codex exec --json / Pi --mode json），不是完整 TUI。',
      '审批 / AskUser / 计划确认需要双向通道；当前 file-I/O spawn 只能检测并提示，不能回应。',
      '探测（yolo/full-auto 简单往返）仅产生 lifecycle + message 事件，不会出现审批事件——这是预期。',
      ...(normalizedAgent === 'pi'
        ? ['Pi 无内置权限系统；Plan 模式映射为只读工具集（read/grep/find/ls）。']
        : []),
    ],
    ...extras,
  };
}

/**
 * Build a WS payload for the browser when an interactive event is observed.
 */
function buildInteractiveRequestPayload(agent, event, classification, sessionId) {
  const normalizedAgent = normalizeAgentName(agent);
  const label = normalizedAgent === 'codex' ? 'Codex' : normalizedAgent === 'pi' ? 'Pi' : 'Claude';
  const kind = classification.interactiveKind || 'interactive';
  return {
    type: 'interactive_request',
    sessionId: sessionId || null,
    agent: normalizedAgent,
    eventType: classification.type,
    interactiveKind: kind,
    respondable: false,
    summary: classification.summary || `${label} interactive: ${classification.type}`,
    message: [
      `${label} 发出交互请求「${classification.type}」（${kind}）。`,
      '当前 headless 适配层不能双向回应该请求。',
      '请点击停止结束本轮，并在终端原生 CLI 中完成交互；或切换到不会触发审批的权限模式（如 YOLO）。',
    ].join('\n'),
  };
}

module.exports = {
  CODEX_HANDLED_TYPES,
  CODEX_LIFECYCLE_NOISE,
  CODEX_INTERACTIVE_TYPES,
  CODEX_GOAL_TYPES,
  CLAUDE_HANDLED_TYPES,
  CLAUDE_INTERACTIVE_SUBTYPES,
  PI_HANDLED_TYPES,
  PI_INTERACTIVE_TYPES,
  classifyRuntimeEvent,
  getStaticHeadlessCapabilities,
  buildInteractiveRequestPayload,
  interactiveKindFromType,
  normalizeAgentName,
};
