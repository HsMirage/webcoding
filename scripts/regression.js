#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const REPO_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_DIR, 'server.js');
const BRIDGE_PATH = path.join(REPO_DIR, 'lib', 'local-api-bridge.js');
const MOCK_CLAUDE = path.join(REPO_DIR, 'scripts', 'mock-claude.js');
const MOCK_CODEX = path.join(REPO_DIR, 'scripts', 'mock-codex.js');
const WS_AUTH_TIMEOUT_MS = 3000;
const WS_CONNECT_TIMEOUT_MS = 10000;
const THREAD_RESET_WARNING_RE = /重新建立新线程|无法原生续接旧线程|已新开线程并补充历史摘要/;
const THREAD_CARRYOVER_NOTICE_RE = /已向新线程补充|已新开线程；|已新开线程，并补充/;
const THREAD_REBUILD_NOTICE_RE = /重新建立新线程|已向新线程补充|无法原生续接旧线程|已新开线程(?:并补充历史摘要|；|，并补充)/;

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, { timeoutMs = 4000, intervalMs = 60, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runSqliteScript(dbPath, script) {
  const result = spawnSync('sqlite3', [dbPath, script], { encoding: 'utf8' });
  if (result.status !== 0) {
    const preview = String(script || '').trim().slice(0, 160);
    throw new Error(result.stderr || `sqlite3 failed: ${preview}`);
  }
  return result.stdout.trim();
}

function runSqliteStatements(dbPath, statements) {
  return runSqliteScript(
    dbPath,
    (Array.isArray(statements) ? statements : [statements])
      .filter(Boolean)
      .join('\n'),
  );
}

function sql(dbPath, statement) {
  return runSqliteScript(dbPath, statement);
}

function sqlQuote(value) {
  return `'${String(value).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

const SQL_CREATE_LOGS_TABLE = `
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    message TEXT,
    module_path TEXT,
    file TEXT,
    line INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
  );
`;

function buildInsertThreadSql(threadId, rolloutPath) {
  return `
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version)
    VALUES (${sqlQuote(threadId)}, ${sqlQuote(rolloutPath)}, 1, 2, 'exec', 'OpenAI', '/tmp/project-b', 'Codex import prompt', '{}', 'never', '0.114.0');
  `;
}

function buildInsertLogSql(threadId) {
  return `INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', ${sqlQuote(threadId)});`;
}

function probePort(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function waitChildExit(child, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function ensureMessageWaiters(ws) {
  if (!ws.__ccMessageWaiters) ws.__ccMessageWaiters = new Set();
  return ws.__ccMessageWaiters;
}

function ensureConsumedMessageIndexes(ws) {
  if (!ws.__ccConsumedMessageIndexes) ws.__ccConsumedMessageIndexes = new Set();
  return ws.__ccConsumedMessageIndexes;
}

function notifyMessageWaiters(ws, msg, msgIndex) {
  const waiters = ensureMessageWaiters(ws);
  for (const waiter of Array.from(waiters)) {
    let matched = false;
    try {
      matched = !!waiter.predicate(msg);
    } catch (error) {
      waiters.delete(waiter);
      waiter.reject(error);
      continue;
    }
    if (!matched) continue;
    waiters.delete(waiter);
    waiter.resolve(msg, msgIndex);
  }
}

function rejectMessageWaiters(ws, error) {
  const waiters = ensureMessageWaiters(ws);
  for (const waiter of Array.from(waiters)) {
    waiters.delete(waiter);
    waiter.reject(error);
  }
}

async function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probePort(port)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function startServer(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitForPort(env.PORT, 10000);
  return { child, stdout: () => stdout, stderr: () => stderr, env };
}

async function stopServer(handle) {
  const child = handle?.child || handle;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch {}
    await waitChildExit(child, 1200);
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await waitChildExit(child, 800);
  }
}

async function withServer(env, fn) {
  const handle = await startServer(env);

  try {
    await fn(handle);
  } catch (err) {
    const stdoutTail = handle.stdout().slice(-1200);
    const stderrTail = handle.stderr().slice(-1200);
    if (stdoutTail || stderrTail) {
      err.message = `${err.message}\n--- server stdout tail ---\n${stdoutTail}\n--- server stderr tail ---\n${stderrTail}`;
    }
    throw err;
  } finally {
    await stopServer(handle);
  }
}

function requestHttpJson({ port, path: reqPath, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers,
      timeout: 10000,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          text,
          json,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function startBridgeProcess(tempDir, upstreamPort, options = {}) {
  const runtimePath = path.join(tempDir, 'bridge-runtime.json');
  const statePath = path.join(tempDir, 'bridge-state.json');
  const upstreamApiBase = options.upstreamApiBase || `http://127.0.0.1:${upstreamPort}`;
  const defaultModel = options.defaultModel === undefined ? 'fallback-model' : options.defaultModel;
  const modelReasoningEffort = String(options.modelReasoningEffort || '').trim();
  fs.writeFileSync(runtimePath, JSON.stringify({
    token: 'bridge-regression-token',
    upstream: {
      name: 'Fallback OpenAI',
      apiKey: 'upstream-test-key',
      apiBase: upstreamApiBase,
      kind: 'openai',
      defaultModel,
      modelReasoningEffort,
    },
  }, null, 2));

  const child = spawn(process.execPath, [BRIDGE_PATH], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      CC_WEB_BRIDGE_RUNTIME_PATH: runtimePath,
      CC_WEB_BRIDGE_STATE_PATH: statePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitForCondition(() => {
    try {
      if (!fs.existsSync(statePath)) return false;
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return parsed && typeof parsed.port === 'number' && parsed.port > 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 5000, label: 'bridge state file' });
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  await waitForPort(state.port, 5000);
  return { child, state, runtimePath, statePath, stderr: () => stderr };
}

async function startLegacyBridgeProcess(runtimePath, statePath) {
  const script = `
    const fs = require('fs');
    const http = require('http');
    const path = require('path');
    const runtimePath = process.env.CC_WEB_BRIDGE_RUNTIME_PATH;
    const statePath = process.env.CC_WEB_BRIDGE_STATE_PATH;

    function writeState(port) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        pid: process.pid,
        port,
        startedAt: new Date().toISOString(),
      }, null, 2));
    }

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/anthropic/v1/messages')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: JSON.stringify({
              error: {
                message: 'not implemented',
                type: 'new_api_error',
                code: 'convert_request_failed',
              },
            }),
          },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    });

    server.listen(0, '127.0.0.1', () => {
      writeState(server.address().port);
    });

    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    process.on('SIGINT', () => server.close(() => process.exit(0)));
  `;

  const child = spawn(process.execPath, ['-e', script], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      CC_WEB_BRIDGE_RUNTIME_PATH: runtimePath,
      CC_WEB_BRIDGE_STATE_PATH: statePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitForCondition(() => {
    try {
      if (!fs.existsSync(statePath)) return false;
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return parsed && typeof parsed.port === 'number' && parsed.port > 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 5000, label: 'legacy bridge state file' });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  await waitForPort(state.port, 5000);
  return { child, state, runtimePath, statePath, stderr: () => stderr };
}

async function stopBridgeProcess(handle) {
  if (!handle?.child) return;
  await stopServer(handle.child);
}

async function startResponsesFallbackUpstream(port, options = {}) {
  const counters = {
    responses: 0,
    chatCompletions: 0,
    models: 0,
  };
  const requests = [];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({
        method: req.method,
        path: requestUrl.pathname,
        search: requestUrl.search,
        bodyText: body,
        bodyJson: (() => {
          try { return body ? JSON.parse(body) : null; } catch { return null; }
        })(),
      });
      if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
        counters.models += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            {
              id: 'regression-api-model',
              display_name: 'regression-api-model',
              description: 'Regression-only upstream model.',
              visibility: 'list',
              supported_in_api: true,
              priority: 0,
            },
            {
              id: 'fallback-model',
              display_name: 'fallback-model',
              description: 'Fallback bridge model.',
              visibility: 'list',
              supported_in_api: true,
              priority: 1,
            },
          ],
        }));
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/v1/responses') {
        counters.responses += 1;
        const responsesStatus = Number(options.responsesStatus || 500);
        const responsesError = options.responsesError || {
          error: {
            message: 'not implemented',
            type: 'new_api_error',
            code: 'convert_request_failed',
          },
        };
        res.writeHead(responsesStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responsesError));
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/v1/chat/completions') {
        counters.chatCompletions += 1;
        const parsed = body ? JSON.parse(body) : {};
        const model = parsed.model || 'fallback-model';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl_regression',
          object: 'chat.completion',
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'pong',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
          },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    counters,
    requests,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function startStreamingResponsesUpstream(port) {
  const counters = {
    responses: 0,
  };
  const requests = [];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const bodyJson = (() => {
        try { return body ? JSON.parse(body) : null; } catch { return null; }
      })();
      requests.push({
        method: req.method,
        path: requestUrl.pathname,
        bodyText: body,
        bodyJson,
      });

      if (req.method === 'POST' && requestUrl.pathname === '/v1/responses') {
        counters.responses += 1;
        if (bodyJson?.stream !== true) {
          res.writeHead(504, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'expected streaming upstream request',
              type: 'gateway_timeout',
              code: 504,
            },
          }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('event: response.created\n');
        res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_stream', model: bodyJson.model || 'fallback-model', output: [] } })}\n\n`);
        res.write('event: response.output_text.delta\n');
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'stream pong' })}\n\n`);
        res.write('event: response.completed\n');
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_stream', model: bodyJson.model || 'fallback-model', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
        res.end();
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    counters,
    requests,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function connectWsOnce(port, password, timeoutMs = WS_AUTH_TIMEOUT_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    const messages = [];
    ensureMessageWaiters(ws);
    ensureConsumedMessageIndexes(ws);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error('Timed out waiting for WebSocket auth_result'));
    }, timeoutMs);
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', password }));
    });
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch (err) {
        done(() => reject(err));
        return;
      }
      messages.push(msg);
      notifyMessageWaiters(ws, msg, messages.length - 1);
      if (msg.type === 'auth_result' && msg.success) done(() => resolve({ ws, messages, token: msg.token }));
      if (msg.type === 'auth_result' && !msg.success) done(() => reject(new Error('Auth failed')));
    });
    ws.on('error', (err) => {
      rejectMessageWaiters(ws, err);
      done(() => reject(err));
    });
    ws.on('close', () => {
      rejectMessageWaiters(ws, new Error('WebSocket closed'));
      if (!settled) done(() => reject(new Error('WebSocket closed before auth_result')));
    });
  });
}

async function connectWs(port, password, timeoutMs = WS_CONNECT_TIMEOUT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const remaining = Math.max(300, deadline - Date.now());
    try {
      return await connectWsOnce(port, password, Math.min(3000, remaining), options);
    } catch (err) {
      lastError = err;
      if (/Auth failed/i.test(String(err && err.message))) throw err;
      await sleep(120);
    }
  }
  throw lastError || new Error('Timed out waiting for WebSocket auth_result');
}

function openWsOnce(port, timeoutMs = WS_AUTH_TIMEOUT_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    const messages = [];
    ensureMessageWaiters(ws);
    ensureConsumedMessageIndexes(ws);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error('Timed out waiting for WebSocket open'));
    }, timeoutMs);
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.on('open', () => done(() => resolve({ ws, messages })));
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(String(buf));
      } catch (err) {
        done(() => reject(err));
        return;
      }
      messages.push(msg);
      notifyMessageWaiters(ws, msg, messages.length - 1);
    });
    ws.on('error', (err) => {
      rejectMessageWaiters(ws, err);
      done(() => reject(err));
    });
    ws.on('close', () => {
      rejectMessageWaiters(ws, new Error('WebSocket closed'));
      if (!settled) done(() => reject(new Error('WebSocket closed before open')));
    });
  });
}

async function openWs(port, timeoutMs = WS_CONNECT_TIMEOUT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const remaining = Math.max(300, deadline - Date.now());
    try {
      return await openWsOnce(port, Math.min(3000, remaining), options);
    } catch (err) {
      lastError = err;
      await sleep(120);
    }
  }
  throw lastError || new Error('Timed out waiting for WebSocket open');
}

function closeWs(ws, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      finish();
    });
    try {
      if (ws.readyState === WebSocket.CLOSING) return;
      ws.close();
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

async function uploadAttachment(port, token, { filename, mime, data }) {
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mime,
      'X-Filename': encodeURIComponent(filename),
    },
    body: data,
  });
  const payload = await response.json();
  assert(response.ok && payload.ok, `Attachment upload failed: ${payload.message || response.status}`);
  return payload.attachment;
}

async function uploadAttachmentExpectFailure(port, token, { filename, mime, data }, expectedStatus) {
  const headers = {
    'Content-Type': mime,
    'X-Filename': encodeURIComponent(filename),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers,
    body: data,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(`Attachment failure response was not JSON: ${err.message}`);
  }
  assert(response.status === expectedStatus, `Expected attachment upload to fail with ${expectedStatus}, got ${response.status}`);
  assert(payload && payload.ok === false, 'Attachment failure response should return ok=false');
  return { response, payload };
}

function nextMessage(messages, ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const stackLines = (new Error().stack || '').split('\n').map((line) => line.trim());
    const caller = stackLines[2] || 'unknown-caller';
    const consumedIndexes = ensureConsumedMessageIndexes(ws);
    for (let i = 0; i < messages.length; i++) {
      if (consumedIndexes.has(i)) continue;
      if (!predicate(messages[i])) continue;
      consumedIndexes.add(i);
      resolve(messages[i]);
      return;
    }
    const waiters = ensureMessageWaiters(ws);
    let timeout = null;
    const waiter = {
      predicate,
      resolve: (msg, msgIndex) => {
        if (timeout) clearTimeout(timeout);
        if (Number.isInteger(msgIndex)) consumedIndexes.add(msgIndex);
        resolve(msg);
      },
      reject: (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      },
    };
    waiters.add(waiter);
    timeout = setTimeout(() => {
      waiters.delete(waiter);
      const tailTypes = messages.slice(-12).map((msg) => msg && msg.type).filter(Boolean).join(', ');
      reject(new Error(`Timed out waiting for expected WebSocket message (${caller}) tail=[${tailTypes}]`));
    }, timeoutMs);
  });
}

function wsSendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function typeMatcher(type, predicate = null) {
  return (msg) => msg.type === type && (!predicate || predicate(msg));
}

function buildAgentMessagePayload({ text, sessionId, mode, agent, attachments }) {
  return {
    type: 'message',
    text,
    sessionId,
    mode,
    agent,
    ...(attachments ? { attachments } : {}),
  };
}

function createScenarioClient(messages, ws) {
  return {
    send(payload) {
      wsSendJson(ws, payload);
    },
    waitFor(predicate, timeoutMs) {
      return nextMessage(messages, ws, predicate, timeoutMs);
    },
    waitForType(type, predicate = null, timeoutMs) {
      return nextMessage(messages, ws, typeMatcher(type, predicate), timeoutMs);
    },
    async sendAndWait(payload, predicate, timeoutMs) {
      wsSendJson(ws, payload);
      return nextMessage(messages, ws, predicate, timeoutMs);
    },
    async sendAndWaitType(payload, type, predicate = null, timeoutMs) {
      wsSendJson(ws, payload);
      return nextMessage(messages, ws, typeMatcher(type, predicate), timeoutMs);
    },
  };
}

async function saveConfigAndWait(client, saveType, config, responseType) {
  return client.sendAndWaitType(
    { type: saveType, config },
    responseType,
  );
}

function createTestRunner() {
  const results = [];
  return {
    async run(name, fn) {
      const startedAt = Date.now();
      try {
        await fn();
        const durationMs = Date.now() - startedAt;
        results.push({ name, ok: true, durationMs });
        console.log(`ok - ${name} (${durationMs}ms)`);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        results.push({ name, ok: false, error, durationMs });
        console.error(`not ok - ${name} (${durationMs}ms)`);
        console.error(error.stack || error.message);
      }
    },
    finish() {
      const failed = results.filter((item) => !item.ok);
      if (failed.length > 0) {
        const summary = failed.map((item, index) => `${index + 1}. ${item.name}: ${item.error.message}`).join('\n');
        throw new Error(`Regression failed: ${failed.length}/${results.length} case(s)\n${summary}`);
      }
      console.log(`Regression checks passed (${results.length} cases).`);
    },
  };
}

async function connectAuthedClient(port, password, options = {}) {
  const { ws, messages, token } = await connectWs(port, password, WS_CONNECT_TIMEOUT_MS, options);
  const client = createScenarioClient(messages, ws);
  await client.waitForType('session_list');
  return { ws, messages, token, client };
}

async function withAuthedClient(port, password, fn, options = {}) {
  const connection = await connectAuthedClient(port, password, options);
  try {
    return await fn(connection);
  } finally {
    await closeWs(connection.ws);
  }
}

function findProcessLogLine(logsDir, sessionId, eventName) {
  const processLogPath = path.join(logsDir, 'process.log');
  if (!fs.existsSync(processLogPath)) return '';
  return fs.readFileSync(processLogPath, 'utf8')
    .trim()
    .split('\n')
    .find((line) => line.includes(`"event":"${eventName}"`) && line.includes(sessionId.slice(0, 8))) || '';
}

function findProcessLogLines(logsDir, sessionId, eventName) {
  const processLogPath = path.join(logsDir, 'process.log');
  if (!fs.existsSync(processLogPath)) return [];
  return fs.readFileSync(processLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.includes(`"event":"${eventName}"`) && line.includes(sessionId.slice(0, 8)));
}

function readProcessLog(logsDir) {
  const processLogPath = path.join(logsDir, 'process.log');
  if (!fs.existsSync(processLogPath)) return '';
  return fs.readFileSync(processLogPath, 'utf8');
}

function readStoredSessionFile(sessionsDir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(sessionsDir, `${sessionId}.json`), 'utf8'));
}

function readRuntimeIdFromContextLike(context) {
  if (!context || typeof context !== 'object') return '';
  const candidates = [
    context.runtimeId,
    context.sessionId,
    context.threadId,
    context.claudeSessionId,
    context.codexThreadId,
    context.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return '';
}

function listAgentRuntimeContexts(session, agent) {
  const contexts = [];
  const runtimeContexts = session?.runtimeContexts;
  if (!runtimeContexts || typeof runtimeContexts !== 'object') return contexts;

  const byAgent = runtimeContexts[agent];
  if (byAgent && typeof byAgent === 'object' && !Array.isArray(byAgent)) {
    for (const [channelKey, context] of Object.entries(byAgent)) {
      if (context && typeof context === 'object') {
        contexts.push({ channelKey, context });
      }
    }
    return contexts;
  }

  for (const [channelKey, context] of Object.entries(runtimeContexts)) {
    if (!context || typeof context !== 'object') continue;
    if (String(context.agent || '').toLowerCase() !== String(agent || '').toLowerCase()) continue;
    contexts.push({ channelKey, context });
  }
  return contexts;
}

function getActiveStoredRuntimeId(session, agent) {
  const normalizedAgent = String(agent || '').toLowerCase();
  if (!session || !normalizedAgent) return '';

  const activeRuntime = session.activeRuntime;
  if (activeRuntime && typeof activeRuntime === 'object') {
    const activeAgent = String(activeRuntime.agent || '').toLowerCase();
    if (!activeAgent || activeAgent === normalizedAgent) {
      const runtimeId = readRuntimeIdFromContextLike(activeRuntime);
      if (runtimeId) return runtimeId;
    }
  }

  const contexts = listAgentRuntimeContexts(session, normalizedAgent);
  const activeChannelKey = String(session.activeChannelKey || '').trim();
  if (activeChannelKey) {
    const activeContextEntry = contexts.find((entry) => String(entry.channelKey || '') === activeChannelKey);
    const runtimeId = readRuntimeIdFromContextLike(activeContextEntry?.context);
    if (runtimeId) return runtimeId;
  }

  if (contexts.length === 1) {
    const runtimeId = readRuntimeIdFromContextLike(contexts[0].context);
    if (runtimeId) return runtimeId;
  }

  if (contexts.length > 1) {
    const sorted = contexts.slice().sort((a, b) => {
      const aTs = Date.parse(a?.context?.updatedAt || a?.context?.updated || 0) || 0;
      const bTs = Date.parse(b?.context?.updatedAt || b?.context?.updated || 0) || 0;
      return bTs - aTs;
    });
    for (const item of sorted) {
      const runtimeId = readRuntimeIdFromContextLike(item.context);
      if (runtimeId) return runtimeId;
    }
  }

  if (normalizedAgent === 'claude') {
    return String(session.claudeSessionId || '').trim();
  }
  if (normalizedAgent === 'codex') {
    return String(session.codexThreadId || '').trim();
  }
  return '';
}

function assertNoSystemMessageSince(messages, startIndex, pattern, label) {
  const list = Array.isArray(messages) ? messages : [];
  const start = Math.max(0, Number(startIndex) || 0);
  const matched = list.slice(start).find((msg) => {
    if (!msg || msg.type !== 'system_message') return false;
    return pattern.test(String(msg.message || ''));
  });
  assert(!matched, label);
}

function getLastStoredAssistantText(sessionsDir, sessionId) {
  const session = readStoredSessionFile(sessionsDir, sessionId);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      return String(messages[index].content || '');
    }
  }
  return '';
}

function assertCarryoverPromptInjected(text, expectedSnippets = []) {
  assert(/\[webcoding 自动上下文续接\]/.test(text), 'New thread input should include the carryover envelope header');
  assert(/\[结构化上下文摘要\]/.test(text), 'New thread input should include the structured summary section');
  assert(/\[最近对话原文\]/.test(text), 'New thread input should include recent raw messages');
  assert(/\[本次用户新输入\]/.test(text), 'New thread input should include the current user input section');
  for (const snippet of expectedSnippets) {
    assert(text.includes(snippet), `Carryover input should preserve snippet: ${snippet}`);
  }
}

function createExpiredAttachmentFixture(sessionsDir) {
  const attachmentsDir = path.join(sessionsDir, '_attachments');
  mkdirp(attachmentsDir);
  const attachmentId = 'expired-attachment-fixture';
  const sessionId = 'expired-attachment-session';
  const dataPath = path.join(attachmentsDir, `${attachmentId}.png`);
  const metaPath = path.join(attachmentsDir, `${attachmentId}.json`);
  const now = Date.now();
  const createdAt = new Date(now - (8 * 24 * 60 * 60 * 1000)).toISOString();
  const expiresAt = new Date(now - (2 * 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(
    dataPath,
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex'),
  );
  fs.writeFileSync(metaPath, JSON.stringify({
    id: attachmentId,
    kind: 'image',
    filename: 'expired-fixture.png',
    mime: 'image/png',
    size: 67,
    createdAt,
    expiresAt,
    path: dataPath,
  }, null, 2));
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    title: 'Expired Attachment Fixture',
    created: createdAt,
    updated: createdAt,
    agent: 'codex',
    claudeSessionId: null,
    codexThreadId: null,
    model: null,
    permissionMode: 'yolo',
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [{
      role: 'user',
      content: 'expired attachment fixture',
      attachments: [{
        id: attachmentId,
        kind: 'image',
        filename: 'expired-fixture.png',
        mime: 'image/png',
        size: 67,
        createdAt,
        expiresAt,
        storageState: 'available',
      }],
      timestamp: createdAt,
    }],
    cwd: '/tmp/expired-attachment-space',
  }, null, 2));
  return { sessionId, attachmentId, dataPath, metaPath };
}

function createFakeClaudeHistory(homeDir) {
  const projectDir = path.join(homeDir, '.claude', 'projects', 'tmp-project');
  mkdirp(projectDir);
  const sessionId = 'claude-import-test';
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: '/tmp/project-a',
      timestamp: '2026-03-12T00:00:00.000Z',
      message: { content: 'Claude import prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-12T00:00:02.000Z',
      message: { content: [{ type: 'text', text: 'Claude import answer' }] },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return { sessionId, projectDir: 'tmp-project', filePath };
}

function writeFakeCodexModelsCache(homeDir) {
  const modelsCachePath = path.join(homeDir, '.codex', 'models_cache.json');
  mkdirp(path.dirname(modelsCachePath));
  fs.writeFileSync(modelsCachePath, JSON.stringify({
    fetched_at: '2026-03-12T00:00:00.000Z',
    client_version: '0.114.0',
    models: [
      {
        slug: 'custom-regression-model',
        display_name: 'custom-regression-model',
        description: 'Regression-only Codex model.',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
      },
      {
        slug: 'gpt-5.3-codex',
        display_name: 'gpt-5.3-codex',
        description: 'Latest frontier agentic coding model.',
        visibility: 'list',
        supported_in_api: true,
        priority: 1,
      },
    ],
  }, null, 2));
}

function writeFakeCodexRollout(homeDir, threadId) {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '12');
  mkdirp(sessionsDir);
  const rolloutPath = path.join(sessionsDir, 'rollout-2026-03-12T00-00-00-codex-import-thread.jsonl');
  const rolloutLines = [
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project-b', cli_version: '0.114.0', source: 'exec' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md wrapper should be ignored' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex import prompt' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex import answer' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } },
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, `${rolloutLines.join('\n')}\n`);
  return rolloutPath;
}

function writeFakeCodexStateDb(homeDir, threadId, rolloutPath) {
  const stateDb = path.join(homeDir, '.codex', 'state_5.sqlite');
  mkdirp(path.dirname(stateDb));
  runSqliteStatements(stateDb, [
    'PRAGMA journal_mode = WAL;',
    `
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled'
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS stage1_outputs (
        thread_id TEXT PRIMARY KEY,
        source_updated_at INTEGER NOT NULL,
        raw_memory TEXT NOT NULL,
        rollout_summary TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
    `,
    `
      CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        PRIMARY KEY(thread_id, position)
      );
    `,
    SQL_CREATE_LOGS_TABLE,
    buildInsertThreadSql(threadId, rolloutPath),
    buildInsertLogSql(threadId),
  ]);
  return stateDb;
}

function writeFakeCodexLogsDb(homeDir, threadId) {
  const logsDb = path.join(homeDir, '.codex', 'logs_1.sqlite');
  mkdirp(path.dirname(logsDb));
  runSqliteStatements(logsDb, [
    SQL_CREATE_LOGS_TABLE,
    buildInsertLogSql(threadId),
  ]);
  return logsDb;
}

function buildFakeCodexFixture(homeDir, threadId) {
  writeFakeCodexModelsCache(homeDir);
  const rolloutPath = writeFakeCodexRollout(homeDir, threadId);
  const stateDb = writeFakeCodexStateDb(homeDir, threadId, rolloutPath);
  const logsDb = writeFakeCodexLogsDb(homeDir, threadId);
  return { threadId, rolloutPath, stateDb, logsDb };
}

function createFakeCodexHistory(homeDir) {
  return buildFakeCodexFixture(homeDir, 'codex-import-thread');
}

async function runAuthRegressionCase({ port, password }) {
  const wrongAuth = await openWs(port);
  try {
    wrongAuth.ws.send(JSON.stringify({ type: 'auth', password: 'totally-wrong-password' }));
    const wrongResult = await nextMessage(wrongAuth.messages, wrongAuth.ws, typeMatcher('auth_result', (msg) => msg.success === false));
    assert(/认证失败/.test(wrongResult.error || ''), 'Wrong password should fail authentication');
  } finally {
    await closeWs(wrongAuth.ws);
  }

  const emptyAuth = await openWs(port);
  try {
    emptyAuth.ws.send(JSON.stringify({ type: 'auth', password: '' }));
    const emptyResult = await nextMessage(emptyAuth.messages, emptyAuth.ws, typeMatcher('auth_result', (msg) => msg.success === false));
    assert(/认证失败/.test(emptyResult.error || ''), 'Empty password should fail authentication');
  } finally {
    await closeWs(emptyAuth.ws);
  }

  const repeatedAuth = await openWs(port);
  try {
    repeatedAuth.ws.send(JSON.stringify({ type: 'auth', password }));
    const firstSuccess = await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('auth_result', (msg) => msg.success === true));
    assert(typeof firstSuccess.token === 'string' && firstSuccess.token.length > 0, 'Successful auth should return a token');
    await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('session_list'));

    repeatedAuth.ws.send(JSON.stringify({ type: 'auth', token: firstSuccess.token }));
    const secondSuccess = await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('auth_result', (msg) => msg.success === true));
    assert(secondSuccess.token === firstSuccess.token, 'Repeated auth with token should preserve the same token');
    await nextMessage(repeatedAuth.messages, repeatedAuth.ws, typeMatcher('session_list'));
  } finally {
    await closeWs(repeatedAuth.ws);
  }
}

async function runRuntimeErrorRegressionCase({ port, password, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    const erroredSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex auth error', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex auth error',
    );
    const runtimeError = await client.waitForType('error', (msg) => /Codex 鉴权失败/.test(msg.message || ''), 8000);
    assert(/Codex 鉴权失败/.test(runtimeError.message || ''), 'Codex auth stderr should be mapped to a friendly auth error');
    await client.waitForType('done', (msg) => msg.sessionId === erroredSession.sessionId, 8000);
    await waitForCondition(
      () => findProcessLogLine(logsDir, erroredSession.sessionId, 'process_complete').includes('"exitCode":1'),
      { timeoutMs: 2000, intervalMs: 50, label: 'runtime error process_complete log' },
    );
    const processCompleteLine = findProcessLogLine(logsDir, erroredSession.sessionId, 'process_complete');
    assert(processCompleteLine && processCompleteLine.includes('"exitCode":1'), 'Non-zero CLI exit should be recorded in process_complete log');

    const silentCodexSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex silent exit', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex silent exit',
    );
    await client.waitForType('text_delta', (msg) => /silent exit/.test(msg.text || ''), 8000);
    const silentCodexError = await client.waitForType('error', (msg) => /Codex 任务异常结束（退出码 1）/.test(msg.message || ''), 8000);
    assert(/Codex 任务异常结束（退出码 1）/.test(silentCodexError.message || ''), 'Codex silent non-zero exit should surface a generic failure message');
    await client.waitForType('done', (msg) => msg.sessionId === silentCodexSession.sessionId, 8000);
    const silentCodexProcessCompleteLine = findProcessLogLine(logsDir, silentCodexSession.sessionId, 'process_complete');
    assert(silentCodexProcessCompleteLine.includes('process exited with non-zero status 1 but returned no stderr'), 'Codex silent exit should be explicit in process_complete log');

    const silentClaudeSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger claude silent exit', mode: 'yolo', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'trigger claude silent exit',
    );
    await client.waitForType('text_delta', (msg) => /trigger claude silent exit/.test(msg.text || ''), 8000);
    const silentClaudeError = await client.waitForType('error', (msg) => /Claude 任务异常结束（退出码 1）/.test(msg.message || ''), 8000);
    assert(/Claude 任务异常结束（退出码 1）/.test(silentClaudeError.message || ''), 'Claude silent non-zero exit should surface a generic failure message');
    await client.waitForType('done', (msg) => msg.sessionId === silentClaudeSession.sessionId, 8000);
    const silentClaudeProcessCompleteLine = findProcessLogLine(logsDir, silentClaudeSession.sessionId, 'process_complete');
    assert(silentClaudeProcessCompleteLine.includes('process exited with non-zero status 1 but returned no stderr'), 'Claude silent exit should be explicit in process_complete log');
  });
}

async function runAttachmentBoundaryRegressionCase({ port, password }) {
  await withAuthedClient(port, password, async ({ token }) => {
    try {
      const oversizedUpload = await uploadAttachmentExpectFailure(
        port,
        token,
        {
          filename: 'too-large.png',
          mime: 'image/png',
          data: Buffer.alloc(10 * 1024 * 1024 + 1, 0),
        },
        413,
      );
      assert(/10MB/.test(oversizedUpload.payload.message || ''), 'Oversized attachment should be rejected with size limit message');
    } catch (error) {
      assert(/fetch failed|socket hang up|ECONNRESET/i.test(error.message || ''), 'Oversized attachment should be rejected or connection aborted by the server');
    }

    const invalidTypeUpload = await uploadAttachmentExpectFailure(
      port,
      token,
      {
        filename: 'not-an-image.txt',
        mime: 'text/plain',
        data: Buffer.from('plain text is not a supported image'),
      },
      400,
    );
    assert(/仅支持/.test(invalidTypeUpload.payload.message || ''), 'Unsupported attachment mime type should be rejected');
  });
}

async function runWebSocketGuardRegressionCase({ port }) {
  const socket = await openWs(port);
  try {
    socket.ws.send(JSON.stringify({ type: 'message', text: 'unauthenticated hello', agent: 'codex', mode: 'yolo' }));
    const unauthenticatedError = await nextMessage(
      socket.messages,
      socket.ws,
      typeMatcher('error', (msg) => /Not authenticated/.test(msg.message || '')),
    );
    assert(/Not authenticated/.test(unauthenticatedError.message || ''), 'Unauthenticated WebSocket message should be rejected');

    socket.ws.send('not-json-at-all');
    const invalidJsonError = await nextMessage(
      socket.messages,
      socket.ws,
      typeMatcher('error', (msg) => /Invalid JSON/.test(msg.message || '')),
    );
    assert(/Invalid JSON/.test(invalidJsonError.message || ''), 'Malformed WebSocket payload should return Invalid JSON');
  } finally {
    await closeWs(socket.ws);
  }
}

async function runExpiredAttachmentCleanupRegressionCase({ port, password, expiredAttachmentFixture }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await waitForCondition(
      () => !fs.existsSync(expiredAttachmentFixture.metaPath) && !fs.existsSync(expiredAttachmentFixture.dataPath),
      { timeoutMs: 3000, label: 'expired attachment cleanup on startup' },
    );

    client.send({ type: 'load_session', sessionId: expiredAttachmentFixture.sessionId });
    const expiredSession = await client.waitForType(
      'session_info',
      (msg) => msg.sessionId === expiredAttachmentFixture.sessionId,
      5000,
    );
    const expiredAttachment = expiredSession.messages?.[0]?.attachments?.[0] || null;
    assert(expiredAttachment && expiredAttachment.id === expiredAttachmentFixture.attachmentId, 'Expired attachment session should still expose the original attachment id');
    assert(expiredAttachment.storageState === 'expired', 'Expired attachment should be marked as expired when the session is loaded');

    client.send(buildAgentMessagePayload({
      text: 'retry expired attachment',
      sessionId: expiredAttachmentFixture.sessionId,
      mode: 'yolo',
      agent: 'codex',
      attachments: [{ id: expiredAttachmentFixture.attachmentId }],
    }));
    const expiredAttachmentError = await client.waitForType(
      'error',
      (msg) => /图片附件已过期或不可用/.test(msg.message || ''),
      5000,
    );
    assert(/图片附件已过期或不可用/.test(expiredAttachmentError.message || ''), 'Sending an expired attachment reference should be rejected');
  });
}

async function runConcurrentSessionsRegressionCase({ port, password }) {
  let connectionA = null;
  let connectionB = null;
  let connectionC = null;
  try {
    connectionA = await connectAuthedClient(port, password);
    connectionB = await connectAuthedClient(port, password);

    const sessionA = await connectionA.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream alpha', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream alpha',
    );
    await connectionA.client.waitForType('text_delta', (msg) => /slow-start:alpha/.test(msg.text || ''), 5000);

    const sessionB = await connectionB.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream beta', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream beta',
    );
    await connectionB.client.waitForType('text_delta', (msg) => /slow-start:beta/.test(msg.text || ''), 5000);

    const concurrentList = await connectionA.client.sendAndWaitType(
      { type: 'list_sessions' },
      'session_list',
      (msg) => msg.sessions.some((session) => session.id === sessionA.sessionId && session.isRunning)
        && msg.sessions.some((session) => session.id === sessionB.sessionId && session.isRunning),
      5000,
    );
    assert(concurrentList.sessions.some((session) => session.id === sessionA.sessionId && session.isRunning), 'Session alpha should be running concurrently');
    assert(concurrentList.sessions.some((session) => session.id === sessionB.sessionId && session.isRunning), 'Session beta should be running concurrently');

    connectionC = await connectAuthedClient(port, password);
    connectionC.client.send({ type: 'load_session', sessionId: sessionA.sessionId });
    const loadedSessionA = await connectionC.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === sessionA.sessionId && msg.isRunning === true,
      5000,
    );
    assert(loadedSessionA.isRunning === true, 'Loading a running session from another client should keep isRunning=true');
    const resumedSessionA = await connectionC.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === sessionA.sessionId && /slow-start:alpha/.test(msg.text || ''),
      5000,
    );
    assert(/slow-start:alpha/.test(resumedSessionA.text || ''), 'Second client should receive current stream snapshot for active session');

    await closeWs(connectionA.ws);
    await connectionC.client.waitForType('done', (msg) => msg.sessionId === sessionA.sessionId, 10000);
    await connectionB.client.waitForType('done', (msg) => msg.sessionId === sessionB.sessionId, 10000);
  } finally {
    if (connectionA) await closeWs(connectionA.ws);
    if (connectionB) await closeWs(connectionB.ws);
    if (connectionC) await closeWs(connectionC.ws);
  }
}

async function runReconnectResumeRegressionCase({ port, password }) {
  let originalConnection = null;
  let resumedConnection = null;
  try {
    originalConnection = await connectAuthedClient(port, password);
    const reconnectSession = await originalConnection.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream reconnect', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream reconnect',
    );
    await originalConnection.client.waitForType('text_delta', (msg) => /slow-start:reconnect/.test(msg.text || ''), 5000);

    await closeWs(originalConnection.ws);
    await waitForCondition(
      () => originalConnection.ws.readyState === WebSocket.CLOSED,
      { timeoutMs: 2000, label: 'client websocket close before reconnect' },
    );

    resumedConnection = await connectAuthedClient(port, password);
    resumedConnection.client.send({ type: 'load_session', sessionId: reconnectSession.sessionId });
    const loadedReconnectSession = await resumedConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === reconnectSession.sessionId && msg.isRunning === true,
      5000,
    );
    assert(loadedReconnectSession.isRunning === true, 'Reconnected client should see session still running');
    const resumedStream = await resumedConnection.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === reconnectSession.sessionId && /slow-start:reconnect/.test(msg.text || ''),
      5000,
    );
    assert(/slow-start:reconnect/.test(resumedStream.text || ''), 'Reconnected client should recover existing streamed text');
    await resumedConnection.client.waitForType('text_delta', (msg) => /slow-mid:reconnect|slow-end:reconnect/.test(msg.text || ''), 5000);
    await resumedConnection.client.waitForType('done', (msg) => msg.sessionId === reconnectSession.sessionId, 10000);
  } finally {
    if (originalConnection) await closeWs(originalConnection.ws);
    if (resumedConnection) await closeWs(resumedConnection.ws);
  }
}

async function runServerRestartRecoveryRegressionCase({ port, password, logsDir, serverHandle, serverEnv }) {
  let initialConnection = null;
  let restartedHandle = null;
  let recoveredConnection = null;
  try {
    initialConnection = await connectAuthedClient(port, password);
    const restartSession = await initialConnection.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream restart', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream restart',
    );
    await initialConnection.client.waitForType('text_delta', (msg) => /slow-start:restart/.test(msg.text || ''), 5000);

    await stopServer(serverHandle);
    await waitForCondition(
      () => initialConnection.ws.readyState !== WebSocket.OPEN,
      { timeoutMs: 3000, label: 'websocket close after server restart' },
    );

    restartedHandle = await startServer(serverEnv);
    serverHandle.child = restartedHandle.child;
    serverHandle.stdout = restartedHandle.stdout;
    serverHandle.stderr = restartedHandle.stderr;
    serverHandle.env = restartedHandle.env;
    recoveredConnection = await connectAuthedClient(port, password);
    const recoveredList = await recoveredConnection.client.sendAndWaitType(
      { type: 'list_sessions' },
      'session_list',
      (msg) => msg.sessions.some((session) => session.id === restartSession.sessionId && session.isRunning),
      5000,
    );
    assert(recoveredList.sessions.some((session) => session.id === restartSession.sessionId && session.isRunning), 'Recovered server should mark interrupted session as running');

    recoveredConnection.client.send({ type: 'load_session', sessionId: restartSession.sessionId });
    const loadedRestartSession = await recoveredConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === restartSession.sessionId && msg.isRunning === true,
      5000,
    );
    assert(loadedRestartSession.isRunning === true, 'Recovered session should still be attachable as running');
    const resumedRestartStream = await recoveredConnection.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === restartSession.sessionId && /slow-start:restart/.test(msg.text || ''),
      5000,
    );
    assert(/slow-start:restart/.test(resumedRestartStream.text || ''), 'Recovered server should replay streamed text snapshot');
    const recoveryLine = findProcessLogLine(logsDir, restartSession.sessionId, 'recovery_alive');
    assert(recoveryLine, 'Recovered server should log recovery_alive for the resumed process');
    await recoveredConnection.client.waitForType('text_delta', (msg) => /slow-mid:restart|slow-end:restart/.test(msg.text || ''), 6000);
    await recoveredConnection.client.waitForType('done', (msg) => msg.sessionId === restartSession.sessionId, 10000);
  } finally {
    if (initialConnection) await closeWs(initialConnection.ws);
    if (recoveredConnection) await closeWs(recoveredConnection.ws);
  }
}

async function runNotificationFailureRegressionCase({ port, password, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await saveConfigAndWait(
      client,
      'save_notify_config',
      {
        provider: 'telegram',
        pushplus: { token: '' },
        telegram: { botToken: 'definitely-invalid-telegram-token', chatId: '123456' },
        serverchan: { sendKey: '' },
        feishu: { webhook: '' },
        qqbot: { qmsgKey: '' },
      },
      'notify_config',
    );
    await client.waitForType('system_message', (msg) => /通知配置已保存/.test(msg.message || ''), 5000);

    client.send({ type: 'test_notify' });
    const notifyResult = await client.waitForType('notify_test_result', null, 15000);
    assert(notifyResult.success === false, 'Invalid notification config should produce a failed notify_test_result');
    assert(/发送失败/.test(notifyResult.message || ''), 'Failed notification attempt should surface failure details to the client');

    await waitForCondition(() => {
      const processLog = readProcessLog(logsDir);
      return (
        (processLog.includes('"event":"notify_response"') || processLog.includes('"event":"notify_error"'))
        && processLog.includes('"provider":"telegram"')
      );
    }, { timeoutMs: 15000, intervalMs: 200, label: 'notification failure log' });

    const postNotifyList = await client.sendAndWaitType({ type: 'list_sessions' }, 'session_list', null, 5000);
    assert(Array.isArray(postNotifyList.sessions), 'Server should remain responsive after failed notification send');
  });
}

async function runAuthLockRegressionCase({ port, password }) {
  const ip = '203.0.113.25';
  const wsOptions = { headers: { 'x-forwarded-for': ip } };

  for (let attempt = 1; attempt <= 4; attempt++) {
    const socket = await openWs(port, WS_CONNECT_TIMEOUT_MS, wsOptions);
    try {
      socket.ws.send(JSON.stringify({ type: 'auth', password: `wrong-password-${attempt}` }));
      const authResult = await nextMessage(socket.messages, socket.ws, typeMatcher('auth_result', (msg) => msg.success === false), 5000);
      assert(/认证失败/.test(authResult.error || ''), `Auth attempt ${attempt} should fail without locking yet`);
    } finally {
      await closeWs(socket.ws);
    }
  }

  const lockedSocket = await openWs(port, WS_CONNECT_TIMEOUT_MS, wsOptions);
  try {
    lockedSocket.ws.send(JSON.stringify({ type: 'auth', password: 'still-wrong' }));
    const lockedResult = await nextMessage(lockedSocket.messages, lockedSocket.ws, typeMatcher('auth_result', (msg) => msg.success === false), 5000);
    assert(/登录失败次数过多/.test(lockedResult.error || ''), 'Fifth failed auth attempt should lock the client IP');
  } finally {
    await closeWs(lockedSocket.ws);
  }

  const blockedValidSocket = await openWs(port, WS_CONNECT_TIMEOUT_MS, wsOptions);
  try {
    blockedValidSocket.ws.send(JSON.stringify({ type: 'auth', password }));
    const blockedResult = await nextMessage(blockedValidSocket.messages, blockedValidSocket.ws, typeMatcher('auth_result', (msg) => msg.success === false), 5000);
    assert(/登录失败次数过多/.test(blockedResult.error || ''), 'Locked client IP should reject even a correct password during the lock window');
  } finally {
    await closeWs(blockedValidSocket.ws);
  }
}

async function runFetchModelsApiBaseCompatibilityRegressionCase({ port, password, tempRoot }) {
  const upstreamPort = await getFreePort();
  const upstream = await startResponsesFallbackUpstream(upstreamPort);
  try {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      const variants = [
        { label: 'without-v1', apiBase: `http://127.0.0.1:${upstreamPort}` },
        { label: 'with-v1', apiBase: `http://127.0.0.1:${upstreamPort}/v1` },
      ];

      for (const variant of variants) {
        const fetchResult = await client.sendAndWaitType(
          {
            type: 'fetch_models',
            apiBase: variant.apiBase,
            apiKey: 'sk-regression',
            upstreamType: 'openai',
            templateName: `Regression ${variant.label}`,
          },
          'fetch_models_result',
        );
        assert(fetchResult.success === true, `fetch_models ${variant.label} should succeed: ${fetchResult.message || 'unknown error'}`);
        assert(Array.isArray(fetchResult.models) && fetchResult.models.includes('regression-api-model'), `fetch_models ${variant.label} should return regression-api-model`);

        await saveConfigAndWait(
          client,
          'save_model_config',
          {
            mode: 'custom',
            activeTemplate: `Regression ${variant.label}`,
            templates: [{
              name: `Regression ${variant.label}`,
              apiKey: 'sk-regression',
              apiBase: variant.apiBase,
              upstreamType: 'openai',
              defaultModel: 'regression-api-model',
              opusModel: 'claude-opus-4-6',
              sonnetModel: 'claude-sonnet-4-6',
              haikuModel: 'claude-haiku-4-5',
            }],
          },
          'model_config',
        );

        await saveConfigAndWait(
          client,
          'save_codex_config',
          {
            mode: 'unified',
            enableSearch: false,
          },
          'codex_config',
        );

        const cwd = path.join(tempRoot, `codex-model-fetch-${variant.label}`);
        mkdirp(cwd);
        const session = await client.sendAndWaitType(
          { type: 'new_session', agent: 'codex', cwd, mode: 'plan' },
          'session_info',
          (msg) => msg.agent === 'codex' && msg.cwd === cwd,
        );
        const modelList = await client.sendAndWaitType(
          buildAgentMessagePayload({ text: '/model', sessionId: session.sessionId, mode: 'plan', agent: 'codex' }),
          'model_list',
          (msg) => msg.agent === 'codex'
            && Array.isArray(msg.entries)
            && msg.entries.some((entry) => entry.value === 'regression-api-model'),
        );
        assert(modelList.entries.some((entry) => entry.value === 'regression-api-model'), `Codex /model ${variant.label} should use upstream model list`);
      }
    });

    const modelRequests = upstream.requests.filter((req) => req.path === '/v1/models');
    assert(modelRequests.length >= 4, `Version compatibility regression should hit /v1/models at least 4 times, got ${modelRequests.length}`);
    assert(!upstream.requests.some((req) => req.path.includes('/v1/v1/')), 'No fetch_models or Codex model request should duplicate /v1 in upstream path');
  } finally {
    await upstream.close();
  }
}

async function runBridgeResponsesFallbackRegressionCase({ tempRoot }) {
  const bridgeTempDir = path.join(tempRoot, 'bridge-fallback');
  mkdirp(bridgeTempDir);
  const upstreamPort = await getFreePort();
  const upstream = await startResponsesFallbackUpstream(upstreamPort);
  let bridgeHandle = null;
  try {
    bridgeHandle = await startBridgeProcess(bridgeTempDir, upstreamPort);

    const openAiResponse = await requestHttpJson({
      port: bridgeHandle.state.port,
      path: '/openai/responses',
      method: 'POST',
      headers: {
        authorization: 'Bearer bridge-regression-token',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'fallback-model',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }],
        }],
        stream: false,
      }),
    });
    assert(openAiResponse.statusCode === 200, `Bridge OpenAI fallback should return 200, got ${openAiResponse.statusCode}`);
    assert(openAiResponse.json?.output_text === 'pong', 'Bridge OpenAI fallback should translate chat completions back into Responses output');

    const anthropicResponse = await requestHttpJson({
      port: bridgeHandle.state.port,
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': 'bridge-regression-token',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'fallback-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }),
    });
    assert(anthropicResponse.statusCode === 200, `Bridge Anthropic fallback should return 200, got ${anthropicResponse.statusCode}`);
    assert(/event: message_start/.test(anthropicResponse.text), 'Bridge Anthropic fallback should emit Anthropic SSE');
    assert(/pong/.test(anthropicResponse.text), 'Bridge Anthropic fallback should include fallback model text');

    assert(upstream.counters.responses === 2, `Bridge should probe /responses twice, got ${upstream.counters.responses}`);
    assert(upstream.counters.chatCompletions === 2, `Bridge should fall back to /chat/completions twice, got ${upstream.counters.chatCompletions}`);
  } finally {
    await stopBridgeProcess(bridgeHandle);
    await upstream.close();
  }
}

async function runBridgeResponses404FallbackRegressionCase({ tempRoot }) {
  const bridgeTempDir = path.join(tempRoot, 'bridge-fallback-404');
  mkdirp(bridgeTempDir);
  const upstreamPort = await getFreePort();
  const upstream = await startResponsesFallbackUpstream(upstreamPort, {
    responsesStatus: 404,
    responsesError: {
      error: {
        message: 'openai_error',
        type: 'bad_response_status_code',
        param: '',
        code: 'bad_response_status_code',
      },
    },
  });
  let bridgeHandle = null;
  try {
    bridgeHandle = await startBridgeProcess(bridgeTempDir, upstreamPort);

    const openAiResponse = await requestHttpJson({
      port: bridgeHandle.state.port,
      path: '/openai/responses',
      method: 'POST',
      headers: {
        authorization: 'Bearer bridge-regression-token',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'fallback-model',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }],
        }],
        stream: true,
      }),
    });
    assert(openAiResponse.statusCode === 200, `Bridge 404 fallback should return 200, got ${openAiResponse.statusCode}`);
    assert(/event: response\.created/.test(openAiResponse.text), 'Bridge 404 fallback should emit OpenAI SSE');
    assert(/pong/.test(openAiResponse.text), 'Bridge 404 fallback should include translated fallback text');
    assert(upstream.counters.responses === 1, `Bridge 404 fallback should probe /responses once, got ${upstream.counters.responses}`);
    assert(upstream.counters.chatCompletions === 1, `Bridge 404 fallback should fall back to /chat/completions once, got ${upstream.counters.chatCompletions}`);
  } finally {
    await stopBridgeProcess(bridgeHandle);
    await upstream.close();
  }
}

async function runBridgeStreamingPassthroughRegressionCase({ tempRoot }) {
  const bridgeTempDir = path.join(tempRoot, 'bridge-streaming');
  mkdirp(bridgeTempDir);
  const upstreamPort = await getFreePort();
  const upstream = await startStreamingResponsesUpstream(upstreamPort);
  let bridgeHandle = null;
  try {
    bridgeHandle = await startBridgeProcess(bridgeTempDir, upstreamPort);

    const streamedResponse = await requestHttpJson({
      port: bridgeHandle.state.port,
      path: '/openai/responses',
      method: 'POST',
      headers: {
        authorization: 'Bearer bridge-regression-token',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'fallback-model',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }],
        }],
        stream: true,
      }),
    });
    assert(streamedResponse.statusCode === 200, `Bridge streaming passthrough should return 200, got ${streamedResponse.statusCode}`);
    assert(/event: response\.created/.test(streamedResponse.text), 'Bridge streaming passthrough should forward response.created');
    assert(/stream pong/.test(streamedResponse.text), 'Bridge streaming passthrough should forward upstream delta text');

    const responseRequest = upstream.requests.find((req) => req.path === '/v1/responses');
    assert(responseRequest?.bodyJson?.stream === true, 'Bridge should preserve stream=true when proxying OpenAI responses');
  } finally {
    await stopBridgeProcess(bridgeHandle);
    await upstream.close();
  }
}

async function runBridgeReasoningEffortRegressionCase({ tempRoot }) {
  const bridgeTempDir = path.join(tempRoot, 'bridge-reasoning-effort');
  mkdirp(bridgeTempDir);
  const upstreamPort = await getFreePort();
  const upstream = await startResponsesFallbackUpstream(upstreamPort);
  let bridgeHandle = null;

  async function requestBridge(body) {
    return requestHttpJson({
      port: bridgeHandle.state.port,
      path: '/openai/responses',
      method: 'POST',
      headers: {
        authorization: 'Bearer bridge-regression-token',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  try {
    bridgeHandle = await startBridgeProcess(bridgeTempDir, upstreamPort, {
      defaultModel: '',
      modelReasoningEffort: 'high',
    });

    let requestCount = upstream.requests.length;
    const injectedResponse = await requestBridge({
      model: 'gpt-5.4',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }],
      }],
      stream: false,
    });
    assert(injectedResponse.statusCode === 200, `Bridge stale reasoning effort config should return 200, got ${injectedResponse.statusCode}`);
    const injectedRequest = upstream.requests.slice(requestCount).find((req) => req.path === '/v1/responses');
    assert(!injectedRequest?.bodyJson?.reasoning?.effort, 'Bridge should ignore legacy configured reasoning effort');

    requestCount = upstream.requests.length;
    const explicitResponse = await requestBridge({
      model: 'gpt-5.4',
      reasoning: { effort: 'low' },
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }],
      }],
      stream: false,
    });
    assert(explicitResponse.statusCode === 200, `Bridge explicit reasoning request should return 200, got ${explicitResponse.statusCode}`);
    const explicitRequest = upstream.requests.slice(requestCount).find((req) => req.path === '/v1/responses');
    assert(explicitRequest?.bodyJson?.reasoning?.effort === 'low', 'Bridge should preserve explicit reasoning effort from the request body');

    requestCount = upstream.requests.length;
    const ignoredResponse = await requestBridge({
      model: 'claude-sonnet-4-6',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }],
      }],
      stream: false,
    });
    assert(ignoredResponse.statusCode === 200, `Bridge non-GPT reasoning request should return 200, got ${ignoredResponse.statusCode}`);
    const ignoredRequest = upstream.requests.slice(requestCount).find((req) => req.path === '/v1/responses');
    assert(!ignoredRequest?.bodyJson?.reasoning?.effort, 'Bridge should skip configured reasoning effort for non-GPT models');
  } finally {
    await stopBridgeProcess(bridgeHandle);
    await upstream.close();
  }
}

async function runBridgeUpstreamApiBaseCompatibilityRegressionCase({ tempRoot }) {
  const variants = [
    { label: 'without-v1', suffix: '' },
    { label: 'with-v1', suffix: '/v1' },
  ];

  for (const variant of variants) {
    const bridgeTempDir = path.join(tempRoot, `bridge-upstream-${variant.label}`);
    mkdirp(bridgeTempDir);
    const upstreamPort = await getFreePort();
    const upstream = await startResponsesFallbackUpstream(upstreamPort);
    let bridgeHandle = null;
    try {
      bridgeHandle = await startBridgeProcess(bridgeTempDir, upstreamPort, {
        upstreamApiBase: `http://127.0.0.1:${upstreamPort}${variant.suffix}`,
      });

      const modelsResponse = await requestHttpJson({
        port: bridgeHandle.state.port,
        path: '/openai/v1/models',
        method: 'GET',
        headers: {
          authorization: 'Bearer bridge-regression-token',
          accept: 'application/json',
        },
      });
      assert(modelsResponse.statusCode === 200, `Bridge models ${variant.label} should return 200, got ${modelsResponse.statusCode}`);
      assert(modelsResponse.json?.data?.some((item) => item.id === 'regression-api-model'), `Bridge models ${variant.label} should proxy regression-api-model`);

      const anthropicResponse = await requestHttpJson({
        port: bridgeHandle.state.port,
        path: '/anthropic/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': 'bridge-regression-token',
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'fallback-model',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
      });
      assert(anthropicResponse.statusCode === 200, `Bridge Anthropic ${variant.label} should return 200, got ${anthropicResponse.statusCode}`);
      assert(/pong/.test(anthropicResponse.text), `Bridge Anthropic ${variant.label} should include fallback text`);
      assert(!upstream.requests.some((req) => req.path.includes('/v1/v1/')), `Bridge upstream path ${variant.label} should not duplicate /v1`);
    } finally {
      await stopBridgeProcess(bridgeHandle);
      await upstream.close();
    }
  }
}

async function runBridgeScriptRefreshRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'bridge-script-refresh');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  fs.writeFileSync(path.join(configDir, 'model.json'), JSON.stringify({
    mode: 'custom',
    activeTemplate: 'Regression Unified API',
    templates: [{
      name: 'Regression Unified API',
      apiKey: 'upstream-test-key',
      apiBase: '',
      upstreamType: 'openai',
      defaultModel: 'fallback-model',
      opusModel: 'fallback-model',
      sonnetModel: 'fallback-model',
      haikuModel: 'fallback-model',
    }],
  }, null, 2));

  const upstreamPort = await getFreePort();
  const upstream = await startResponsesFallbackUpstream(upstreamPort);
  let legacyBridge = null;
  try {
    const modelPath = path.join(configDir, 'model.json');
    const modelConfig = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    modelConfig.templates[0].apiBase = `http://127.0.0.1:${upstreamPort}`;
    fs.writeFileSync(modelPath, JSON.stringify(modelConfig, null, 2));

    const runtimePath = path.join(configDir, 'bridge-runtime.json');
    const statePath = path.join(configDir, 'bridge-state.json');
    legacyBridge = await startLegacyBridgeProcess(runtimePath, statePath);

    const port = await getFreePort();
    await withServer({
      PORT: String(port),
      CC_WEB_PASSWORD: 'Regression!234',
      CC_WEB_CONFIG_DIR: configDir,
      CC_WEB_SESSIONS_DIR: sessionsDir,
      CC_WEB_LOGS_DIR: logsDir,
      HOME: homeDir,
      CLAUDE_PATH: MOCK_CLAUDE,
      CODEX_PATH: MOCK_CODEX,
    }, async () => {
      await waitForCondition(() => {
        try {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          return !!state.scriptFingerprint && state.pid !== legacyBridge.child.pid;
        } catch {
          return false;
        }
      }, { timeoutMs: 5000, label: 'bridge refresh state' });

      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const anthropicResponse = await requestHttpJson({
        port: state.port,
        path: '/anthropic/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': runtime.token,
          'content-type': 'application/json',
          accept: 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'fallback-model',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
      });
      assert(anthropicResponse.statusCode === 200, `Refreshed bridge should return 200, got ${anthropicResponse.statusCode}`);
      assert(/pong/i.test(anthropicResponse.text), 'Refreshed bridge should use the current fallback implementation');
    });
  } finally {
    await stopBridgeProcess(legacyBridge);
    await upstream.close();
  }
}

async function runClaudeLocalModelMapRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'claude-local-model-map');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  mkdirp(path.dirname(claudeSettingsPath));
  fs.writeFileSync(claudeSettingsPath, JSON.stringify({
    env: {
      ANTHROPIC_API_KEY: 'sk-local-custom',
      ANTHROPIC_BASE_URL: 'https://local.example.test',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-opus-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'local-sonnet-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'local-haiku-model',
      ANTHROPIC_MODEL: 'local-opus-model',
    },
    model: 'sonnet',
  }, null, 2));

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      const session = await client.sendAndWaitType(
        { type: 'new_session', agent: 'claude', cwd: caseRoot, mode: 'yolo' },
        'session_info',
        (msg) => msg.agent === 'claude' && msg.cwd === caseRoot,
      );
      const modelList = await client.sendAndWaitType(
        buildAgentMessagePayload({ text: '/model', sessionId: session.sessionId, mode: 'yolo', agent: 'claude' }),
        'model_list',
        (msg) => msg.agent === 'claude',
      );
      assert(modelList.models?.opus === 'local-opus-model', 'Claude local model map should read opus model from settings.json env');
      assert(modelList.models?.sonnet === 'local-sonnet-model', 'Claude local model map should read sonnet model from settings.json env');
      assert(modelList.models?.haiku === 'local-haiku-model', 'Claude local model map should read haiku model from settings.json env');
    });
  });
}

async function runClaudeSettingsRestoreRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'claude-settings-restore');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  const backupPath = path.join(configDir, 'claude-settings-backup.json');
  mkdirp(path.dirname(claudeSettingsPath));
  const originalSettings = {
    env: {
      ANTHROPIC_AUTH_TOKEN: 'local-auth-token',
      ANTHROPIC_BASE_URL: 'https://local.anthropic.test',
      ANTHROPIC_MODEL: 'claude-local-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-local-sonnet',
      PRESERVE_ME: 'still-here',
    },
    model: 'sonnet[1m]',
    permissions: { allow: ['Read(/tmp)'] },
  };
  fs.writeFileSync(claudeSettingsPath, JSON.stringify(originalSettings, null, 2));

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async (serverHandle) => {
    let claudeRuntimeSession = null;
    let firstRuntimeSessionId = null;

    await withAuthedClient(port, password, async ({ client, messages }) => {
      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Claude Backup Regression',
          templates: [{
            name: 'Claude Backup Regression',
            apiKey: 'sk-regression',
            apiBase: 'https://example.com/v1',
            upstreamType: 'openai',
            defaultModel: 'claude-sonnet-4-6',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );

      claudeRuntimeSession = await client.sendAndWaitType(
        buildAgentMessagePayload({ text: 'claude custom runtime baseline', mode: 'yolo', agent: 'claude' }),
        'session_info',
        (msg) => msg.agent === 'claude' && msg.title === 'claude custom runtime baseline',
      );
      await client.waitForType('done', (msg) => msg.sessionId === claudeRuntimeSession.sessionId);
    });

    const unifiedSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert(unifiedSettings.env?.PRESERVE_ME === 'still-here', 'Claude unified apply should preserve unrelated env keys');
    assert(unifiedSettings.permissions?.allow?.[0] === 'Read(/tmp)', 'Claude unified apply should preserve unrelated top-level settings');
    assert(unifiedSettings.env?.ANTHROPIC_API_KEY, 'Claude unified apply should inject managed API key');
    assert(!unifiedSettings.env?.ANTHROPIC_AUTH_TOKEN, 'Claude unified apply should replace local auth token with managed key');
    assert(/http:\/\/127\.0\.0\.1:\d+\/anthropic/.test(unifiedSettings.env?.ANTHROPIC_BASE_URL || ''), 'Claude unified apply should point at local bridge base URL');
    assert(fs.existsSync(backupPath), 'Claude unified apply should persist a local settings backup');
    const backupJson = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert(backupJson.version === 2, 'Claude settings backup should use the full-file backup format');
    assert(backupJson.exists === true, 'Claude settings backup should record that the original settings file existed');
    assert(isDeepStrictEqual(backupJson.settings, originalSettings), 'Claude settings backup should store the full original settings object');
    const storedCustomRuntimeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeRuntimeSession.sessionId}.json`), 'utf8'));
    firstRuntimeSessionId = storedCustomRuntimeSession.claudeSessionId;
    assert(firstRuntimeSessionId, 'Claude runtime baseline should persist a native Claude session id');
    assert(storedCustomRuntimeSession.claudeRuntimeFingerprint, 'Claude runtime baseline should persist a runtime fingerprint');

    unifiedSettings.model = 'custom-temp-model';
    unifiedSettings.permissions.allow.push('Write(/tmp/generated)');
    unifiedSettings.someUnifiedOnlyField = true;
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(unifiedSettings, null, 2));

    await stopServer(serverHandle);
    const restartedHandle = await startServer(serverEnv);
    serverHandle.child = restartedHandle.child;
    serverHandle.stdout = restartedHandle.stdout;
    serverHandle.stderr = restartedHandle.stderr;
    serverHandle.env = restartedHandle.env;

    await withAuthedClient(port, password, async ({ client, messages }) => {
      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'local',
          activeTemplate: 'Claude Backup Regression',
          templates: [{
            name: 'Claude Backup Regression',
            apiKey: '****',
            apiBase: 'https://example.com/v1',
            upstreamType: 'openai',
            defaultModel: 'claude-sonnet-4-6',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );

      const switchedStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: 'claude local runtime after switch',
        sessionId: claudeRuntimeSession.sessionId,
        mode: 'yolo',
        agent: 'claude',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === claudeRuntimeSession.sessionId);
      assertNoSystemMessageSince(
        messages,
        switchedStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Claude runtime switch should continue the original native thread by default',
      );
    });

    const restoredSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert(restoredSettings.env?.ANTHROPIC_AUTH_TOKEN === 'local-auth-token', 'Claude local restore should bring back original auth token');
    assert(restoredSettings.env?.ANTHROPIC_BASE_URL === 'https://local.anthropic.test', 'Claude local restore should bring back original base URL');
    assert(restoredSettings.env?.ANTHROPIC_MODEL === 'claude-local-model', 'Claude local restore should bring back original model');
    assert(restoredSettings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL === 'claude-local-sonnet', 'Claude local restore should bring back original sonnet model');
    assert(restoredSettings.model === 'custom-temp-model', 'Claude local restore should preserve user changes made outside managed env keys');
    assert(!restoredSettings.env?.ANTHROPIC_API_KEY, 'Claude local restore should remove managed API key');
    assert(restoredSettings.env?.PRESERVE_ME === 'still-here', 'Claude local restore should keep unrelated env keys');
    assert(Array.isArray(restoredSettings.permissions?.allow) && restoredSettings.permissions.allow.includes('Write(/tmp/generated)'), 'Claude local restore should preserve concurrent top-level edits');
    assert(restoredSettings.someUnifiedOnlyField === true, 'Claude local restore should preserve concurrent fields outside managed env keys');
    assert(!fs.existsSync(backupPath), 'Claude local restore should clear consumed backup file');
    const claudeSpawnLines = findProcessLogLines(logsDir, claudeRuntimeSession.sessionId, 'process_spawn');
    const latestClaudeSpawn = claudeSpawnLines[claudeSpawnLines.length - 1] || '';
    assert(claudeSpawnLines.length >= 2, 'Claude runtime switch regression should create at least two spawn records');
    assert(latestClaudeSpawn && latestClaudeSpawn.includes('"resume":true'), 'Claude runtime switch should resume the old native thread after config change by default');
    assert(latestClaudeSpawn.includes('--resume'), 'Claude runtime switch should keep the --resume arg after config change by default');
    const storedLocalRuntimeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeRuntimeSession.sessionId}.json`), 'utf8'));
    assert(storedLocalRuntimeSession.claudeSessionId && storedLocalRuntimeSession.claudeSessionId === firstRuntimeSessionId, 'Claude runtime switch should keep the original native session id after config change by default');
  });
}

async function runClaudeConfigCarryoverRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'claude-config-carryover');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  mkdirp(path.dirname(claudeSettingsPath));
  fs.writeFileSync(claudeSettingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'local-carryover-token',
      ANTHROPIC_BASE_URL: 'https://local.carryover.test',
      ANTHROPIC_MODEL: 'claude-local-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-local-sonnet',
    },
  }, null, 2));

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      const session = await client.sendAndWaitType(
        buildAgentMessagePayload({
          text: '先处理 /tmp/claude-carryover/README.md，并记住模型 claude-local-model、配置项 ANTHROPIC_BASE_URL，以及报错 local failed。',
          mode: 'yolo',
          agent: 'claude',
        }),
        'session_info',
        (msg) => msg.agent === 'claude' && msg.title.includes('/tmp/claude-carryover/README.md'),
      );
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      const firstStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const firstRuntimeSessionId = getActiveStoredRuntimeId(firstStoredSession, 'claude');
      assert(firstRuntimeSessionId, 'Claude carryover baseline should persist the first native session id');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Claude Carryover Unified',
          templates: [{
            name: 'Claude Carryover Unified',
            apiKey: 'sk-carryover',
            apiBase: 'https://unified.carryover.test/v1',
            upstreamType: 'openai',
            defaultModel: 'claude-sonnet-4-6',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );

      const unifiedStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '切到统一 API 后继续处理 /tmp/claude-carryover/src/app.js，不要丢掉 local failed 原文。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'claude',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        unifiedStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Claude config switch should continue the original native thread by default',
      );

      const unifiedStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const unifiedRuntimeSessionId = getActiveStoredRuntimeId(unifiedStoredSession, 'claude');
      assert(unifiedRuntimeSessionId && unifiedRuntimeSessionId === firstRuntimeSessionId, 'Claude config switch to unified should keep the original native session id by default');
      const unifiedAssistantText = getLastStoredAssistantText(sessionsDir, session.sessionId);
      assert(
        !/\[webcoding 自动上下文续接\]/.test(unifiedAssistantText),
        'Claude config switch to unified should not inject the carryover envelope when resuming the original thread',
      );
      const unifiedSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const unifiedSpawn = unifiedSpawnLines[unifiedSpawnLines.length - 1] || '';
      assert(unifiedSpawn.includes('"resume":true'), 'Claude config switch to unified should resume the original native thread by default');
      assert(unifiedSpawn.includes('--resume'), 'Claude config switch to unified should keep --resume by default');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Claude Carryover Unified',
          templates: [{
            name: 'Claude Carryover Unified',
            apiKey: 'sk-carryover',
            apiBase: 'https://unified.carryover.test/v1',
            upstreamType: 'openai',
            defaultModel: 'claude-opus-4-6',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );

      const resumedUnifiedStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '统一 API 下换到 claude-opus-4-6，继续刚才的文件路径。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'claude',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        resumedUnifiedStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Claude carryover unified model change should not emit new-thread carryover system messages',
      );

      const resumedStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const resumedRuntimeSessionId = getActiveStoredRuntimeId(resumedStoredSession, 'claude');
      assert(
        resumedRuntimeSessionId && resumedRuntimeSessionId === unifiedRuntimeSessionId,
        'Claude carryover unified model change should keep the same native session id',
      );
      const resumedSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const resumedSpawn = resumedSpawnLines[resumedSpawnLines.length - 1] || '';
      assert(resumedSpawn.includes('"resume":true'), 'Claude carryover unified model change should resume the existing native thread');
      assert(resumedSpawn.includes('--resume'), 'Claude carryover unified model change should include --resume');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'local',
          activeTemplate: '',
          templates: [],
        },
        'model_config',
      );

      const restoredStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '现在切回本地配置，继续上一步，并保留 /tmp/claude-carryover/src/app.js 这个路径。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'claude',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        restoredStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Claude carryover switch back to local should not emit new-thread carryover system messages',
      );

      const restoredStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const restoredRuntimeSessionId = getActiveStoredRuntimeId(restoredStoredSession, 'claude');
      assert(
        restoredRuntimeSessionId && restoredRuntimeSessionId === firstRuntimeSessionId,
        'Claude carryover switch back to local should restore the original local native session id',
      );
      const restoredAssistantText = getLastStoredAssistantText(sessionsDir, session.sessionId);
      assert(
        !/\[webcoding 自动上下文续接\]/.test(restoredAssistantText),
        'Claude carryover switch back to local should not inject carryover envelope when resuming old local channel',
      );
      const restoredSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const restoredSpawn = restoredSpawnLines[restoredSpawnLines.length - 1] || '';
      assert(restoredSpawn.includes('"resume":true'), 'Claude carryover switch back to local should resume the original local native thread');
      assert(restoredSpawn.includes('--resume'), 'Claude carryover switch back to local should include --resume');
    });
  });
}

async function runClaudeStickyResumeRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'claude-sticky-resume');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  mkdirp(path.dirname(claudeSettingsPath));
  fs.writeFileSync(claudeSettingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'local-sticky-token',
      ANTHROPIC_BASE_URL: 'https://local.sticky.test',
      ANTHROPIC_MODEL: 'claude-local-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-local-sonnet',
    },
  }, null, 2));

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      const session = await client.sendAndWaitType(
        buildAgentMessagePayload({
          text: '先记录 /tmp/claude-sticky/src/app.js，并保留 sticky local context。',
          mode: 'yolo',
          agent: 'claude',
        }),
        'session_info',
        (msg) => msg.agent === 'claude' && msg.title.includes('/tmp/claude-sticky/src/app.js'),
      );
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      const firstStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const firstRuntimeSessionId = getActiveStoredRuntimeId(firstStoredSession, 'claude');
      assert(firstRuntimeSessionId, 'Claude sticky resume regression should persist the initial native session id');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Claude Sticky Unified',
          templates: [{
            name: 'Claude Sticky Unified',
            apiKey: 'sk-claude-sticky',
            apiBase: 'https://sticky-unified.example.test/v1',
            upstreamType: 'openai',
            defaultModel: 'claude-sonnet-4-6',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );

      const stickyStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '切到统一 API 后继续处理 /tmp/claude-sticky/src/app.js，并延续 sticky local context。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'claude',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        stickyStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Claude sticky resume should not fall back to the carryover envelope after channel switch',
      );

      const stickyStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const stickyRuntimeSessionId = getActiveStoredRuntimeId(stickyStoredSession, 'claude');
      assert(
        stickyRuntimeSessionId && stickyRuntimeSessionId === firstRuntimeSessionId,
        'Claude sticky resume should keep the original native session id after channel switch',
      );
      const stickyAssistantText = getLastStoredAssistantText(sessionsDir, session.sessionId);
      assert(
        !/\[webcoding 自动上下文续接\]/.test(stickyAssistantText),
        'Claude sticky resume should not inject the carryover envelope when reusing the original native thread',
      );
      const spawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const latestSpawnLine = spawnLines[spawnLines.length - 1] || '';
      assert(latestSpawnLine.includes('"resume":true'), 'Claude sticky resume should keep resume enabled after channel switch');
      assert(latestSpawnLine.includes('--resume'), 'Claude sticky resume should include --resume after channel switch');
    });
  });
}

async function runCodexLocalConfigFingerprintRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'codex-local-fingerprint');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const codexConfigToml = path.join(homeDir, '.codex', 'config.toml');
  mkdirp(path.dirname(codexConfigToml));
  fs.writeFileSync(codexConfigToml, [
    'model_provider = "custom"',
    'model = "gpt-5.4"',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    'base_url = "https://local-a.example.test/v1"',
  ].join('\n'));

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      const session = await client.sendAndWaitType(
        { type: 'new_session', agent: 'codex', cwd: caseRoot, mode: 'yolo' },
        'session_info',
        (msg) => msg.agent === 'codex' && msg.cwd === caseRoot,
      );

      client.send(buildAgentMessagePayload({ text: 'first local codex run', sessionId: session.sessionId, mode: 'yolo', agent: 'codex' }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      const firstStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const firstThreadId = getActiveStoredRuntimeId(firstStoredSession, 'codex');
      assert(firstThreadId, 'Codex local fingerprint regression should persist initial thread id');
      assert(firstStoredSession.codexRuntimeFingerprint, 'Codex local fingerprint regression should persist initial local fingerprint');

      fs.writeFileSync(codexConfigToml, [
        'model_provider = "custom"',
        'model = "gpt-5.4-mini"',
        '',
        '[model_providers.custom]',
        'name = "custom"',
        'base_url = "https://local-b.example.test/v1"',
      ].join('\n'));

      const switchedStartIndex = messages.length;
      client.send(buildAgentMessagePayload({ text: 'second local codex run', sessionId: session.sessionId, mode: 'yolo', agent: 'codex' }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        switchedStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Codex local fingerprint change should continue the original thread by default',
      );

      const spawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const latestSpawnLine = spawnLines[spawnLines.length - 1] || '';
      assert(spawnLines.length >= 2, 'Codex local fingerprint regression should produce at least two spawn records');
      assert(latestSpawnLine && latestSpawnLine.includes('"resume":true'), 'Codex local fingerprint change should keep resume on the next run by default');
      assert(latestSpawnLine.includes('exec resume'), 'Codex local fingerprint change should keep exec resume on the next run by default');
      const secondStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const secondThreadId = getActiveStoredRuntimeId(secondStoredSession, 'codex');
      assert(secondThreadId && secondThreadId === firstThreadId, 'Codex local fingerprint change should keep the original thread id by default');
      assert(secondStoredSession.codexRuntimeFingerprint && secondStoredSession.codexRuntimeFingerprint !== firstStoredSession.codexRuntimeFingerprint, 'Codex local fingerprint change should update the stored fingerprint');
    });
  });
}

async function runCodexConfigCarryoverRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'codex-config-carryover');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const codexDir = path.join(homeDir, '.codex');
  mkdirp(codexDir);
  fs.writeFileSync(path.join(codexDir, 'config.toml'), [
    'model_provider = "custom"',
    'model = "gpt-5.4"',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    'base_url = "https://local-codex.example.test/v1"',
  ].join('\n'));
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
    access_token: 'local-codex-auth',
    token_type: 'Bearer',
  }, null, 2));

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      const session = await client.sendAndWaitType(
        { type: 'new_session', agent: 'codex', cwd: caseRoot, mode: 'yolo' },
        'session_info',
        (msg) => msg.agent === 'codex' && msg.cwd === caseRoot,
      );

      client.send(buildAgentMessagePayload({
        text: '先修复 /tmp/codex-carryover/src/index.js，并记住模型 gpt-5.4、配置项 model_provider，以及错误 invalid api key。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      const firstStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const firstThreadId = getActiveStoredRuntimeId(firstStoredSession, 'codex');
      assert(firstThreadId, 'Codex carryover baseline should persist the first thread id');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Codex Carryover Unified',
          templates: [{
            name: 'Codex Carryover Unified',
            apiKey: 'sk-codex-carryover',
            apiBase: 'https://codex-unified.example.test/v1',
            upstreamType: 'openai',
            defaultModel: 'gpt-5.4',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );
      await saveConfigAndWait(
        client,
        'save_codex_config',
        {
          mode: 'unified',
          sharedTemplate: 'Codex Carryover Unified',
          enableSearch: false,
        },
        'codex_config',
      );

      client.send(buildAgentMessagePayload({
        text: '切到统一 API 后继续处理 /tmp/codex-carryover/src/index.js，不要丢掉 invalid api key 原文。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }));
      await client.waitForType('system_message', (msg) => THREAD_RESET_WARNING_RE.test(msg.message || ''));
      await client.waitForType('system_message', (msg) => THREAD_CARRYOVER_NOTICE_RE.test(msg.message || ''));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);

      const unifiedStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const unifiedThreadId = getActiveStoredRuntimeId(unifiedStoredSession, 'codex');
      assert(unifiedThreadId && unifiedThreadId !== firstThreadId, 'Codex carryover switch to unified should create a new thread id');
      const unifiedAssistantText = getLastStoredAssistantText(sessionsDir, session.sessionId);
      assertCarryoverPromptInjected(unifiedAssistantText, [
        '/tmp/codex-carryover/src/index.js',
        'gpt-5.4',
        'model_provider',
        '切到统一 API 后继续处理 /tmp/codex-carryover/src/index.js',
      ]);
      const unifiedSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const unifiedSpawn = unifiedSpawnLines[unifiedSpawnLines.length - 1] || '';
      assert(unifiedSpawn.includes('"resume":false'), 'Codex carryover switch to unified should not resume the old thread');
      assert(!unifiedSpawn.includes('exec resume'), 'Codex carryover switch to unified should drop exec resume after config change');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Codex Carryover Unified',
          templates: [{
            name: 'Codex Carryover Unified',
            apiKey: 'sk-codex-carryover',
            apiBase: 'https://codex-unified.example.test/v1',
            upstreamType: 'openai',
            defaultModel: 'gpt-5.4-large',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );
      await saveConfigAndWait(
        client,
        'save_codex_config',
        {
          mode: 'unified',
          sharedTemplate: 'Codex Carryover Unified',
          enableSearch: false,
        },
        'codex_config',
      );

      const resumedCodexStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '在统一 API 下切到 gpt-5.4-large，继续保持 invalid api key 的上下文。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        resumedCodexStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Codex carryover unified model change should not emit new-thread carryover system messages',
      );

      const resumedCodexSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const resumedCodexThreadId = getActiveStoredRuntimeId(resumedCodexSession, 'codex');
      assert(
        resumedCodexThreadId && resumedCodexThreadId === unifiedThreadId,
        'Codex carryover unified model change should keep the same thread id',
      );
      const resumedCodexSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const resumedCodexSpawn = resumedCodexSpawnLines[resumedCodexSpawnLines.length - 1] || '';
      assert(resumedCodexSpawn.includes('"resume":true'), 'Codex carryover unified model change should resume the existing thread');
      assert(resumedCodexSpawn.includes('exec resume'), 'Codex carryover unified model change should include exec resume');

      await saveConfigAndWait(
        client,
        'save_codex_config',
        {
          mode: 'local',
          enableSearch: false,
        },
        'codex_config',
      );

      const restoredStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '现在切回本地配置，继续上一步，并保留 /tmp/codex-carryover/src/index.js 这个路径。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        restoredStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Codex carryover switch back to local should not emit new-thread carryover system messages',
      );

      const restoredStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const restoredThreadId = getActiveStoredRuntimeId(restoredStoredSession, 'codex');
      assert(
        restoredThreadId && restoredThreadId === firstThreadId,
        'Codex carryover switch back to local should restore the original local thread id',
      );
      const restoredAssistantText = getLastStoredAssistantText(sessionsDir, session.sessionId);
      assert(
        !/\[webcoding 自动上下文续接\]/.test(restoredAssistantText),
        'Codex carryover switch back to local should not inject carryover envelope when resuming old local channel',
      );
      const restoredSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const restoredSpawn = restoredSpawnLines[restoredSpawnLines.length - 1] || '';
      assert(restoredSpawn.includes('"resume":true'), 'Codex carryover switch back to local should resume the original local thread');
      assert(restoredSpawn.includes('exec resume'), 'Codex carryover switch back to local should include exec resume');
    });
  });
}

async function runCodexStickyUnifiedResumeRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'codex-sticky-unified');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  const port = await getFreePort();
  const password = 'Regression!234';
  const serverEnv = {
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client, messages }) => {
      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Codex Sticky Unified A',
          templates: [{
            name: 'Codex Sticky Unified A',
            apiKey: 'sk-codex-sticky-a',
            apiBase: 'https://codex-sticky-a.example.test/v1',
            upstreamType: 'openai',
            defaultModel: 'gpt-5.4',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );
      await saveConfigAndWait(
        client,
        'save_codex_config',
        {
          mode: 'unified',
          sharedTemplate: 'Codex Sticky Unified A',
          enableSearch: false,
        },
        'codex_config',
      );

      const session = await client.sendAndWaitType(
        { type: 'new_session', agent: 'codex', cwd: caseRoot, mode: 'yolo' },
        'session_info',
        (msg) => msg.agent === 'codex' && msg.cwd === caseRoot,
      );

      client.send(buildAgentMessagePayload({
        text: '先处理 /tmp/codex-sticky/src/index.js，并记住 unified sticky A。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      const firstStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const firstThreadId = getActiveStoredRuntimeId(firstStoredSession, 'codex');
      assert(firstThreadId, 'Codex sticky unified regression should persist the initial thread id');

      await saveConfigAndWait(
        client,
        'save_model_config',
        {
          mode: 'custom',
          activeTemplate: 'Codex Sticky Unified B',
          templates: [{
            name: 'Codex Sticky Unified B',
            apiKey: 'sk-codex-sticky-b',
            apiBase: 'https://codex-sticky-b.example.test/v1',
            upstreamType: 'openai',
            defaultModel: 'gpt-5.4-large',
            opusModel: 'claude-opus-4-6',
            sonnetModel: 'claude-sonnet-4-6',
            haikuModel: 'claude-haiku-4-5',
          }],
        },
        'model_config',
      );
      await saveConfigAndWait(
        client,
        'save_codex_config',
        {
          mode: 'unified',
          sharedTemplate: 'Codex Sticky Unified B',
          enableSearch: false,
        },
        'codex_config',
      );

      const stickyStartIndex = messages.length;
      client.send(buildAgentMessagePayload({
        text: '切到 unified sticky B 后继续处理 /tmp/codex-sticky/src/index.js，并延续 unified sticky A。',
        sessionId: session.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }));
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
      assertNoSystemMessageSince(
        messages,
        stickyStartIndex,
        THREAD_REBUILD_NOTICE_RE,
        'Codex sticky unified resume should not fall back to the carryover envelope after channel switch inside the managed runtime home',
      );

      const stickyStoredSession = readStoredSessionFile(sessionsDir, session.sessionId);
      const stickyThreadId = getActiveStoredRuntimeId(stickyStoredSession, 'codex');
      assert(
        stickyThreadId && stickyThreadId === firstThreadId,
        'Codex sticky unified resume should keep the original thread id after managed channel switch',
      );
      const stickyAssistantText = getLastStoredAssistantText(sessionsDir, session.sessionId);
      assert(
        !/\[webcoding 自动上下文续接\]/.test(stickyAssistantText),
        'Codex sticky unified resume should not inject the carryover envelope when reusing the original thread',
      );
      const spawnLines = findProcessLogLines(logsDir, session.sessionId, 'process_spawn');
      const latestSpawnLine = spawnLines[spawnLines.length - 1] || '';
      assert(latestSpawnLine.includes('"resume":true'), 'Codex sticky unified resume should keep resume enabled after channel switch');
      assert(latestSpawnLine.includes('exec resume'), 'Codex sticky unified resume should include exec resume after channel switch');
    });
  });
}

async function runCodexConfigMigrationRegressionCase({ port, password, sessionsDir, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await saveConfigAndWait(
      client,
      'save_model_config',
      {
        mode: 'custom',
        activeTemplate: 'Regression Unified API',
        templates: [{
          name: 'Regression Unified API',
          apiKey: 'sk-regression',
          apiBase: 'https://example.com/v1',
          upstreamType: 'openai',
          defaultModel: 'custom-regression-model',
          opusModel: 'claude-opus-4-6',
          sonnetModel: 'claude-sonnet-4-6',
          haikuModel: 'claude-haiku-4-5',
        }],
      },
      'model_config',
    );

    await saveConfigAndWait(
      client,
      'save_codex_config',
      {
        mode: 'unified',
        enableSearch: false,
      },
      'codex_config',
    );

    const legacyCwd = path.join(os.tmpdir(), 'webcoding-codex-legacy');
    mkdirp(legacyCwd);
    const legacySession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd: legacyCwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === legacyCwd,
    );

    const legacySessionPath = path.join(sessionsDir, `${legacySession.sessionId}.json`);
    const legacyJson = JSON.parse(fs.readFileSync(legacySessionPath, 'utf8'));
    legacyJson.codexThreadId = 'legacy-thread-id';
    legacyJson.codexRuntimeFingerprint = 'local';
    legacyJson.updated = new Date().toISOString();
    fs.writeFileSync(legacySessionPath, JSON.stringify(legacyJson, null, 2));

    client.send(buildAgentMessagePayload({
      text: 'verify codex config migration',
      sessionId: legacySession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));

    await client.waitForType('system_message', (msg) => THREAD_RESET_WARNING_RE.test(msg.message || ''));
    await client.waitForType('done', (msg) => msg.sessionId === legacySession.sessionId);

    const spawnLine = findProcessLogLine(logsDir, legacySession.sessionId, 'process_spawn');
    assert(spawnLine && spawnLine.includes('"resume":false'), 'Legacy Codex session should not resume after config migration');
    assert(!spawnLine.includes('exec resume'), 'Legacy Codex session should start a new thread after config migration');

    const migratedJson = JSON.parse(fs.readFileSync(legacySessionPath, 'utf8'));
    assert(migratedJson.codexThreadId && migratedJson.codexThreadId !== 'legacy-thread-id', 'Codex session should persist a new thread id after migration');
    assert(migratedJson.codexRuntimeFingerprint && migratedJson.codexRuntimeFingerprint !== 'local', 'Codex session should persist the current runtime fingerprint after migration');
  });
}

async function runCodexReasoningEffortRegressionCase({ port, password, tempRoot, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    const modelConfigMsg = await saveConfigAndWait(
      client,
      'save_model_config',
      {
        mode: 'custom',
        activeTemplate: 'Reasoning Regression API',
        templates: [{
          name: 'Reasoning Regression API',
          apiKey: 'sk-regression',
          apiBase: 'https://example.com/v1',
          upstreamType: 'openai',
          defaultModel: 'gpt-5.4',
          modelReasoningEffort: 'high',
          opusModel: 'claude-opus-4-6',
          sonnetModel: 'claude-sonnet-4-6',
          haikuModel: 'claude-haiku-4-5',
        }],
      },
      'model_config',
    );
    assert(!Object.prototype.hasOwnProperty.call(modelConfigMsg.config.templates[0] || {}, 'modelReasoningEffort'), 'Unified API model_reasoning_effort should be ignored when saving config');

    await saveConfigAndWait(
      client,
      'save_codex_config',
      {
        mode: 'unified',
        enableSearch: false,
      },
      'codex_config',
    );

    const cwd = path.join(tempRoot, 'codex-reasoning-effort');
    mkdirp(cwd);
    const session = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === cwd,
    );

    client.send(buildAgentMessagePayload({
      text: 'verify codex unified config',
      sessionId: session.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);

    const spawnLine = findProcessLogLine(logsDir, session.sessionId, 'process_spawn');
    const spawnArgs = spawnLine ? (JSON.parse(spawnLine).args || '') : '';
    assert(!spawnArgs.includes('model_reasoning_effort='), 'Codex spawn should ignore legacy model_reasoning_effort config');
  });
}

async function runCodexBridgeProtocolNormalizationRegressionCase({ port, password, configDir, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    const modelConfigMsg = await saveConfigAndWait(
      client,
      'save_model_config',
      {
        mode: 'custom',
        activeTemplate: 'Codex Bridge Mislabel',
        templates: [{
          name: 'Codex Bridge Mislabel',
          apiKey: 'sk-codex-bridge-mislabel',
          apiBase: 'https://bridge-mislabel.example.test',
          upstreamType: 'anthropic',
          defaultModel: 'gpt-5.4-large',
          opusModel: 'gpt-5.4-large',
          sonnetModel: 'gpt-5.4-large',
          haikuModel: 'gpt-5.4-mini',
        }],
      },
      'model_config',
    );
    const correctedTemplate = (modelConfigMsg.config.templates || []).find((item) => item.name === 'Codex Bridge Mislabel');
    assert(correctedTemplate && correctedTemplate.upstreamType === 'openai', 'OpenAI-compatible provider should be normalized back to openai protocol');

    await saveConfigAndWait(
      client,
      'save_codex_config',
      {
        mode: 'unified',
        sharedTemplate: 'Codex Bridge Mislabel',
        enableSearch: false,
      },
      'codex_config',
    );

    const session = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'verify codex bridge normalization', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'verify codex bridge normalization',
    );
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);

    const spawnLine = findProcessLogLine(logsDir, session.sessionId, 'process_spawn');
    const spawnArgs = spawnLine ? (JSON.parse(spawnLine).args || '') : '';
    assert(/-c model_providers\.openai_compat\.base_url="http:\/\/127\.0\.0\.1:\d+\/openai"/.test(spawnArgs), 'Codex mislabel normalization should still route through the bridge openai endpoint');

    const runtimeToml = fs.readFileSync(path.join(configDir, 'codex-runtime-home', 'config.toml'), 'utf8');
    assert(/base_url = "http:\/\/127\.0\.0\.1:\d+\/openai"/.test(runtimeToml), 'Codex mislabel normalization should write the bridge openai base_url');

    const bridgeRuntime = JSON.parse(fs.readFileSync(path.join(configDir, 'bridge-runtime.json'), 'utf8'));
    const bridgeEntry = bridgeRuntime?.runtimes
      ? Object.values(bridgeRuntime.runtimes).find((entry) => entry?.upstream?.name === 'Codex Bridge Mislabel')
      : null;
    assert(bridgeEntry && bridgeEntry.upstream?.kind === 'openai', 'Bridge runtime store should persist the corrected openai protocol');
  });
}

async function runCodexMetadataWarningRegressionCase({ port, password }) {
  await withAuthedClient(port, password, async ({ client, messages }) => {
    const warningCwd = path.join(os.tmpdir(), 'webcoding-codex-warning');
    mkdirp(warningCwd);
    const session = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd: warningCwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === warningCwd,
    );

    client.send(buildAgentMessagePayload({
      text: 'trigger codex metadata warning',
      sessionId: session.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));

    const warningMsg = await client.waitForType('system_message', (msg) => /缺少内置元数据/.test(msg.message || ''));
    assert(/缺少内置元数据/.test(warningMsg.message || ''), 'Codex metadata warning should be surfaced as a system message');
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId);
    assert(!messages.some((msg) => msg.type === 'tool_end' && msg.toolUseId === 'item_warn'), 'Codex metadata warning should not render as a tool call');
  });
}

async function runHappyPathRegressionCase({ port, password, tempRoot, configDir, sessionsDir, logsDir, homeDir, codexFixture, tinyPng }) {
  await withAuthedClient(port, password, async ({ client, token }) => {
    const modelConfigMsg = await saveConfigAndWait(
      client,
      'save_model_config',
      {
        mode: 'custom',
        activeTemplate: 'Regression Unified API',
        templates: [{
          name: 'Regression Unified API',
          apiKey: 'sk-regression',
          apiBase: 'https://example.com/v1',
          upstreamType: 'openai',
          defaultModel: 'custom-regression-model',
          opusModel: 'claude-opus-4-6',
          sonnetModel: 'claude-sonnet-4-6',
          haikuModel: 'claude-haiku-4-5',
        }],
      },
      'model_config',
    );
    assert(modelConfigMsg.config.mode === 'custom', 'Unified API config mode save/load failed');
    assert(modelConfigMsg.config.activeTemplate === 'Regression Unified API', 'Unified API active template save/load failed');
    assert(Array.isArray(modelConfigMsg.config.templates) && modelConfigMsg.config.templates[0]?.apiKey.includes('****'), 'Unified API key should be masked');

    const codexConfigMsg = await saveConfigAndWait(
      client,
      'save_codex_config',
      {
        mode: 'unified',
        enableSearch: true,
      },
      'codex_config',
    );
    assert(codexConfigMsg.config.mode === 'unified', 'Codex unified mode save/load failed');
    assert(codexConfigMsg.config.supportsSearch === false, 'Codex config should expose unsupported search capability');
    assert(codexConfigMsg.config.enableSearch === false, 'Codex config should ignore unsupported search toggle');

    const codexSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd: '/tmp/codex-space', mode: 'plan' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === '/tmp/codex-space',
    );
    assert(codexSession.mode === 'plan', 'Codex new_session should follow requested mode');
    assert(codexSession.model === null, 'Codex new_session should not inject a default model');

    const codexModelList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }),
      'model_list',
      (msg) => msg.agent === 'codex',
    );
    assert(Array.isArray(codexModelList.entries) && codexModelList.entries.some((entry) => entry.value === 'custom-regression-model'), 'Codex /model should return real model entries from Codex cache');
    const codexModelChanged = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model custom-regression-model', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }),
      'model_changed',
      (msg) => msg.model === 'custom-regression-model',
    );
    assert(codexModelChanged.model === 'custom-regression-model', 'Codex /model should accept real Codex model names from fetched list');

    const codexAttachment = await uploadAttachment(port, token, {
      filename: 'codex-test.png',
      mime: 'image/png',
      data: tinyPng,
    });
    const firstMessageSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'first codex prompt', attachments: [codexAttachment], mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'first codex prompt',
    );
    assert(firstMessageSession.agent === 'codex', 'First-message path created wrong agent');
    const runningSessionList = await client.waitForType(
      'session_list',
      (msg) => msg.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning),
    );
    assert(runningSessionList.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning), 'Running Codex session should be marked as isRunning');
    await client.waitForType('done', (msg) => msg.sessionId === firstMessageSession.sessionId);
    const spawnLine = findProcessLogLine(logsDir, firstMessageSession.sessionId, 'process_spawn');
    const spawnArgs = spawnLine ? (JSON.parse(spawnLine).args || '') : '';
    assert(spawnLine && !spawnLine.includes('--search') && spawnLine.includes('--image'), 'Codex exec should attach images and not append unsupported --search flag');
    const runtimeToml = fs.readFileSync(path.join(configDir, 'codex-runtime-home', 'config.toml'), 'utf8');
    assert(runtimeToml.includes('preferred_auth_method = "apikey"'), 'Codex unified runtime should write isolated runtime auth mode');
    assert(runtimeToml.includes('name = "Regression Unified API"'), 'Codex unified runtime should point at the active unified API template');
    assert(/base_url = "http:\/\/127\.0\.0\.1:\d+\/openai"/.test(runtimeToml), 'Codex unified runtime should route through the local bridge base_url');
    assert(/# bridge_api_key = "/.test(runtimeToml), 'Codex unified runtime should expose local bridge token in generated config comments');
    assert(spawnArgs.includes('-c model_provider="openai_compat"'), 'Codex spawn should force openai_compat provider via CLI overrides');
    assert(/-c model_providers\.openai_compat\.base_url="http:\/\/127\.0\.0\.1:\d+\/openai"/.test(spawnArgs), 'Codex spawn should force bridge base_url via CLI overrides');

    client.send(buildAgentMessagePayload({ text: '/compact', sessionId: firstMessageSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await client.waitForType('system_message', (msg) => /正在执行 Codex \/compact/.test(msg.message || ''));
    await client.waitForType('done', (msg) => msg.sessionId === firstMessageSession.sessionId);
    const compactDoneMsg = await client.waitForType('system_message', (msg) => /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(compactDoneMsg.message || ''), 'Codex /compact should complete with Codex-specific status message');

    const autoCompactCwd = path.join(tempRoot, 'codex-auto-compact');
    mkdirp(autoCompactCwd);
    const autoCompactSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', cwd: autoCompactCwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.cwd === autoCompactCwd,
    );
    client.send(buildAgentMessagePayload({ text: 'warm up auto compact', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await client.waitForType('done', (msg) => msg.sessionId === autoCompactSession.sessionId);
    client.send(buildAgentMessagePayload({ text: 'trigger codex context limit', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    const autoCompactStart = await client.waitForType('system_message', (msg) => /正在按 Codex \/compact 自动压缩/.test(msg.message || ''));
    assert(/Codex \/compact/.test(autoCompactStart.message || ''), 'Codex auto /compact should announce auto compact start');
    const autoCompactDone = await client.waitForType('system_message', (msg) => /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(autoCompactDone.message || ''), 'Codex auto /compact should finish compact step');
    const autoCompactResume = await client.waitForType('system_message', (msg) => /按 Codex 压缩计划继续执行/.test(msg.message || ''));
    assert(/继续执行/.test(autoCompactResume.message || ''), 'Codex auto /compact should announce retry');
    const autoCompactRetryText = await client.waitForType('text_delta', (msg) => /trigger codex context limit/.test(msg.text || ''), 8000);
    assert(/trigger codex context limit/.test(autoCompactRetryText.text || ''), 'Codex auto /compact should replay the failed prompt after compact');

    const claudeOneMCwd = path.join(tempRoot, 'claude-1m-space');
    mkdirp(claudeOneMCwd);
    const claudeModelSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'claude', cwd: claudeOneMCwd, mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'claude' && msg.cwd === claudeOneMCwd,
    );
    const claudeModelList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model', sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }),
      'model_list',
      (msg) => msg.agent === 'claude' && msg.current === 'default',
    );
    assert(Array.isArray(claudeModelList.entries) && claudeModelList.entries.some((entry) => entry.alias === 'sonnet[1m]'), 'Claude /model should expose Sonnet 1M option');
    assert(claudeModelList.entries.some((entry) => entry.alias === 'opus[1m]'), 'Claude /model should expose Opus 1M option');
    const claudeModelChanged = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model sonnet[1m]', sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }),
      'model_changed',
      (msg) => msg.model === 'sonnet[1m]',
    );
    assert(claudeModelChanged.model === 'sonnet[1m]', 'Claude /model should accept Sonnet 1M alias');
    client.send(buildAgentMessagePayload({ text: 'use sonnet 1m', sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }));
    await client.waitForType('done', (msg) => msg.sessionId === claudeModelSession.sessionId);
    const claudeOneMSpawnLine = findProcessLogLine(logsDir, claudeModelSession.sessionId, 'process_spawn');
    assert(claudeOneMSpawnLine && claudeOneMSpawnLine.includes('claude-sonnet-4-6[1m]'), 'Claude /model Sonnet 1M should pass the real 1M model value to CLI');
    const storedClaudeOneMSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeModelSession.sessionId}.json`), 'utf8'));
    assert(storedClaudeOneMSession.model === 'claude-sonnet-4-6[1m]', 'Claude /model should persist the real 1M model value');

    const claudeAttachment = await uploadAttachment(port, token, {
      filename: 'claude-test.png',
      mime: 'image/png',
      data: tinyPng,
    });
    const claudeImageSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'describe attachment', attachments: [claudeAttachment], mode: 'yolo', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'describe attachment',
    );
    await client.waitForType('done', (msg) => msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawnLine = findProcessLogLine(logsDir, claudeImageSession.sessionId, 'process_spawn');
    assert(claudeSpawnLine && claudeSpawnLine.includes('--input-format stream-json'), 'Claude image message should switch stdin to stream-json');
    const storedClaudeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedClaudeSession.messages?.[0]?.attachments) && storedClaudeSession.messages[0].attachments.length === 1, 'Claude message should persist attachment metadata');
    const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
    const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert(claudeSettings.env?.ANTHROPIC_API_KEY, 'Claude unified runtime should write ANTHROPIC_API_KEY');
    assert(!claudeSettings.env?.ANTHROPIC_AUTH_TOKEN, 'Claude unified runtime should not write ANTHROPIC_AUTH_TOKEN');

    const nativeSessions = await client.sendAndWaitType(
      { type: 'list_native_sessions' },
      'native_sessions',
    );
    assert(nativeSessions.groups?.length > 0, 'Claude native session listing failed');
    const firstClaude = nativeSessions.groups[0].sessions[0];
    const importedClaude = await client.sendAndWaitType(
      { type: 'import_native_session', sessionId: firstClaude.sessionId, projectDir: nativeSessions.groups[0].dir },
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'Claude import prompt',
    );
    assert(importedClaude.messages?.[0]?.content === 'Claude import prompt', 'Claude import parsed wrong first message');

    const codexSessions = await client.sendAndWaitType(
      { type: 'list_codex_sessions' },
      'codex_sessions',
    );
    const importedCodexItem = codexSessions.groups.flatMap((g) => g.sessions).find((item) => item.threadId === codexFixture.threadId);
    assert(importedCodexItem, 'Codex session listing failed');

    const importedCodex = await client.sendAndWaitType(
      { type: 'import_codex_session', threadId: importedCodexItem.threadId, rolloutPath: importedCodexItem.rolloutPath },
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'Codex import prompt',
    );
    assert(importedCodex.messages?.[0]?.content === 'Codex import prompt', 'Codex import kept wrapper instructions');
    assert(importedCodex.totalUsage?.inputTokens === 20, 'Codex import usage parse failed');

    const importedSessionId = importedCodex.sessionId;
    client.send({ type: 'delete_session', sessionId: importedSessionId });
    await client.waitForType(
      'session_list',
      (msg) => !msg.sessions.some((s) => s.id === importedSessionId),
    );

    const importedSessionPath = path.join(sessionsDir, `${importedSessionId}.json`);
    await waitForCondition(() => !fs.existsSync(importedSessionPath), { label: 'Codex session JSON deletion' });
    await waitForCondition(() => !fs.existsSync(codexFixture.rolloutPath), { label: 'Codex rollout deletion' });
    await waitForCondition(
      () => sql(codexFixture.stateDb, `select count(*) from threads where id=${sqlQuote(codexFixture.threadId)}`) === '0',
      { label: 'Codex thread row deletion' },
    );
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webcoding-regression-'));
  try {
    const configDir = path.join(tempRoot, 'config');
    const sessionsDir = path.join(tempRoot, 'sessions');
    const logsDir = path.join(tempRoot, 'logs');
    const homeDir = path.join(tempRoot, 'home');
    mkdirp(configDir);
    mkdirp(sessionsDir);
    mkdirp(logsDir);
    mkdirp(homeDir);

    fs.writeFileSync(path.join(configDir, 'notify.json'), JSON.stringify({
      provider: 'off',
      pushplus: { token: '' },
      telegram: { botToken: '', chatId: '' },
      serverchan: { sendKey: '' },
      feishu: { webhook: '' },
      qqbot: { qmsgKey: '' },
    }, null, 2));

    createFakeClaudeHistory(homeDir);
    const codexFixture = createFakeCodexHistory(homeDir);
    const expiredAttachmentFixture = createExpiredAttachmentFixture(sessionsDir);

    const port = await getFreePort();
    const password = 'Regression!234';
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082',
      'hex',
    );

    const serverEnv = {
      PORT: String(port),
      CC_WEB_PASSWORD: password,
      CC_WEB_CONFIG_DIR: configDir,
      CC_WEB_SESSIONS_DIR: sessionsDir,
      CC_WEB_LOGS_DIR: logsDir,
      HOME: homeDir,
      CLAUDE_PATH: MOCK_CLAUDE,
      CODEX_PATH: MOCK_CODEX,
    };

    await withServer(serverEnv, async (serverHandle) => {
      const ctx = {
        port,
        password,
        tempRoot,
        configDir,
        sessionsDir,
        logsDir,
        homeDir,
        codexFixture,
        expiredAttachmentFixture,
        tinyPng,
        serverEnv,
        serverHandle,
      };
      const runner = createTestRunner();
      await runner.run('fetch_models apiBase version compatibility', () => runFetchModelsApiBaseCompatibilityRegressionCase(ctx));
      await runner.run('bridge ignores legacy reasoning effort config', () => runBridgeReasoningEffortRegressionCase(ctx));
      await runner.run('bridge responses fallback', () => runBridgeResponsesFallbackRegressionCase(ctx));
      await runner.run('bridge responses 404 fallback', () => runBridgeResponses404FallbackRegressionCase(ctx));
      await runner.run('bridge streaming passthrough', () => runBridgeStreamingPassthroughRegressionCase(ctx));
      await runner.run('bridge upstream apiBase version compatibility', () => runBridgeUpstreamApiBaseCompatibilityRegressionCase(ctx));
      await runner.run('bridge stale process refresh', () => runBridgeScriptRefreshRegressionCase(ctx));
      await runner.run('claude local model map from settings', () => runClaudeLocalModelMapRegressionCase(ctx));
      await runner.run('claude settings local restore after unified api', () => runClaudeSettingsRestoreRegressionCase(ctx));
      await runner.run('claude config switch carryover', () => runClaudeConfigCarryoverRegressionCase(ctx));
      await runner.run('claude sticky resume across channel switch', () => runClaudeStickyResumeRegressionCase(ctx));
      await runner.run('codex local config fingerprint refresh', () => runCodexLocalConfigFingerprintRegressionCase(ctx));
      await runner.run('codex config switch carryover', () => runCodexConfigCarryoverRegressionCase(ctx));
      await runner.run('codex sticky resume inside managed runtime home', () => runCodexStickyUnifiedResumeRegressionCase(ctx));
      await runner.run('codex config migration', () => runCodexConfigMigrationRegressionCase(ctx));
      await runner.run('codex ignores legacy reasoning effort config', () => runCodexReasoningEffortRegressionCase(ctx));
      await runner.run('codex bridge protocol normalization', () => runCodexBridgeProtocolNormalizationRegressionCase(ctx));
      await runner.run('codex metadata warning rendering', () => runCodexMetadataWarningRegressionCase(ctx));
      await runner.run('auth failures and repeated auth', () => runAuthRegressionCase(ctx));
      await runner.run('runtime error mapping', () => runRuntimeErrorRegressionCase(ctx));
      await runner.run('attachment boundary handling', () => runAttachmentBoundaryRegressionCase(ctx));
      await runner.run('expired attachment cleanup', () => runExpiredAttachmentCleanupRegressionCase(ctx));
      await runner.run('websocket guard rails', () => runWebSocketGuardRegressionCase(ctx));
      await runner.run('concurrent sessions and multi-client attachment', () => runConcurrentSessionsRegressionCase(ctx));
      await runner.run('websocket reconnect resume', () => runReconnectResumeRegressionCase(ctx));
      await runner.run('happy path regression flow', () => runHappyPathRegressionCase(ctx));
      await runner.run('server restart recovery', () => runServerRestartRecoveryRegressionCase(ctx));
      await runner.run('notification failure handling', () => runNotificationFailureRegressionCase(ctx));
      await runner.run('auth lock window', () => runAuthLockRegressionCase(ctx));
      runner.finish();
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
