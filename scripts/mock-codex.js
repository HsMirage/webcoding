#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAppServer() {
  const rl = readline.createInterface({ input: process.stdin });
  const threads = new Map();
  const activeTurns = new Map();
  const pendingClientResponses = new Map();
  let nextServerRequestId = 10_000;
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => send({ method, params });
  const respond = (id, result) => send({ id, result });

  const threadState = (threadId) => {
    if (!threads.has(threadId)) {
      threads.set(threadId, {
        id: threadId,
        compacted: false,
        backgroundTerminals: [{
          processId: `mock-bg-${threadId}`,
          itemId: `mock-bg-item-${threadId}`,
          command: 'npm run mock:watch',
          cwd: process.cwd(),
          osPid: process.pid,
          cpuPercent: 1.5,
          rssKb: 12 * 1024,
        }],
      });
    }
    return threads.get(threadId);
  };
  const threadResult = (threadId, params = {}) => ({
    thread: { id: threadId, turns: [], status: { type: 'idle' } },
    model: params.model || 'mock-codex-model',
    modelProvider: 'mock',
    cwd: params.cwd || process.cwd(),
    approvalPolicy: params.approvalPolicy || 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
  });
  const item = (threadId, turnId, phase, value) => notify(`item/${phase}`, {
    threadId,
    turnId,
    item: value,
    ...(phase === 'started' ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }),
  });
  const delta = (threadId, turnId, itemId, text) => notify('item/agentMessage/delta', {
    threadId,
    turnId,
    itemId,
    delta: text,
  });
  const finishTurn = (threadId, turnId, status = 'completed', error = null) => {
    const active = activeTurns.get(threadId);
    if (!active || active.id !== turnId || active.completed) return;
    active.completed = true;
    activeTurns.delete(threadId);
    notify('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
        total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
        modelContextWindow: 200000,
      },
    });
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status, items: [], error },
    });
  };
  const requestClient = (method, params) => new Promise((resolve) => {
    const id = nextServerRequestId++;
    pendingClientResponses.set(id, resolve);
    send({ method, id, params });
  });

  const runTurn = async (threadId, turnId, input, imageCount) => {
    const state = threadState(threadId);
    if (/pwd/i.test(input)) {
      item(threadId, turnId, 'started', {
        id: 'item_cmd', type: 'commandExecution', command: '/bin/bash -lc pwd', commandActions: [],
        cwd: process.cwd(), aggregatedOutput: null, exitCode: null, status: 'inProgress',
      });
      item(threadId, turnId, 'completed', {
        id: 'item_cmd', type: 'commandExecution', command: '/bin/bash -lc pwd', commandActions: [],
        cwd: process.cwd(), aggregatedOutput: '/tmp/mock-codex\n', exitCode: 0, status: 'completed',
      });
    }
    if (input === 'trigger codex auth error') {
      notify('error', {
        threadId,
        turnId,
        error: { message: 'authentication failed: invalid api key' },
        willRetry: false,
      });
      finishTurn(threadId, turnId, 'failed', { message: 'authentication failed: invalid api key' });
      return;
    }
    if (input === 'trigger codex silent exit') {
      item(threadId, turnId, 'completed', { id: 'item_msg_partial', type: 'agentMessage', text: 'Codex mock partial before silent exit.' });
      finishTurn(threadId, turnId, 'failed', { message: 'Codex mock turn failed without additional output' });
      return;
    }
    if (input === 'trigger codex metadata warning') {
      item(threadId, turnId, 'completed', {
        id: 'item_warn', type: 'error',
        message: 'Model metadata for `claude-sonnet-4-6` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      });
    }
    if (input === 'trigger codex interactive approval' || input === 'trigger codex structured approval') {
      const structuredDecision = {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['rm', '-rf', '/tmp/webcoding-mock-unsafe'],
        },
      };
      const approval = await requestClient('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: 'approval-command',
        startedAtMs: Date.now(),
        command: 'rm -rf /tmp/webcoding-mock-unsafe',
        cwd: process.cwd(),
        reason: 'mock approval for regression',
        availableDecisions: input === 'trigger codex structured approval'
          ? ['accept', structuredDecision, 'decline', 'cancel']
          : ['accept', 'acceptForSession', 'decline', 'cancel'],
      });
      const decisionText = typeof approval?.decision === 'string'
        ? approval.decision
        : JSON.stringify(approval?.decision || 'unknown');
      const approvalText = `Codex mock approval decision: ${decisionText}`;
      delta(threadId, turnId, 'item_msg_after_approval', approvalText);
      item(threadId, turnId, 'completed', { id: 'item_msg_after_approval', type: 'agentMessage', text: approvalText });
      finishTurn(threadId, turnId);
      return;
    }
    if (input === 'trigger codex user input') {
      const response = await requestClient('item/tool/requestUserInput', {
        threadId,
        turnId,
        itemId: 'request-user-input',
        questions: [{
          id: 'environment',
          header: '运行环境',
          question: '请选择部署环境',
          options: [
            { label: '生产环境', description: '使用生产配置' },
            { label: '测试环境', description: '使用测试配置' },
          ],
        }],
      });
      const answer = response?.answers?.environment?.answers?.[0] || 'none';
      const answerText = `Codex mock user input: ${answer}`;
      delta(threadId, turnId, 'item_msg_user_input', answerText);
      item(threadId, turnId, 'completed', { id: 'item_msg_user_input', type: 'agentMessage', text: answerText });
      finishTurn(threadId, turnId);
      return;
    }
    if (input === 'trigger codex mcp form') {
      const response = await requestClient('mcpServer/elicitation/request', {
        threadId,
        turnId,
        serverName: 'mock-mcp',
        mode: 'form',
        message: 'Configure mock MCP access',
        requestedSchema: {
          type: 'object',
          properties: {
            scopes: {
              type: 'array',
              title: 'Scopes',
              description: 'Select one or more scopes',
              items: {
                anyOf: [
                  { const: 'read', title: 'Read' },
                  { const: 'write', title: 'Write' },
                ],
              },
              minItems: 1,
              maxItems: 2,
            },
            retries: {
              type: 'integer',
              title: 'Retries',
              minimum: 1,
              maximum: 5,
            },
            note: {
              type: 'string',
              title: 'Optional note',
            },
          },
          required: ['scopes', 'retries'],
        },
      });
      const responseText = `Codex mock MCP form: ${JSON.stringify(response)}`;
      delta(threadId, turnId, 'item_msg_mcp_form', responseText);
      item(threadId, turnId, 'completed', { id: 'item_msg_mcp_form', type: 'agentMessage', text: responseText });
      finishTurn(threadId, turnId);
      return;
    }
    if (input === 'trigger codex mcp unsafe url') {
      const response = await requestClient('mcpServer/elicitation/request', {
        threadId,
        turnId,
        serverName: 'mock-mcp',
        mode: 'url',
        message: 'Open the mock authorization page',
        url: 'javascript:globalThis.__webcoding_xss = true',
        elicitationId: 'mock-unsafe-url',
      });
      const responseText = `Codex mock MCP URL: ${JSON.stringify(response)}`;
      delta(threadId, turnId, 'item_msg_mcp_url', responseText);
      item(threadId, turnId, 'completed', { id: 'item_msg_mcp_url', type: 'agentMessage', text: responseText });
      finishTurn(threadId, turnId);
      return;
    }
    if (input === 'trigger codex goal update') {
      const now = Date.now();
      notify('thread/goal/updated', {
        threadId,
        goal: {
          threadId,
          objective: 'Ship App Server parity',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    if (input === 'trigger codex plan updates') {
      notify('item/plan/delta', {
        threadId,
        turnId,
        itemId: 'mock-plan-item',
        delta: 'Inspect the authentication boundary',
      });
      notify('turn/plan/updated', {
        threadId,
        turnId,
        explanation: 'Keep the review focused on access control.',
        plan: [
          { step: 'Inspect the authentication boundary', status: 'completed' },
          { step: 'Verify authorization tests', status: 'inProgress' },
        ],
      });
    }
    if (input === 'trigger codex client utilities') {
      const currentTime = await requestClient('currentTime/read', { threadId });
      const dynamicTool = await requestClient('item/tool/call', {
        threadId,
        turnId,
        callId: 'mock-dynamic-call',
        tool: 'mock_unregistered_tool',
        namespace: null,
        arguments: { value: 1 },
      });
      const utilityText = `Codex mock client utilities: ${JSON.stringify({ currentTime, dynamicTool })}`;
      delta(threadId, turnId, 'item_msg_client_utilities', utilityText);
      item(threadId, turnId, 'completed', {
        id: 'item_msg_client_utilities',
        type: 'agentMessage',
        text: utilityText,
      });
      finishTurn(threadId, turnId);
      return;
    }
    const slowStreamMatch = input.match(/^trigger codex slow stream(?:\s+(.+))?$/i);
    if (slowStreamMatch) {
      const label = String(slowStreamMatch[1] || 'default').trim() || 'default';
      const itemId = `item_msg_slow_${label}`;
      item(threadId, turnId, 'started', { id: itemId, type: 'agentMessage', text: '' });
      delta(threadId, turnId, itemId, `slow-start:${label} `);
      await sleep(1500);
      if (!activeTurns.has(threadId)) return;
      const steerText = activeTurns.get(threadId)?.steerText || '';
      delta(threadId, turnId, itemId, `${steerText ? `steer:${steerText} ` : ''}slow-mid:${label} `);
      await sleep(1500);
      if (!activeTurns.has(threadId)) return;
      delta(threadId, turnId, itemId, `slow-end:${label}`);
      item(threadId, turnId, 'completed', {
        id: itemId,
        type: 'agentMessage',
        text: `slow-start:${label} ${steerText ? `steer:${steerText} ` : ''}slow-mid:${label} slow-end:${label}`,
      });
      finishTurn(threadId, turnId);
      return;
    }
    if (input === 'trigger codex context limit' && !state.compacted) {
      finishTurn(threadId, turnId, 'failed', { message: 'Context window exceeded. Please use /compact and retry.' });
      return;
    }
    const responseText = input === 'trigger codex goal update'
      ? 'Codex mock after goal update.'
      : `Codex mock handled (${imageCount} image): ${input}`;
    delta(threadId, turnId, 'item_msg', responseText);
    item(threadId, turnId, 'completed', { id: 'item_msg', type: 'agentMessage', text: responseText });
    if (input === 'trigger codex context limit' && state.compacted) state.compacted = false;
    finishTurn(threadId, turnId);
  };

  const startTurn = (threadId, params, review = false) => {
    const turnId = `turn-${crypto.randomUUID()}`;
    activeTurns.set(threadId, { id: turnId, completed: false, steerText: '' });
    respond(params.requestId, { turn: { id: turnId, status: 'inProgress', items: [] }, ...(review ? { reviewThreadId: threadId } : {}) });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    return turnId;
  };

  rl.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const resolve = pendingClientResponses.get(message.id);
      if (resolve) {
        pendingClientResponses.delete(message.id);
        resolve(message.result || null);
      }
      return;
    }
    const { method, params = {}, id } = message;
    if (id === undefined) return;
    if (method === 'initialize') {
      respond(id, { userAgent: 'mock-codex-app-server', platformFamily: 'unix', platformOs: 'mock' });
    } else if (method === 'account/usage/read') {
      respond(id, {
        summary: {
          lifetimeTokens: 123456,
          peakDailyTokens: 23456,
          currentStreakDays: 7,
          longestStreakDays: 12,
          longestRunningTurnSec: 90,
        },
        dailyUsageBuckets: null,
      });
    } else if (method === 'account/rateLimits/read') {
      respond(id, {
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'plus',
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 4102444800 },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: { availableCount: 1, credits: [] },
      });
    } else if (method === 'thread/start') {
      const threadId = `mock-${crypto.randomUUID()}`;
      threadState(threadId);
      respond(id, threadResult(threadId, params));
      notify('thread/started', { thread: { id: threadId, turns: [], status: { type: 'idle' } } });
    } else if (method === 'thread/resume') {
      threadState(params.threadId);
      respond(id, threadResult(params.threadId, params));
    } else if (method === 'thread/fork') {
      threadState(params.threadId);
      const forkedThreadId = `mock-${crypto.randomUUID()}`;
      threadState(forkedThreadId);
      respond(id, threadResult(forkedThreadId, params));
      notify('thread/started', { thread: { id: forkedThreadId, forkedFromId: params.threadId, turns: [], status: { type: 'idle' } } });
    } else if (method === 'thread/name/set') {
      const state = threadState(params.threadId);
      state.name = params.name || null;
      respond(id, {});
      notify('thread/name/updated', { threadId: params.threadId, threadName: state.name });
    } else if (method === 'thread/settings/update') {
      if (params.personality !== undefined && params.personality !== null
          && !['none', 'friendly', 'pragmatic'].includes(params.personality)) {
        send({ id, error: { code: -32602, message: 'Invalid mock Codex personality' } });
      } else {
        const state = threadState(params.threadId);
        if (params.personality !== undefined) state.personality = params.personality;
        if (params.effort !== undefined) state.effort = params.effort;
        respond(id, {});
        notify('thread/settings/updated', {
          threadId: params.threadId,
          settings: { personality: state.personality, effort: state.effort },
        });
      }
    } else if (method === 'collaborationMode/list') {
      respond(id, {
        data: [
          { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
          { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'high' },
        ],
      });
    } else if (method === 'skills/list') {
      respond(id, {
        data: [{
          cwd: params.cwds?.[0] || process.cwd(),
          errors: [],
          skills: [{
            name: 'mock-skill',
            description: 'Mock native Codex skill',
            enabled: true,
            path: path.join(process.cwd(), '.codex', 'skills', 'mock-skill', 'SKILL.md'),
            scope: 'repo',
          }],
        }],
      });
    } else if (method === 'mcpServerStatus/list') {
      respond(id, {
        data: [{
          name: 'mock-mcp',
          authStatus: 'oAuth',
          resourceTemplates: [],
          resources: [],
          tools: {
            mock_tool: { name: 'mock_tool', description: 'Mock MCP tool', inputSchema: { type: 'object' } },
          },
        }],
        nextCursor: null,
      });
    } else if (method === 'thread/goal/get') {
      respond(id, { goal: threadState(params.threadId).goal || null });
    } else if (method === 'thread/goal/set') {
      const state = threadState(params.threadId);
      const now = Date.now();
      state.goal = {
        threadId: params.threadId,
        objective: params.objective || state.goal?.objective || '',
        status: params.status || state.goal?.status || 'active',
        tokenBudget: params.tokenBudget ?? state.goal?.tokenBudget ?? null,
        tokensUsed: state.goal?.tokensUsed || 0,
        timeUsedSeconds: state.goal?.timeUsedSeconds || 0,
        createdAt: state.goal?.createdAt || now,
        updatedAt: now,
      };
      respond(id, { goal: state.goal });
      notify('thread/goal/updated', { threadId: params.threadId, goal: state.goal });
    } else if (method === 'thread/goal/clear') {
      const state = threadState(params.threadId);
      const cleared = !!state.goal;
      state.goal = null;
      respond(id, { cleared });
      notify('thread/goal/cleared', { threadId: params.threadId });
    } else if (method === 'thread/backgroundTerminals/list') {
      respond(id, { data: threadState(params.threadId).backgroundTerminals, nextCursor: null });
    } else if (method === 'thread/backgroundTerminals/terminate') {
      const state = threadState(params.threadId);
      state.backgroundTerminals = state.backgroundTerminals.filter((terminal) => terminal.processId !== params.processId);
      respond(id, {});
    } else if (method === 'turn/start') {
      const text = (params.input || []).filter((part) => part.type === 'text').map((part) => part.text || '').join(' ').trim();
      const imageCount = (params.input || []).filter((part) => part.type === 'localImage' || part.type === 'image').length;
      const turnId = `turn-${crypto.randomUUID()}`;
      activeTurns.set(params.threadId, { id: turnId, completed: false, steerText: '' });
      respond(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      runTurn(params.threadId, turnId, text, imageCount).catch((error) => {
        finishTurn(params.threadId, turnId, 'failed', { message: error.message });
      });
    } else if (method === 'turn/steer') {
      const active = activeTurns.get(params.threadId);
      const text = (params.input || []).filter((part) => part.type === 'text').map((part) => part.text || '').join(' ').trim();
      if (active && active.id === params.expectedTurnId) active.steerText = text;
      respond(id, { turnId: params.expectedTurnId });
    } else if (method === 'turn/interrupt') {
      const active = activeTurns.get(params.threadId);
      respond(id, {});
      if (active && active.id === params.turnId) finishTurn(params.threadId, params.turnId, 'interrupted');
    } else if (method === 'review/start') {
      const turnId = `turn-${crypto.randomUUID()}`;
      activeTurns.set(params.threadId, { id: turnId, completed: false, steerText: '' });
      respond(id, { reviewThreadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      const text = params.target?.type === 'custom'
        ? `Codex mock review: ${params.target.instructions}`
        : 'Codex mock review: uncommitted changes';
      delta(params.threadId, turnId, 'review_message', text);
      item(params.threadId, turnId, 'completed', { id: 'review_message', type: 'agentMessage', text });
      finishTurn(params.threadId, turnId);
    } else if (method === 'thread/compact/start') {
      const state = threadState(params.threadId);
      state.compacted = true;
      const turnId = `turn-${crypto.randomUUID()}`;
      activeTurns.set(params.threadId, { id: turnId, completed: false, steerText: '' });
      respond(id, {});
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('thread/compacted', { threadId: params.threadId, turnId });
      finishTurn(params.threadId, turnId);
    } else if (method === 'model/list') {
      respond(id, { data: [{
        id: 'mock-codex-model',
        model: 'mock-codex-model',
        displayName: 'Mock Codex Model',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast mock reasoning' },
          { reasoningEffort: 'medium', description: 'Balanced mock reasoning' },
          { reasoningEffort: 'high', description: 'Deep mock reasoning' },
          { reasoningEffort: 'xhigh', description: 'Extra deep mock reasoning' },
        ],
      }] });
    } else {
      send({ id, error: { code: -32601, message: `Mock unsupported method: ${method}` } });
    }
  });
}

(async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'app-server') {
    runAppServer();
    return;
  }
  const isResume = args[0] === 'exec' && args[1] === 'resume';
  const threadId = (() => {
    if (!isResume) return `mock-${crypto.randomUUID()}`;
    for (let i = args.length - 1; i >= 2; i--) {
      const arg = args[i];
      if (arg === '-' || String(arg).startsWith('-')) continue;
      return arg;
    }
    return `mock-${crypto.randomUUID()}`;
  })();
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => arg === '--image').length;
  const statePath = path.join(os.tmpdir(), `webcoding-mock-codex-${threadId}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {}

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

  if (/pwd/i.test(input)) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '/tmp/mock-codex\n',
        exit_code: 0,
        status: 'completed',
      },
    })}\n`);
  }

  if (input === '/compact') {
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }

  if (input === 'trigger codex context limit' && !state.compacted) {
    process.stdout.write(`${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Context window exceeded. Please use /compact and retry.' },
    })}\n`);
    process.exit(1);
  }

  if (input === 'trigger codex auth error') {
    process.stderr.write('authentication failed: invalid api key\n');
    process.exit(1);
  }

  if (input === 'trigger codex silent exit') {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_msg_partial',
        type: 'agent_message',
        text: 'Codex mock partial before silent exit.',
      },
    })}\n`);
    process.exit(1);
  }

  if (input === 'trigger codex metadata warning') {
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_warn',
        type: 'error',
        message: 'Model metadata for `claude-sonnet-4-6` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      },
    })}\n`);
  }

  // Headless interactive protocol fixtures (cannot be answered via file I/O).
  if (input === 'trigger codex interactive approval') {
    process.stdout.write(`${JSON.stringify({
      type: 'exec_approval_request',
      command: 'rm -rf /tmp/webcoding-mock-unsafe',
      reason: 'mock approval for regression',
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_msg_after_approval',
        type: 'agent_message',
        text: 'Codex mock continued after interactive approval event.',
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 3 },
    })}\n`);
    return;
  }

  if (input === 'trigger codex goal update') {
    process.stdout.write(`${JSON.stringify({
      type: 'thread_goal_updated',
      goal: { title: 'Ship headless parity', status: 'active' },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_msg_goal',
        type: 'agent_message',
        text: 'Codex mock after goal update.',
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 },
    })}\n`);
    return;
  }

  const slowStreamMatch = input.match(/^trigger codex slow stream(?:\s+(.+))?$/i);
  if (slowStreamMatch) {
    const label = String(slowStreamMatch[1] || 'default').trim() || 'default';
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_msg_start_${label}`,
        type: 'agent_message',
        text: `slow-start:${label} `,
      },
    })}\n`);
    await sleep(1500);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_msg_mid_${label}`,
        type: 'agent_message',
        text: `slow-mid:${label} `,
      },
    })}\n`);
    await sleep(1500);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: `item_msg_end_${label}`,
        type: 'agent_message',
        text: `slow-end:${label}`,
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
    })}\n`);
    return;
  }

  const responseText = input === '/compact'
    ? 'Codex compact finished.'
    : `Codex mock handled (${imageCount} image): ${input}`;

  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_msg',
      type: 'agent_message',
      text: responseText,
    },
  })}\n`);

  if (input === 'trigger codex context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }

  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
  })}\n`);
})();
