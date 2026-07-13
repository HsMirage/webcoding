#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

(async function main() {
  const args = process.argv.slice(2);
  const resumeIndex = args.indexOf('--resume');
  const inputFormatIndex = args.indexOf('--input-format');
  const sessionId = resumeIndex >= 0 && args[resumeIndex + 1]
    ? args[resumeIndex + 1]
    : crypto.randomUUID();

  if (process.env.MOCK_CLAUDE_ENV_CAPTURE) {
    fs.appendFileSync(process.env.MOCK_CLAUDE_ENV_CAPTURE, `${JSON.stringify({
      args,
      hasWebPassword: Boolean(process.env.CC_WEB_PASSWORD),
      hasClaudeNestingMarker: Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE),
    })}\n`);
  }

  process.stdout.write(`${JSON.stringify({
    type: 'system',
    session_id: sessionId,
    slash_commands: ['compact', 'model', 'review'],
  })}\n`);

  const usesStreamJson = inputFormatIndex >= 0 && args[inputFormatIndex + 1] === 'stream-json';
  const pendingControlResponses = new Map();
  let controlRequestCounter = 0;
  const requestControlResponse = (request) => {
    controlRequestCounter += 1;
    const requestId = `mock-control-${controlRequestCounter}`;
    process.stdout.write(`${JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request,
    })}\n`);
    return new Promise((resolve) => pendingControlResponses.set(requestId, resolve));
  };
  const handleTurn = async (input, payload = null) => {
    let text = '';
    if (usesStreamJson) {
      const blocks = payload?.message?.content || [];
      const imageCount = blocks.filter((block) => block.type === 'image').length;
      const promptText = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join(' ').trim();
      text = `Claude mock handled stream-json (${imageCount} image): ${promptText || '[no text]'}`;
    } else if (input === '/compact') {
      text = 'Claude compact finished.';
    } else {
      text = `Claude mock handled: ${input}`;
    }

    const promptText = usesStreamJson
      ? (payload?.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join(' ').trim()
      : input;
    if (promptText === '/compact') text = 'Claude compact finished.';

    if (promptText === 'trigger claude interactive permission') {
      const response = await requestControlResponse({
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'printf mock-permission' },
        tool_use_id: 'toolu_mock_permission',
        permission_suggestions: [{
          type: 'addRules',
          destination: 'session',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'printf mock-permission' }],
        }],
      });
      text = `Claude mock permission response: ${JSON.stringify(response)}`;
    }

    if (promptText === 'trigger claude ask user') {
      const response = await requestControlResponse({
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_mock_ask_user',
        input: {
          questions: [
            {
              question: 'Which environment should Claude target?',
              header: 'Environment',
              options: [
                { label: 'Production', description: 'Deploy to production.' },
                { label: 'Staging', description: 'Deploy to staging.' },
              ],
              multiSelect: false,
            },
            {
              question: 'Which checks should run?',
              header: 'Checks',
              options: [
                { label: 'Tests', description: 'Run the test suite.' },
                { label: 'Lint', description: 'Run static checks.' },
              ],
              multiSelect: true,
            },
          ],
        },
      });
      text = `Claude mock AskUser response: ${JSON.stringify(response)}`;
    }

    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text }] },
    })}\n`);

    if (promptText === 'trigger claude silent exit') {
      process.exit(1);
    }

    const result = {
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
    };
    if (promptText === 'trigger claude permission denials') {
      result.permission_denials = [
        { tool_name: 'Bash', reason: 'mock denial for regression' },
      ];
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  };

  if (usesStreamJson) {
    const rl = readline.createInterface({ input: process.stdin });
    let queue = Promise.resolve();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let payload;
      try { payload = JSON.parse(line); } catch { return; }
      if (payload?.type === 'control_response') {
        const controlResponse = payload.response || {};
        const resolve = pendingControlResponses.get(String(controlResponse.request_id || ''));
        if (resolve) {
          pendingControlResponses.delete(String(controlResponse.request_id));
          resolve(controlResponse.response);
        }
        return;
      }
      queue = queue.then(() => handleTurn(line, payload));
    });
    return;
  }

  const input = (await readStdin()).trim();
  await handleTurn(input, null);
})();
