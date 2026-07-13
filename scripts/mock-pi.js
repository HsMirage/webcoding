#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !String(args[idx + 1]).startsWith('-')) {
    return args[idx + 1];
  }
  return null;
}

function mockModel(model) {
  return {
    id: model,
    name: model === 'mock-pi-model' ? 'Mock Pi Model' : model,
    api: 'mock',
    provider: 'mock',
    baseUrl: 'http://127.0.0.1/mock',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

async function runRpcMode(args) {
  const sessionDir = getArgValue(args, '--session-dir');
  const sessionId = getArgValue(args, '--session-id') || crypto.randomUUID();
  const model = getArgValue(args, '--model') || 'mock-pi-model';
  const toolsIdx = args.indexOf('--tools');
  const tools = toolsIdx >= 0 ? String(args[toolsIdx + 1] || '') : '';
  const statePath = sessionDir ? path.join(sessionDir, `${sessionId}.mock-state.json`) : null;
  let state = { turns: 0, lastInput: '' };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  let isStreaming = false;
  let pendingUi = null;
  let activeInput = '';

  function persistState() {
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));
    } catch {}
  }

  function response(command, success = true, data, error, id) {
    emit({ id, type: 'response', command, success, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
  }

  function usageFor(text) {
    return {
      input: 120,
      output: Math.max(8, text.length),
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120 + Math.max(8, text.length),
      cost: { input: 0.0001, output: 0.0002, total: 0.0003 },
    };
  }

  function finishTurn(text, stopReason = 'stop', errorMessage = null) {
    const usage = usageFor(text);
    emit({
      type: 'message_start',
      message: {
        role: 'assistant', content: [], api: 'mock', provider: 'mock', model,
        usage: usageFor(''), stopReason, timestamp: Date.now(),
      },
    });
    const chunks = text.match(/.{1,24}/g) || (text ? [text] : []);
    let built = '';
    for (const chunk of chunks) {
      built += chunk;
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk },
        message: {
          role: 'assistant', content: [{ type: 'text', text: built }], api: 'mock', provider: 'mock', model,
          usage, stopReason, timestamp: Date.now(),
        },
      });
    }
    emit({
      type: 'message_end',
      message: {
        role: 'assistant', content: text ? [{ type: 'text', text }] : [], api: 'mock', provider: 'mock', model,
        usage, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
      },
    });
    emit({
      type: 'turn_end',
      message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [], usage, stopReason, timestamp: Date.now() },
      toolResults: [],
    });
    emit({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: activeInput }] },
        { role: 'assistant', content: text ? [{ type: 'text', text }] : [], usage, stopReason },
      ],
      willRetry: false,
    });
    isStreaming = false;
    activeInput = '';
    pendingUi = null;
  }

  function startPrompt(command) {
    const input = String(command.message || '');
    activeInput = input;
    if (input === 'trigger pi auth error') {
      response('prompt', false, undefined, 'authentication failed: missing api key', command.id);
      return;
    }
    response('prompt', true, undefined, null, command.id);
    isStreaming = true;
    state.turns = (state.turns || 0) + 1;
    state.lastInput = input;
    persistState();
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });

    if (input === 'trigger pi silent exit') {
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Pi mock partial before silent exit.' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'Pi mock partial before silent exit.' }], model, timestamp: Date.now() },
      });
      setTimeout(() => process.exit(1), 20);
      return;
    }
    if (input === 'trigger pi json error') {
      finishTurn('', 'error', 'Pi mock structured failure (stopReason=error)');
      return;
    }
    if (input === 'trigger pi rpc select') {
      pendingUi = { id: 'mock-pi-select', method: 'select' };
      emit({
        type: 'extension_ui_request',
        id: pendingUi.id,
        method: 'select',
        title: '选择部署环境',
        options: ['测试环境', '生产环境'],
      });
      return;
    }
    if (input === 'trigger pi rpc confirm') {
      pendingUi = { id: 'mock-pi-confirm', method: 'confirm' };
      emit({
        type: 'extension_ui_request',
        id: pendingUi.id,
        method: 'confirm',
        title: '确认发布',
        message: '是否继续发布？',
      });
      return;
    }
    if (input === 'trigger pi rpc input') {
      pendingUi = { id: 'mock-pi-input', method: 'input' };
      emit({
        type: 'extension_ui_request',
        id: pendingUi.id,
        method: 'input',
        title: '输入分支名',
        placeholder: 'feature/example',
      });
      return;
    }
    if (input === 'trigger pi rpc slow') {
      emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Pi RPC is still running...' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'Pi RPC is still running...' }], model, timestamp: Date.now() },
      });
      return;
    }

    const imageCount = Array.isArray(command.images) ? command.images.length : 0;
    let text = imageCount > 0
      ? `Pi mock handled ${imageCount} image attachment(s): ${input || '[no text]'}`
      : tools
        ? `Pi mock handled (tools=${tools}): ${input}`
        : `Pi mock handled (turn ${state.turns}, model=${model}): ${input}`;
    if (/run bash/i.test(input)) {
      const toolId = 'call_mock_bash_1';
      emit({ type: 'tool_execution_start', toolCallId: toolId, toolName: 'bash', args: { command: 'echo mock-pi' } });
      emit({
        type: 'tool_execution_end', toolCallId: toolId, toolName: 'bash',
        result: { content: [{ type: 'text', text: 'mock-pi\n' }] }, isError: false,
      });
    }
    finishTurn(text);
  }

  function handleCommand(command) {
    switch (command.type) {
      case 'get_state': {
        const sendState = () => response('get_state', true, {
          model: mockModel(model),
          thinkingLevel: getArgValue(args, '--thinking') || 'medium',
          isStreaming,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionFile: statePath,
          sessionId,
          autoCompactionEnabled: true,
          messageCount: state.turns * 2,
          pendingMessageCount: 0,
        }, null, command.id);
        const delayMs = Number.parseInt(process.env.MOCK_PI_RPC_GET_STATE_DELAY_MS || '', 10);
        if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(sendState, delayMs);
        else sendState();
        break;
      }
      case 'get_available_models':
        response('get_available_models', true, {
          models: [mockModel('mock-pi-model'), mockModel('mock-pi-fast')],
        }, null, command.id);
        break;
      case 'get_commands':
        response('get_commands', true, {
          commands: [{
            name: 'rpc-demo', description: 'Mock Pi RPC extension command', source: 'extension',
            sourceInfo: { path: '/mock/rpc-demo.js', location: 'user' },
          }],
        }, null, command.id);
        break;
      case 'prompt':
        startPrompt(command);
        break;
      case 'compact':
        emit({ type: 'compaction_start', reason: 'manual' });
        emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'mock compact', tokensBefore: 1000, estimatedTokensAfter: 100 }, aborted: false, willRetry: false });
        response('compact', true, { summary: 'mock compact', tokensBefore: 1000, estimatedTokensAfter: 100 }, null, command.id);
        break;
      case 'abort':
        response('abort', true, undefined, null, command.id);
        if (isStreaming) finishTurn('', 'aborted');
        break;
      case 'extension_ui_response': {
        if (!pendingUi || pendingUi.id !== command.id) return;
        let answer = 'cancelled';
        if (pendingUi.method === 'confirm') answer = command.confirmed ? 'confirmed' : 'rejected';
        else if (command.cancelled !== true) answer = String(command.value || '');
        finishTurn(`Pi RPC interaction result: ${answer}`);
        break;
      }
      default:
        response(command.type || 'unknown', false, undefined, `Unknown command: ${command.type}`, command.id);
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (let line of lines) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      try { handleCommand(JSON.parse(line)); } catch (error) {
        response('parse', false, undefined, error.message);
      }
    }
  });
  await new Promise((resolve) => process.stdin.on('end', resolve));
}

(async function main() {
  const args = process.argv.slice(2);
  if (getArgValue(args, '--mode') === 'rpc') {
    await runRpcMode(args);
    return;
  }
  const sessionDir = getArgValue(args, '--session-dir');
  const sessionId = getArgValue(args, '--session-id') || crypto.randomUUID();
  const model = getArgValue(args, '--model') || 'mock-pi-model';
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => String(arg).startsWith('@')).length;
  const toolsIdx = args.indexOf('--tools');
  const tools = toolsIdx >= 0 ? String(args[toolsIdx + 1] || '') : '';

  // Persist a tiny resume state so multi-turn can be verified.
  let state = { turns: 0, lastInput: '' };
  const statePath = sessionDir
    ? path.join(sessionDir, `${sessionId}.mock-state.json`)
    : null;
  if (statePath) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {}
  }
  state.turns = (state.turns || 0) + 1;
  state.lastInput = input;
  if (statePath) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));
    } catch {}
  }

  emit({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_start',
    message: {
      role: 'user',
      content: [{ type: 'text', text: input }],
      timestamp: Date.now(),
    },
  });
  emit({
    type: 'message_end',
    message: {
      role: 'user',
      content: [{ type: 'text', text: input }],
      timestamp: Date.now(),
    },
  });

  if (input === 'trigger pi silent exit') {
    emit({
      type: 'message_start',
      message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: Date.now() },
    });
    const partial = 'Pi mock partial before silent exit.';
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: partial },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: partial }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    });
    process.exit(1);
  }

  if (input === 'trigger pi auth error') {
    process.stderr.write('authentication failed: missing api key\n');
    process.exit(1);
  }

  if (input === 'trigger pi json error') {
    emit({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() });
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        model,
        stopReason: 'error',
        errorMessage: 'Pi mock structured failure (stopReason=error)',
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
        timestamp: Date.now(),
      },
    });
    emit({ type: 'agent_end', messages: [], willRetry: false });
    process.exit(0);
  }

  let text = '';
  if (input === '/compact') {
    text = 'Pi mock compact finished.';
  } else if (imageCount > 0) {
    text = `Pi mock handled ${imageCount} image attachment(s): ${input || '[no text]'}`;
  } else if (tools) {
    text = `Pi mock handled (tools=${tools}): ${input}`;
  } else {
    text = `Pi mock handled (turn ${state.turns}, model=${model}): ${input}`;
  }

  // Optional tool call path for tool event coverage
  if (/run bash/i.test(input)) {
    const toolId = 'call_mock_bash_1';
    emit({
      type: 'tool_execution_start',
      toolCallId: toolId,
      toolName: 'bash',
      args: { command: 'echo mock-pi' },
    });
    emit({
      type: 'tool_execution_end',
      toolCallId: toolId,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'mock-pi\n' }] },
      isError: false,
    });
  }

  emit({
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [],
      api: 'mock',
      provider: 'mock',
      model,
      usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  });

  // Stream text as deltas
  const chunks = text.match(/.{1,24}/g) || [text];
  let built = '';
  for (const chunk of chunks) {
    built += chunk;
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: built }],
        api: 'mock',
        provider: 'mock',
        model,
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    });
  }

  const usage = {
    input: 120,
    output: Math.max(8, text.length),
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120 + Math.max(8, text.length),
    cost: { input: 0.0001, output: 0.0002, total: 0.0003 },
  };

  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'mock',
      provider: 'mock',
      model,
      usage,
      stopReason: 'stop',
      timestamp: Date.now(),
    },
  });
  emit({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage,
      stopReason: 'stop',
      timestamp: Date.now(),
    },
    toolResults: [],
  });
  emit({
    type: 'agent_end',
    messages: [
      { role: 'user', content: [{ type: 'text', text: input }] },
      { role: 'assistant', content: [{ type: 'text', text }], usage },
    ],
    willRetry: false,
  });
})();
