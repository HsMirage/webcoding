#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { createAgentRuntime } = require('../lib/agent-runtime');
const { PiRpcClient } = require('../lib/pi-rpc-client');
const { CodexAppServerClient } = require('../lib/codex-app-server-client');
const { ClaudeStreamClient } = require('../lib/claude-stream-client');

const REPO_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_DIR, 'server.js');
const BRIDGE_PATH = path.join(REPO_DIR, 'lib', 'local-api-bridge.js');
const MOCK_CLAUDE = path.join(REPO_DIR, 'scripts', 'mock-claude.js');
const MOCK_CODEX = path.join(REPO_DIR, 'scripts', 'mock-codex.js');
const MOCK_PI = path.join(REPO_DIR, 'scripts', 'mock-pi.js');
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function cleanupRegressionBridgeProcesses(tempRoot) {
  const statePaths = [];
  const pendingDirs = [tempRoot];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    let entries = [];
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) pendingDirs.push(entryPath);
      else if (entry.isFile() && entry.name === 'bridge-state.json') statePaths.push(entryPath);
    }
  }

  const pids = new Set();
  for (const statePath of statePaths) {
    try {
      const pid = Number.parseInt(JSON.parse(fs.readFileSync(statePath, 'utf8'))?.pid, 10);
      if (isPidAlive(pid)) pids.add(pid);
    } catch {}
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 1500;
  while ([...pids].some(isPidAlive) && Date.now() < deadline) await sleep(30);
  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
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

function buildAgentMessagePayload({ text, sessionId, mode, agent, attachments, clientMessageId, streamingBehavior }) {
  return {
    type: 'message',
    text,
    sessionId,
    mode,
    agent,
    ...(attachments ? { attachments } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
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

function createRuntimeEnvFixture(processEnv, options = {}) {
  const noop = () => {};
  return createAgentRuntime({
    processEnv,
    CLAUDE_PATH: '/mock/claude',
    CODEX_PATH: '/mock/codex',
    PI_PATH: '/mock/pi',
    SESSIONS_DIR: path.join(processEnv.HOME, 'sessions'),
    MODEL_MAP: {},
    loadModelConfig: () => options.modelConfig || { mode: 'local', activeTemplate: '', templates: [] },
    applyCustomTemplateToSettings: noop,
    getClaudeRuntimeFingerprint: () => 'claude-runtime-fixture',
    loadCodexConfig: () => ({ mode: options.codexRuntimeConfig?.mode === 'custom' ? 'unified' : 'local' }),
    prepareCodexCustomRuntime: () => options.codexRuntimeConfig || { mode: 'local' },
    getCodexRuntimeFingerprint: () => 'codex-runtime-fixture',
    loadPiConfig: () => ({ mode: 'local' }),
    preparePiCustomRuntime: () => ({ mode: 'local' }),
    getPiRuntimeFingerprint: () => 'pi-runtime-fixture',
    wsSend: noop,
    truncateObj: (value) => value,
    sanitizeToolInput: (_name, value) => value,
    loadSession: options.loadSession || (() => null),
    saveSession: options.saveSession || noop,
    getRuntimeSessionState: () => null,
    getFallbackRuntimeSessionState: () => null,
    setRuntimeSessionState: noop,
    setRuntimeSessionId: noop,
    getRuntimeSessionId: () => null,
    runtimeFingerprintsCompatible: (agent, left, right) => left === right,
    onSlashCommandsDiscovered: noop,
  });
}

async function runClaudeCostLedgerRegressionCase({ tempRoot }) {
  let storedSession = {
    id: 'claude-cost-session',
    totalCost: 0,
  };
  const runtime = createRuntimeEnvFixture({
    PATH: process.env.PATH || '/usr/bin',
    HOME: path.join(tempRoot, 'claude-cost-home'),
  }, {
    loadSession: (sessionId) => (sessionId === storedSession.id ? storedSession : null),
    saveSession: (session) => { storedSession = JSON.parse(JSON.stringify(session)); },
  });

  const applyResult = (runId, totalCostUsd) => {
    const entry = { runId, fullText: '', toolCalls: [], outputSegments: [] };
    runtime.processClaudeEvent(entry, {
      type: 'result',
      total_cost_usd: totalCostUsd,
    }, storedSession.id);
  };

  applyResult('run-a', 1.25);
  applyResult('run-a', 1.25);
  assert(storedSession.totalCost === 1.25, 'Replaying one Claude run must not double-count its cost');

  applyResult('run-a', 1.5);
  assert(storedSession.totalCost === 1.5, 'A later cumulative cost for one Claude run should add only the delta');

  applyResult('run-b', 0.5);
  assert(storedSession.totalCost === 2, 'A distinct Claude run should add its own cost');
  assert(storedSession.runtimeCostLedger?.['run-a'] === 1.5, 'Claude cost ledger should persist the latest run total');
  assert(storedSession.runtimeCostLedger?.['run-b'] === 0.5, 'Claude cost ledger should track separate runs');
}

async function runClaudeSlashProbeEnvironmentRegressionCase({ port, password, claudeEnvCapturePath }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await client.sendAndWaitType(
      { type: 'get_slash_commands', agent: 'claude' },
      'slash_commands_list',
      (msg) => msg.agent === 'claude' && msg.commands?.some((command) => command.cmd === '/compact'),
    );
    const discoveredList = await client.waitForType(
      'slash_commands_list',
      (msg) => msg.agent === 'claude' && msg.commands?.some((command) => command.cmd === '/review'),
      5000,
    );
    assert(discoveredList.commands.some((command) => command.cmd === '/review'), 'Claude slash discovery should return init metadata without a user prompt');
  });

  await waitForCondition(() => fs.existsSync(claudeEnvCapturePath), {
    timeoutMs: 3000,
    label: 'Claude slash discovery environment capture',
  });
  const captures = fs.readFileSync(claudeEnvCapturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const probe = captures.find((capture) => capture.args?.includes('--no-session-persistence'));
  assert(probe, 'Claude slash discovery should use an ephemeral no-persistence process');
  assert(!probe.args.includes('say hi'), 'Claude slash discovery must not send a hidden user prompt');
  assert(probe.hasWebPassword === false, 'Claude slash discovery must not inherit CC_WEB_PASSWORD');
  assert(probe.hasClaudeNestingMarker === false, 'Claude slash discovery must not inherit Claude nesting markers');
}

async function runAgentRuntimeEnvironmentRegressionCase({ tempRoot }) {
  const fixtureHome = path.join(tempRoot, 'runtime-env-home');
  const processEnv = {
    PATH: process.env.PATH || '/usr/bin',
    HOME: fixtureHome,
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/tmp/webcoding-regression-ssh.sock',
    CC_WEB_PASSWORD: 'must-not-reach-agent',
    CLAUDECODE: 'must-not-reach-agent',
    CLAUDE_CONFIG_DIR: path.join(fixtureHome, 'custom-claude'),
    ANTHROPIC_API_KEY: 'claude-local-key',
    ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
    AWS_PROFILE: 'claude-bedrock-profile',
    CODEX_HOME: path.join(fixtureHome, 'custom-codex'),
    OPENAI_API_KEY: 'codex-local-key',
    OPENAI_BASE_URL: 'https://openai.example.test',
    CUSTOM_PROVIDER_TOKEN: 'explicit-provider-key',
    UNRELATED_SECRET: 'must-not-reach-agent',
    CC_WEB_CLI_ENV_PASSTHROUGH: 'CUSTOM_PROVIDER_TOKEN, CC_WEB_PASSWORD',
  };
  const session = { id: 'runtime-env-session', cwd: fixtureHome, permissionMode: 'yolo' };
  const runtime = createRuntimeEnvFixture(processEnv);

  const claudeEnv = runtime.buildClaudeSpawnSpec(session).env;
  assert(claudeEnv.CLAUDE_CONFIG_DIR === processEnv.CLAUDE_CONFIG_DIR, 'Claude should inherit CLAUDE_CONFIG_DIR');
  assert(claudeEnv.ANTHROPIC_API_KEY === 'claude-local-key', 'Claude should inherit local ANTHROPIC_API_KEY');
  assert(claudeEnv.AWS_PROFILE === 'claude-bedrock-profile', 'Claude should inherit AWS provider configuration');
  assert(claudeEnv.SSH_AUTH_SOCK === processEnv.SSH_AUTH_SOCK, 'Claude should inherit SSH agent access');
  assert(claudeEnv.CUSTOM_PROVIDER_TOKEN === 'explicit-provider-key', 'Claude should inherit explicitly allowed provider env');
  assert(!claudeEnv.OPENAI_API_KEY, 'Claude should not inherit Codex credentials by default');
  assert(!claudeEnv.CC_WEB_PASSWORD && !claudeEnv.CLAUDECODE, 'Claude must not inherit Web server credentials or nesting markers');
  assert(!claudeEnv.UNRELATED_SECRET, 'Claude should not inherit unrelated secrets');
  const claudeSpec = runtime.buildClaudeSpawnSpec(session);
  assert(claudeSpec.args.includes('--input-format') && claudeSpec.args.includes('stream-json'), 'Claude text turns should always use structured stream-json input');
  assert(claudeSpec.args.includes('--include-partial-messages') && claudeSpec.args.includes('--include-hook-events'), 'Claude stream transport should request partial messages and hook events');
  const claudeEffortSpec = runtime.buildClaudeSpawnSpec({ ...session, effort: 'high' });
  assert(claudeEffortSpec.args.includes('--effort') && claudeEffortSpec.args.includes('high'), 'Claude effort should use the native --effort flag');

  const codexEnv = runtime.buildCodexSpawnSpec(session).env;
  assert(codexEnv.CODEX_HOME === processEnv.CODEX_HOME, 'Codex should inherit CODEX_HOME');
  assert(codexEnv.OPENAI_API_KEY === 'codex-local-key', 'Codex should inherit local OPENAI_API_KEY');
  assert(codexEnv.OPENAI_BASE_URL === processEnv.OPENAI_BASE_URL, 'Codex should inherit local OPENAI_BASE_URL');
  assert(codexEnv.SSH_AUTH_SOCK === processEnv.SSH_AUTH_SOCK, 'Codex should inherit SSH agent access');
  assert(codexEnv.CUSTOM_PROVIDER_TOKEN === 'explicit-provider-key', 'Codex should inherit explicitly allowed provider env');
  assert(!codexEnv.ANTHROPIC_API_KEY, 'Codex should not inherit Claude credentials by default');
  assert(!codexEnv.CC_WEB_PASSWORD && !codexEnv.UNRELATED_SECRET, 'Codex must not inherit Web or unrelated secrets');
  const codexAppSpec = runtime.buildCodexSpawnSpec(session, { transport: 'app-server' });
  assert(codexAppSpec.args[0] === 'app-server', 'Codex rich-client transport should launch app-server');
  assert(codexAppSpec.transport === 'app-server' && codexAppSpec.parser === 'codex-app-server', 'Codex App Server spawn metadata should identify the bidirectional transport');
  assert(codexAppSpec.approvalPolicy === 'never' && codexAppSpec.threadSandbox === 'danger-full-access', 'Codex YOLO mode should map to native App Server permissions');
  const codexEffortSpec = runtime.buildCodexSpawnSpec({ ...session, effort: 'xhigh' }, { transport: 'app-server' });
  assert(codexEffortSpec.effort === 'xhigh', 'Codex App Server spawn metadata should preserve reasoning effort');

  const piEnv = runtime.buildPiSpawnSpec(session).env;
  assert(piEnv.ANTHROPIC_API_KEY === 'claude-local-key', 'Pi should keep supported provider credentials');
  assert(piEnv.OPENAI_API_KEY === 'codex-local-key', 'Pi should keep supported OpenAI credentials');
  assert(piEnv.CUSTOM_PROVIDER_TOKEN === 'explicit-provider-key', 'Pi should inherit explicitly allowed provider env');
  assert(!piEnv.CC_WEB_PASSWORD && !piEnv.UNRELATED_SECRET, 'Pi must not inherit Web or unrelated secrets');
  const piRpcSpec = runtime.buildPiSpawnSpec(session, { transport: 'rpc' });
  assert(piRpcSpec.args.includes('rpc') && !piRpcSpec.args.includes('-p'), 'Pi RPC transport should keep stdin open without print mode');
  assert(piRpcSpec.transport === 'rpc' && piRpcSpec.parser === 'pi-rpc', 'Pi RPC spawn metadata should identify the persistent transport');
  const piThinkingSpec = runtime.buildPiSpawnSpec({ ...session, thinking: 'xhigh' }, { transport: 'rpc' });
  assert(piThinkingSpec.args.includes('--thinking') && piThinkingSpec.args.includes('xhigh'), 'Pi thinking level should use the native --thinking flag');
  const piHeadlessSpec = runtime.buildPiSpawnSpec(session, { transport: 'headless' });
  assert(piHeadlessSpec.args.includes('json') && piHeadlessSpec.args.includes('-p'), 'Pi headless fallback should remain available');

  const managedRuntime = createRuntimeEnvFixture(processEnv, {
    codexRuntimeConfig: {
      mode: 'custom',
      homeDir: path.join(fixtureHome, 'managed-codex'),
      apiKey: 'managed-codex-key',
      apiBase: 'http://127.0.0.1:9999/openai',
      profileName: 'Managed fixture',
      defaultModel: 'managed-model',
    },
  });
  const managedCodexEnv = managedRuntime.buildCodexSpawnSpec(session).env;
  assert(managedCodexEnv.CODEX_HOME.endsWith('managed-codex'), 'Managed Codex should use its isolated CODEX_HOME');
  assert(managedCodexEnv.OPENAI_API_KEY === 'managed-codex-key', 'Managed Codex credentials should override local credentials');
  assert(!managedCodexEnv.OPENAI_BASE_URL, 'Managed Codex should not inherit a conflicting OPENAI_BASE_URL');
}

async function runPiRpcClientLifecycleRegressionCase({ tempRoot }) {
  const sessionDir = path.join(tempRoot, 'pi-rpc-client-lifecycle');
  mkdirp(sessionDir);
  let exitInfo = null;
  const client = new PiRpcClient({
    command: process.execPath,
    args: [MOCK_PI, '--mode', 'rpc', '--session-dir', sessionDir, '--session-id', 'lifecycle-test'],
    env: {
      ...process.env,
      MOCK_PI_RPC_GET_STATE_DELAY_MS: '2000',
    },
    cwd: REPO_DIR,
    startupTimeoutMs: 60,
    onExit: (info) => { exitInfo = info; },
  });

  let startupError = null;
  try {
    await client.start();
  } catch (error) {
    startupError = error;
  }
  assert(/timed out/i.test(startupError?.message || ''), 'Pi RPC handshake timeout should reject startup');
  await waitForCondition(() => client.closed, {
    timeoutMs: 3500,
    label: 'Pi RPC child exit after failed handshake',
  });
  assert(exitInfo?.expected === true, 'Pi RPC failed startup should dispose the child as an expected exit');
  assert(client.isAlive === false, 'Pi RPC failed startup must not leave a live child process');
}

async function runCodexAppServerClientLifecycleRegressionCase() {
  let approvalMethod = null;
  let completed = false;
  let exitInfo = null;
  const client = await CodexAppServerClient.start({
    command: process.execPath,
    args: [MOCK_CODEX, 'app-server', '--listen', 'stdio://'],
    env: process.env,
    cwd: REPO_DIR,
    onRequest: (method) => {
      approvalMethod = method;
      return { decision: 'accept' };
    },
    onNotification: (method) => {
      if (method === 'turn/completed') completed = true;
    },
    onExit: (info) => { exitInfo = info; },
  });
  const models = await client.request('model/list', { limit: 20 });
  assert(models.data?.some((model) => model.id === 'mock-codex-model'), 'Codex App Server client should correlate JSON-RPC responses');
  const thread = await client.request('thread/start', { cwd: REPO_DIR });
  await client.request('turn/start', {
    threadId: thread.thread.id,
    input: [{ type: 'text', text: 'trigger codex interactive approval' }],
  });
  await waitForCondition(() => completed, { timeoutMs: 3000, label: 'Codex App Server turn completion' });
  assert(approvalMethod === 'item/commandExecution/requestApproval', 'Codex App Server client should handle server-initiated approval requests');
  client.dispose();
  await waitForCondition(() => client.closed, { timeoutMs: 3500, label: 'Codex App Server client disposal' });
  assert(exitInfo?.expected === true, 'Codex App Server disposal should be reported as an expected exit');
}

async function runClaudeStreamClientLifecycleRegressionCase() {
  const events = [];
  let exitInfo = null;
  const client = await ClaudeStreamClient.start({
    command: process.execPath,
    args: [
      MOCK_CLAUDE,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ],
    env: process.env,
    cwd: REPO_DIR,
    onEvent: (event) => events.push(event),
    onExit: (info) => { exitInfo = info; },
  });
  const pid = client.pid;
  await client.sendUserMessage([{ type: 'text', text: 'first persistent claude turn' }]);
  await waitForCondition(() => events.filter((event) => event.type === 'result').length === 1, {
    timeoutMs: 3000,
    label: 'first Claude stream result',
  });
  await client.sendUserMessage([{ type: 'text', text: 'second persistent claude turn' }]);
  await waitForCondition(() => events.filter((event) => event.type === 'result').length === 2, {
    timeoutMs: 3000,
    label: 'second Claude stream result',
  });
  assert(client.pid === pid && client.isAlive, 'Claude stream client should reuse one process across turns');
  assert(events.some((event) => event.type === 'assistant' && /second persistent claude turn/.test(event.message?.content?.[0]?.text || '')), 'Claude stream client should parse later turn events');
  client.dispose();
  await waitForCondition(() => client.closed, { timeoutMs: 3500, label: 'Claude stream client disposal' });
  assert(exitInfo?.expected === true, 'Claude stream disposal should be reported as expected');
}

async function runCustomCliDirectoriesRegressionCase({ tempRoot }) {
  const caseRoot = path.join(tempRoot, 'custom-cli-directories');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  const claudeConfigDir = path.join(caseRoot, 'claude-data');
  const codexHome = path.join(caseRoot, 'codex-data');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);
  mkdirp(claudeConfigDir);
  mkdirp(codexHome);

  const claudeFixture = createFakeClaudeHistoryInConfigDir(claudeConfigDir);
  fs.writeFileSync(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-dir-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-dir-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-dir-haiku',
    },
  }, null, 2));
  const codexThreadId = 'codex-custom-home-thread';
  writeFakeCodexRolloutInHome(codexHome, codexThreadId);

  const port = await getFreePort();
  const password = 'Regression!234';
  await withServer({
    PORT: String(port),
    HOST: '127.0.0.1',
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    CC_WEB_WS_MAX_PAYLOAD: String(64 * 1024),
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    PI_PATH: MOCK_PI,
  }, async (serverHandle) => {
    assert(
      serverHandle.stdout().includes(`webcoding server listening on 127.0.0.1:${port}`),
      'Server should respect an explicit loopback HOST',
    );

    await withAuthedClient(port, password, async ({ client }) => {
      const nativeSessions = await client.sendAndWaitType(
        { type: 'list_native_sessions' },
        'native_sessions',
      );
      const claudeItem = nativeSessions.groups
        .flatMap((group) => group.sessions || [])
        .find((item) => item.sessionId === claudeFixture.sessionId);
      assert(claudeItem, 'Claude history should be discovered under CLAUDE_CONFIG_DIR');

      const codexSessions = await client.sendAndWaitType(
        { type: 'list_codex_sessions' },
        'codex_sessions',
      );
      const codexItem = codexSessions.groups
        .flatMap((group) => group.sessions || [])
        .find((item) => item.threadId === codexThreadId);
      assert(codexItem, 'Codex history should be discovered under CODEX_HOME');

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
      assert(modelList.models?.sonnet === 'custom-dir-sonnet', 'Claude settings should be read from CLAUDE_CONFIG_DIR');
    });

    const oversized = await openWs(port);
    const closeResult = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Oversized WebSocket payload was not closed')), 3000);
      oversized.ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: String(reason || '') });
      });
      oversized.ws.once('error', () => {});
    });
    oversized.ws.send(JSON.stringify({ type: 'oversized', data: 'x'.repeat(70 * 1024) }));
    const closed = await closeResult;
    assert(closed.code === 1009, `Oversized WebSocket payload should close with 1009, got ${closed.code}`);
  });
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
  if (normalizedAgent === 'pi') {
    return String(session.piSessionId || '').trim();
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

function createFakeClaudeHistoryInConfigDir(claudeConfigDir) {
  const projectDir = path.join(claudeConfigDir, 'projects', 'tmp-project');
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

function createFakeClaudeHistory(homeDir) {
  return createFakeClaudeHistoryInConfigDir(path.join(homeDir, '.claude'));
}

function createFakePiHistory(homeDir) {
  const agentDir = path.join(homeDir, '.pi', 'agent');
  const cwd = path.join(homeDir, 'pi-import-project');
  const nativeSessionsDir = path.join(homeDir, 'pi-native-sessions');
  const sessionDir = path.join(nativeSessionsDir, '--pi-import-project--');
  const sessionId = 'pi-import-session';
  const filePath = path.join(sessionDir, `2026-03-12T00-00-00-000Z_${sessionId}.jsonl`);
  mkdirp(cwd);
  mkdirp(sessionDir);
  for (const resourceDir of ['extensions', 'skills', 'prompts', 'themes', 'npm', 'git']) {
    mkdirp(path.join(agentDir, resourceDir));
  }
  fs.writeFileSync(path.join(agentDir, 'custom-extension.ts'), 'export default function () {}\n');
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'local-provider',
    defaultModel: 'local-model',
    defaultThinkingLevel: 'high',
    enabledModels: ['local/*'],
    sessionDir: './custom-sessions',
    theme: 'light',
    packages: ['mock-pi-package'],
    extensions: ['./custom-extension.ts'],
    skills: ['./skills'],
    prompts: ['./prompts'],
    themes: ['./themes'],
  }, null, 2));

  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-03-12T00:00:00.000Z', cwd },
    { type: 'model_change', id: 'model-1', parentId: null, timestamp: '2026-03-12T00:00:00.010Z', provider: 'mock', modelId: 'mock-pi-model' },
    { type: 'thinking_level_change', id: 'thinking-1', parentId: 'model-1', timestamp: '2026-03-12T00:00:00.020Z', thinkingLevel: 'high' },
    { type: 'session_info', id: 'info-1', parentId: 'thinking-1', timestamp: '2026-03-12T00:00:00.030Z', name: 'Pi import fixture' },
    {
      type: 'message', id: 'user-1', parentId: 'info-1', timestamp: '2026-03-12T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Pi import prompt' }], timestamp: 1773273601000 },
    },
    {
      type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-03-12T00:00:02.000Z',
      message: {
        role: 'assistant', provider: 'mock', model: 'mock-pi-model',
        content: [
          { type: 'thinking', thinking: 'Pi import reasoning' },
          { type: 'text', text: 'Pi import answer' },
          { type: 'toolCall', id: 'pi-tool-1', name: 'read', arguments: { path: 'README.md' } },
        ],
        usage: { input: 5, cacheRead: 2, output: 7, cost: { total: 0.01 } },
      },
    },
    {
      type: 'message', id: 'tool-1', parentId: 'assistant-1', timestamp: '2026-03-12T00:00:03.000Z',
      message: { role: 'toolResult', toolCallId: 'pi-tool-1', toolName: 'read', content: [{ type: 'text', text: 'fixture tool result' }], isError: false },
    },
    {
      type: 'bashExecution', id: 'bash-1', parentId: 'tool-1', timestamp: '2026-03-12T00:00:03.500Z',
      command: 'printf fixture-bash && exit 7', output: 'fixture-bash', exitCode: 7, cancelled: false, truncated: true,
      fullOutputPath: '/tmp/pi-fixture-full-output.log',
    },
    {
      type: 'message', id: 'discarded-user', parentId: 'bash-1', timestamp: '2026-03-12T00:00:04.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'discarded Pi branch' }] },
    },
    {
      type: 'message', id: 'discarded-assistant', parentId: 'discarded-user', timestamp: '2026-03-12T00:00:05.000Z',
      message: { role: 'assistant', provider: 'mock', model: 'mock-pi-model', content: [{ type: 'text', text: 'discarded answer' }], usage: { input: 99, output: 99, cost: { total: 9 } } },
    },
    {
      type: 'message', id: 'active-user', parentId: 'bash-1', timestamp: '2026-03-12T00:00:06.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'active Pi branch' }] },
    },
    {
      type: 'message', id: 'active-assistant', parentId: 'active-user', timestamp: '2026-03-12T00:00:07.000Z',
      message: { role: 'assistant', provider: 'mock', model: 'mock-pi-model', content: [{ type: 'text', text: 'active branch answer' }], usage: { input: 3, cacheRead: 1, output: 4, cost: { total: 0.02 } } },
    },
  ];
  fs.writeFileSync(filePath, `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { agentDir, cwd, nativeSessionsDir, sessionDir, sessionId, filePath };
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

function writeFakeCodexRolloutInHome(codexHome, threadId) {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '03', '12');
  mkdirp(sessionsDir);
  const safeThreadId = String(threadId).replace(/[^a-zA-Z0-9-]/g, '-');
  const rolloutPath = path.join(sessionsDir, `rollout-2026-03-12T00-00-00-${safeThreadId}.jsonl`);
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

function writeFakeCodexRollout(homeDir, threadId) {
  return writeFakeCodexRolloutInHome(path.join(homeDir, '.codex'), threadId);
}

function writeFakeCodexStateDb(homeDir, threadId, rolloutPath) {
  return writeFakeCodexStateDbInHome(path.join(homeDir, '.codex'), threadId, rolloutPath);
}

function writeFakeCodexStateDbInHome(codexHome, threadId, rolloutPath) {
  const stateDb = path.join(codexHome, 'state_5.sqlite');
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
  return writeFakeCodexLogsDbInHome(path.join(homeDir, '.codex'), threadId);
}

function writeFakeCodexLogsDbInHome(codexHome, threadId) {
  const logsDb = path.join(codexHome, 'logs_1.sqlite');
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

async function runHttpSecurityRegressionCase({ port, password, tempRoot }) {
  await withAuthedClient(port, password, async ({ token }) => {
    const index = await requestHttpJson({ port, path: '/' });
    assert(index.statusCode === 200, 'Index should be served successfully');
    const csp = String(index.headers['content-security-policy'] || '');
    assert(csp.includes("script-src 'self' https://cdnjs.cloudflare.com"), 'CSP should allow only the application and pinned script CDN');
    assert(!/script-src[^;]*unsafe-inline/.test(csp), 'CSP must block inline script execution');
    assert(
      /css\/00-tokens\.css\?v=[a-z0-9]+/.test(index.text)
        && /css\/12-cli-integrations\.css\?v=[a-z0-9]+/.test(index.text)
        && /app\.js\?v=[a-z0-9]+/.test(index.text),
      'Index should receive automatic asset cache versions',
    );

    const markdownPath = path.join(tempRoot, 'unsafe-preview.md');
    fs.writeFileSync(markdownPath, '# Preview\n\n<img src=x onerror="window.__xss=1">\n\n[bad](javascript:alert(1))\n');
    const preview = await requestHttpJson({
      port,
      path: `/api/localfile?path=${encodeURIComponent(markdownPath)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(preview.statusCode === 200, 'Authenticated Markdown preview should load');
    assert(preview.text.includes('/markdown-viewer.js?v='), 'Markdown preview should use the isolated viewer script');
    assert(!preview.text.includes("innerHTML=marked.parse"), 'Markdown preview must not execute inline rendering code');
    assert(preview.text.includes('\\u003cimg'), 'Markdown source should be escaped before embedding in HTML');

    const unauthenticated = await requestHttpJson({
      port,
      path: `/api/localfile?path=${encodeURIComponent(markdownPath)}`,
    });
    assert(unauthenticated.statusCode === 401, 'Local file preview must require authentication');
  });
}

/**
 * Headless parity: interactive event classification, local slash lifecycle,
 * TUI-only blocking, capabilities on slash list, run-meta snapshot.
 */
async function runHeadlessParityRegressionCase({ port, password, configDir, sessionsDir, logsDir, codexFixture }) {
  await withAuthedClient(port, password, async ({ client }) => {
    // --- Codex App Server approval → respondable browser request ---
    const codexInteractiveSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex interactive approval', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex interactive approval',
    );
    const interactiveReq = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === codexInteractiveSession.sessionId
        && msg.protocol === 'codex-app-server'
        && msg.respondable === true,
      8000,
    );
    assert(interactiveReq.interactiveKind === 'select', 'Codex command approval should render as a selectable browser request');
    const approvalResult = await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: codexInteractiveSession.sessionId,
        requestId: interactiveReq.requestId,
        value: 'accept',
      },
      'interactive_response_result',
      (msg) => msg.requestId === interactiveReq.requestId && msg.success === true,
      8000,
    );
    assert(approvalResult.success === true, 'Codex command approval response should reach App Server');
    await client.waitForType('text_delta', (msg) => /approval decision: accept/.test(msg.text || ''), 8000);
    await client.waitForType('done', (msg) => msg.sessionId === codexInteractiveSession.sessionId, 8000);

    const codexStructuredApprovalSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex structured approval', mode: 'default', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex structured approval',
    );
    const structuredApprovalRequest = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === codexStructuredApprovalSession.sessionId
        && msg.options?.some((option) => /记住类似命令/.test(option.label || '')),
      8000,
    );
    const structuredApprovalOption = structuredApprovalRequest.options.find((option) => /记住类似命令/.test(option.label || ''));
    await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: codexStructuredApprovalSession.sessionId,
        requestId: structuredApprovalRequest.requestId,
        value: structuredApprovalOption.value,
      },
      'interactive_response_result',
      (msg) => msg.requestId === structuredApprovalRequest.requestId && msg.success === true,
      8000,
    );
    const structuredApprovalDelta = await client.waitForType('text_delta', (msg) => /approval decision:/.test(msg.text || ''), 8000);
    assert(/acceptWithExecpolicyAmendment/.test(structuredApprovalDelta.text || ''), 'Codex structured approval decisions should round-trip without hard-coded loss');
    await client.waitForType('done', (msg) => msg.sessionId === codexStructuredApprovalSession.sessionId, 8000);

    const codexQuestionSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex user input', mode: 'default', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex user input',
    );
    const questionRequest = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === codexQuestionSession.sessionId
        && msg.interactiveKind === 'questions'
        && msg.questions?.[0]?.id === 'environment',
      8000,
    );
    await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: codexQuestionSession.sessionId,
        requestId: questionRequest.requestId,
        answers: { environment: ['生产环境'] },
      },
      'interactive_response_result',
      (msg) => msg.requestId === questionRequest.requestId && msg.success === true,
      8000,
    );
    await client.waitForType('text_delta', (msg) => /user input: 生产环境/.test(msg.text || ''), 8000);
    await client.waitForType('done', (msg) => msg.sessionId === codexQuestionSession.sessionId, 8000);

    const codexMcpFormSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex mcp form', mode: 'default', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex mcp form',
    );
    const mcpFormRequest = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === codexMcpFormSession.sessionId
        && msg.interactiveKind === 'questions'
        && msg.questions?.some((question) => question.id === 'scopes'),
      8000,
    );
    const scopesQuestion = mcpFormRequest.questions.find((question) => question.id === 'scopes');
    const retriesQuestion = mcpFormRequest.questions.find((question) => question.id === 'retries');
    assert(scopesQuestion?.multiple === true && scopesQuestion?.minItems === 1 && scopesQuestion?.maxItems === 2, 'MCP elicitation should preserve multi-select limits');
    assert(retriesQuestion?.inputType === 'number' && retriesQuestion?.min === 1 && retriesQuestion?.max === 5 && retriesQuestion?.step === 1, 'MCP elicitation should preserve integer input constraints');
    await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: codexMcpFormSession.sessionId,
        requestId: mcpFormRequest.requestId,
        answers: { scopes: ['read', 'write'], retries: ['3'], note: [''] },
      },
      'interactive_response_result',
      (msg) => msg.requestId === mcpFormRequest.requestId && msg.success === true,
      8000,
    );
    const mcpFormDelta = await client.waitForType('text_delta', (msg) => /Codex mock MCP form:/.test(msg.text || ''), 8000);
    assert(/"scopes":\["read","write"\]/.test(mcpFormDelta.text || ''), 'MCP elicitation should return all selected values');
    assert(/"retries":3/.test(mcpFormDelta.text || '') && !/"note"/.test(mcpFormDelta.text || ''), 'MCP elicitation should coerce numbers and omit blank optional fields');
    await client.waitForType('done', (msg) => msg.sessionId === codexMcpFormSession.sessionId, 8000);

    const codexMcpUrlSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex mcp unsafe url', mode: 'default', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex mcp unsafe url',
    );
    const mcpUrlRequest = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === codexMcpUrlSession.sessionId && msg.interactiveKind === 'confirm',
      8000,
    );
    assert(mcpUrlRequest.url === '', 'MCP elicitation must remove non-HTTP authorization URLs');
    await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: codexMcpUrlSession.sessionId,
        requestId: mcpUrlRequest.requestId,
        confirmed: false,
      },
      'interactive_response_result',
      (msg) => msg.requestId === mcpUrlRequest.requestId && msg.success === true,
      8000,
    );
    const mcpUrlDelta = await client.waitForType('text_delta', (msg) => /Codex mock MCP URL:/.test(msg.text || ''), 8000);
    assert(/"action":"decline","content":null/.test(mcpUrlDelta.text || ''), 'Rejected MCP URL elicitation should return the native decline response');
    await client.waitForType('done', (msg) => msg.sessionId === codexMcpUrlSession.sessionId, 8000);

    // --- Codex goal update ---
    const codexGoalSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex goal update', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex goal update',
    );
    const goalUpdate = await client.waitForType(
      'goal_update',
      (msg) => msg.sessionId === codexGoalSession.sessionId && /Ship App Server parity|Goals/i.test(msg.summary || ''),
      8000,
    );
    assert(goalUpdate, 'Codex thread_goal_updated should surface as goal_update');
    await client.waitForType('done', (msg) => msg.sessionId === codexGoalSession.sessionId, 8000);

    // --- Codex current App Server plan notifications ---
    const codexPlanSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex plan updates', mode: 'plan', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex plan updates',
    );
    const planDelta = await client.waitForType(
      'thinking_delta',
      (msg) => msg.sessionId === codexPlanSession.sessionId && /Inspect the authentication boundary/.test(msg.text || ''),
      8000,
    );
    assert(planDelta, 'Codex item/plan/delta should stream into the browser process view');
    const planUpdate = await client.waitForType(
      'goal_update',
      (msg) => msg.sessionId === codexPlanSession.sessionId && /Verify authorization tests/.test(msg.summary || ''),
      8000,
    );
    assert(/\[x\] Inspect the authentication boundary/.test(planUpdate.summary || ''), 'Codex turn/plan/updated should preserve completed plan steps');
    assert(/\[>\] Verify authorization tests/.test(planUpdate.summary || ''), 'Codex turn/plan/updated should preserve in-progress plan steps');
    await client.waitForType('done', (msg) => msg.sessionId === codexPlanSession.sessionId, 8000);

    // --- Codex client-side utility requests from the official schema ---
    const codexUtilitySession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex client utilities', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex client utilities',
    );
    const utilityDelta = await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === codexUtilitySession.sessionId && /Codex mock client utilities:/.test(msg.text || ''),
      8000,
    );
    assert(/"currentTimeAt":\d+/.test(utilityDelta.text || ''), 'Codex currentTime/read should return whole Unix seconds');
    assert(/"success":false/.test(utilityDelta.text || '') && /mock_unregistered_tool/.test(utilityDelta.text || ''), 'Unknown item/tool/call requests should receive a schema-valid failure');
    await client.waitForType('done', (msg) => msg.sessionId === codexUtilitySession.sessionId, 8000);

    const codexSteerSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger codex slow stream steer', mode: 'yolo', agent: 'codex' }),
      'session_info',
      (msg) => msg.agent === 'codex' && msg.title === 'trigger codex slow stream steer',
    );
    await client.waitForType('text_delta', (msg) => /slow-start:steer/.test(msg.text || ''), 5000);
    const steerClientId = `codex-steer-${Date.now()}`;
    const steerAck = await client.sendAndWaitType(
      buildAgentMessagePayload({
        text: 'focus on the auth boundary',
        sessionId: codexSteerSession.sessionId,
        mode: 'yolo',
        agent: 'codex',
        clientMessageId: steerClientId,
        streamingBehavior: 'steer',
      }),
      'message_accepted',
      (msg) => msg.clientMessageId === steerClientId && msg.execution === 'codex-steer',
      5000,
    );
    assert(steerAck.streamingBehavior === 'steer', 'Codex App Server should accept native turn/steer input');
    await client.waitForType('text_delta', (msg) => /steer:focus on the auth boundary/.test(msg.text || ''), 5000);
    await client.waitForType('done', (msg) => msg.sessionId === codexSteerSession.sessionId, 8000);

    // --- Claude bidirectional permission approval ---
    const claudeInteractiveSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger claude interactive permission', mode: 'default', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'trigger claude interactive permission',
    );
    const claudeInteractive = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === claudeInteractiveSession.sessionId
        && /can_use_tool/i.test(msg.eventType || ''),
      8000,
    );
    assert(claudeInteractive.protocol === 'claude-stream-json' && claudeInteractive.respondable === true, 'Claude stream-json approval should be respondable in the browser');
    assert(claudeInteractive.interactiveKind === 'select', 'Claude tool approval should render as a selectable browser request');
    await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: claudeInteractiveSession.sessionId,
        requestId: claudeInteractive.requestId,
        value: 'allow-once',
      },
      'interactive_response_result',
      (msg) => msg.requestId === claudeInteractive.requestId && msg.success === true,
      8000,
    );
    const claudeApprovalDelta = await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === claudeInteractiveSession.sessionId && /Claude mock permission response:/.test(msg.text || ''),
      8000,
    );
    assert(/"behavior":"allow"/.test(claudeApprovalDelta.text || ''), 'Claude allow-once decision should reach the stream-json control request');
    await client.waitForType('done', (msg) => msg.sessionId === claudeInteractiveSession.sessionId, 8000);

    // --- Claude AskUserQuestion browser answers ---
    const claudeQuestionSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger claude ask user', mode: 'default', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'trigger claude ask user',
    );
    const claudeQuestionRequest = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === claudeQuestionSession.sessionId
        && msg.protocol === 'claude-stream-json'
        && msg.interactiveKind === 'questions',
      8000,
    );
    assert(claudeQuestionRequest.questions?.[0]?.id === 'question-1', 'Claude questions should receive stable browser field IDs');
    assert(claudeQuestionRequest.questions?.[1]?.multiple === true, 'Claude multiSelect questions should remain multi-select in the browser');
    await client.sendAndWaitType(
      {
        type: 'interactive_response',
        sessionId: claudeQuestionSession.sessionId,
        requestId: claudeQuestionRequest.requestId,
        answers: {
          'question-1': ['Production'],
          'question-2': ['Tests', 'Lint'],
        },
      },
      'interactive_response_result',
      (msg) => msg.requestId === claudeQuestionRequest.requestId && msg.success === true,
      8000,
    );
    const claudeQuestionDelta = await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === claudeQuestionSession.sessionId && /Claude mock AskUser response:/.test(msg.text || ''),
      8000,
    );
    assert(/"Which environment should Claude target\?":"Production"/.test(claudeQuestionDelta.text || ''), 'Claude AskUser single-select answer should use the original question text');
    assert(/"Which checks should run\?":"Tests, Lint"/.test(claudeQuestionDelta.text || ''), 'Claude AskUser multi-select answers should round-trip as one native answer');
    assert(/"questions":\[/.test(claudeQuestionDelta.text || ''), 'Claude AskUser response should preserve the original tool input');
    await client.waitForType('done', (msg) => msg.sessionId === claudeQuestionSession.sessionId, 8000);

    const claudeEffortList = await client.sendAndWaitType(
      buildAgentMessagePayload({
        text: '/effort',
        sessionId: claudeQuestionSession.sessionId,
        mode: 'default',
        agent: 'claude',
      }),
      'effort_list',
      (msg) => msg.sessionId === claudeQuestionSession.sessionId && msg.agent === 'claude',
      8000,
    );
    assert(claudeEffortList.entries.some((entry) => entry.value === 'max'), 'Claude /effort should expose current CLI effort levels');
    client.send(buildAgentMessagePayload({
      text: '/effort high',
      sessionId: claudeQuestionSession.sessionId,
      mode: 'default',
      agent: 'claude',
    }));
    await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === claudeQuestionSession.sessionId && /Claude 推理强度已切换为：high/.test(msg.message || ''),
      8000,
    );
    client.send(buildAgentMessagePayload({
      text: 'verify claude native effort',
      sessionId: claudeQuestionSession.sessionId,
      mode: 'default',
      agent: 'claude',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === claudeQuestionSession.sessionId, 8000);
    const claudeEffortSpawn = findProcessLogLines(logsDir, claudeQuestionSession.sessionId, 'process_spawn').at(-1) || '';
    assert(claudeEffortSpawn.includes('--effort high'), 'Claude turns should receive the selected native --effort flag');

    // --- Claude permission_denials on result ---
    const claudeDenialSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger claude permission denials', mode: 'yolo', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'trigger claude permission denials',
    );
    const denialMsg = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === claudeDenialSession.sessionId && /permission_denials|权限拒绝/i.test(msg.message || ''),
      8000,
    );
    assert(denialMsg, 'Claude permission_denials should become a system_message');
    await client.waitForType('done', (msg) => msg.sessionId === claudeDenialSession.sessionId, 8000);

    // --- Local slash: /web-help must ACK as local and not require a CLI turn ---
    const helpSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'claude', mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'claude',
    );
    const helpClientId = `help-${Date.now()}`;
    const helpAccepted = await client.sendAndWaitType(
      buildAgentMessagePayload({
        text: '/web-help',
        sessionId: helpSession.sessionId,
        mode: 'yolo',
        agent: 'claude',
        clientMessageId: helpClientId,
      }),
      'message_accepted',
      (msg) => msg.clientMessageId === helpClientId && msg.execution === 'local',
      5000,
    );
    assert(helpAccepted.execution === 'local', '/web-help should accept with execution=local');
    const helpBody = await client.waitForType(
      'system_message',
      (msg) => /Webcoding 平台帮助|平台命令/i.test(msg.message || ''),
      5000,
    );
    assert(helpBody, '/web-help should return platform help text');

    // --- App Server slash capabilities and native review/fork ---
    const codexSlashSession = await client.sendAndWaitType(
      { type: 'new_session', agent: 'codex', mode: 'yolo' },
      'session_info',
      (msg) => msg.agent === 'codex',
    );
    client.send(buildAgentMessagePayload({
      text: 'warm up codex app thread',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === codexSlashSession.sessionId, 8000);
    const reviewThreadId = getActiveStoredRuntimeId(readStoredSessionFile(sessionsDir, codexSlashSession.sessionId), 'codex');
    assert(reviewThreadId, 'Codex App Server warmup should persist a native thread id');
    client.send(buildAgentMessagePayload({
      text: '/status',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const codexStatus = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /Codex App Server 状态/.test(msg.message || ''),
      8000,
    );
    assert(/累计 Token: 输入 10 · 缓存 2 · 输出 5/.test(codexStatus.message || ''), 'Codex /status should expose persisted App Server token usage');

    // --- Slash list carries capabilities ---
    const slashList = await client.sendAndWaitType(
      { type: 'get_slash_commands', agent: 'codex' },
      'slash_commands_list',
      (msg) => msg.agent === 'codex' && Array.isArray(msg.commands),
      15000,
    );
    assert(slashList.capabilities && slashList.capabilities.headless === false, 'slash_commands_list should report the bidirectional App Server transport');
    assert(slashList.capabilities.protocol === 'codex-app-server', 'Codex capability protocol should identify App Server');
    assert(slashList.capabilities.interactiveApproval === true, 'Codex App Server capabilities should expose browser approvals');
    assert(slashList.capabilities.goalsWritable === true, 'Codex App Server capabilities should expose writable native goals');
    assert(slashList.capabilities.reasoningEffort === true, 'Codex App Server capabilities should expose reasoning-effort controls');
    assert(Array.isArray(slashList.capabilities.knownInteractiveEventTypes), 'capabilities should list known interactive event types');
    for (const command of ['/effort', '/status', '/usage', '/ps', '/stop', '/fork', '/rename', '/personality', '/mcp', '/skills', '/goal']) {
      const entry = slashList.commands.find((item) => item.cmd === command);
      assert(entry?.availability === 'platform', `${command} should use its native Codex App Server platform handler`);
      assert(!/TUI/.test(entry.desc || ''), `${command} should not be mislabeled as TUI-only when a Web handler exists`);
    }
    assert(
      slashList.commands.find((item) => item.cmd === '/init')?.availability === 'tui-only',
      'Codex /init should not be advertised as working when App Server has no native equivalent',
    );
    for (const command of ['/plugins', '/plan', '/diff']) {
      assert(
        slashList.commands.find((item) => item.cmd === command)?.availability === 'tui-only',
        `${command} should be discoverable but honestly marked as TUI-only`,
      );
    }

    const codexEffortList = await client.sendAndWaitType(
      buildAgentMessagePayload({
        text: '/effort',
        sessionId: codexSlashSession.sessionId,
        mode: 'yolo',
        agent: 'codex',
      }),
      'effort_list',
      (msg) => msg.sessionId === codexSlashSession.sessionId && msg.agent === 'codex',
      8000,
    );
    assert(codexEffortList.entries.some((entry) => entry.value === 'xhigh'), 'Codex /effort should use model/list reasoning metadata');
    client.send(buildAgentMessagePayload({
      text: '/effort xhigh',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /Codex 推理强度已切换为：xhigh/.test(msg.message || ''),
      8000,
    );
    assert(readStoredSessionFile(sessionsDir, codexSlashSession.sessionId).effort === 'xhigh', 'Codex effort should persist with the Web session');
    client.send(buildAgentMessagePayload({
      text: 'verify codex native effort',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === codexSlashSession.sessionId, 8000);
    const effortTurnLines = findProcessLogLines(logsDir, codexSlashSession.sessionId, 'codex_app_turn_start');
    assert(effortTurnLines.some((line) => line.includes('"effort":"xhigh"')), 'Codex turns should receive the selected native effort');

    client.send(buildAgentMessagePayload({
      text: '/personality pragmatic',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const personalityMessage = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /沟通风格已切换为：pragmatic/.test(msg.message || ''),
      8000,
    );
    assert(personalityMessage, 'Codex /personality should use thread/settings/update');
    assert(readStoredSessionFile(sessionsDir, codexSlashSession.sessionId).codexPersonality === 'pragmatic', 'Codex personality should persist for later App Server resumes');

    client.send(buildAgentMessagePayload({
      text: '/usage',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const usageMessage = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /Codex 账户用量/.test(msg.message || ''),
      8000,
    );
    assert(/累计 Token: 123456/.test(usageMessage.message || '') && /主要限额: 已用 40%/.test(usageMessage.message || ''), 'Codex /usage should use native account usage and rate-limit endpoints');

    client.send(buildAgentMessagePayload({
      text: '/ps',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const backgroundTerminals = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /Codex 后台终端/.test(msg.message || ''),
      8000,
    );
    assert(/npm run mock:watch/.test(backgroundTerminals.message || ''), 'Codex /ps should list native background terminals');

    client.send(buildAgentMessagePayload({
      text: '/stop',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const stopTerminals = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /已停止 1 个 Codex 后台终端/.test(msg.message || ''),
      8000,
    );
    assert(stopTerminals, 'Codex /stop should terminate every native background terminal');

    client.send(buildAgentMessagePayload({
      text: '/skills',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const skillsMessage = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /\$mock-skill/.test(msg.message || ''),
      8000,
    );
    assert(/Mock native Codex skill/.test(skillsMessage.message || ''), 'Codex /skills should use native skills/list metadata');

    client.send(buildAgentMessagePayload({
      text: '/mcp',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const mcpMessage = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /mock-mcp/.test(msg.message || ''),
      8000,
    );
    assert(/mock_tool/.test(mcpMessage.message || ''), 'Codex /mcp should use native MCP status and tool metadata');

    client.send(buildAgentMessagePayload({
      text: '/goal Ship native slash parity',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /目标已更新/.test(msg.message || ''),
      8000,
    );
    client.send(buildAgentMessagePayload({
      text: '/goal',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const goalMessage = await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /Ship native slash parity/.test(msg.message || ''),
      8000,
    );
    assert(/状态：active/.test(goalMessage.message || ''), 'Codex /goal should read native goal state');
    client.send(buildAgentMessagePayload({
      text: '/goal clear',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /目标已清除/.test(msg.message || ''),
      8000,
    );

    // --- Codex /review maps to inline review/start and preserves the thread ---
    client.send(buildAgentMessagePayload({
      text: '/review focus on authentication boundaries',
      sessionId: codexSlashSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    const reviewDelta = await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === codexSlashSession.sessionId && /focus on authentication boundaries/.test(msg.text || ''),
      8000,
    );
    assert(!/\/review/.test(reviewDelta.text || ''), 'Codex review instructions should not include the Web slash command wrapper');
    await client.waitForType('done', (msg) => msg.sessionId === codexSlashSession.sessionId, 8000);
    const reviewSpawnLines = findProcessLogLines(logsDir, codexSlashSession.sessionId, 'codex_app_turn_start');
    const reviewSpawnLine = reviewSpawnLines[reviewSpawnLines.length - 1] || '';
    assert(reviewSpawnLine.includes('"review":true'), 'Codex /review should invoke App Server review/start');
    const threadAfterReview = getActiveStoredRuntimeId(readStoredSessionFile(sessionsDir, codexSlashSession.sessionId), 'codex');
    assert(threadAfterReview === reviewThreadId, 'Inline Codex review must not replace the active conversation thread');

    client.send(buildAgentMessagePayload({
      text: 'verify codex plan collaboration mode',
      sessionId: codexSlashSession.sessionId,
      mode: 'plan',
      agent: 'codex',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === codexSlashSession.sessionId, 8000);
    let collaborationSpawnLines = findProcessLogLines(logsDir, codexSlashSession.sessionId, 'codex_app_turn_start');
    assert(
      collaborationSpawnLines[collaborationSpawnLines.length - 1]?.includes('"collaborationMode":"plan"'),
      'Codex Plan should use the native plan collaboration mode',
    );

    client.send(buildAgentMessagePayload({
      text: 'verify codex default collaboration mode',
      sessionId: codexSlashSession.sessionId,
      mode: 'default',
      agent: 'codex',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === codexSlashSession.sessionId, 8000);
    collaborationSpawnLines = findProcessLogLines(logsDir, codexSlashSession.sessionId, 'codex_app_turn_start');
    assert(
      collaborationSpawnLines[collaborationSpawnLines.length - 1]?.includes('"collaborationMode":"default"'),
      'Codex should explicitly leave Plan by sending the native default collaboration mode',
    );

    const nativeRenameTitle = 'Codex native rename parity';
    client.send(buildAgentMessagePayload({
      text: `/rename ${nativeRenameTitle}`,
      sessionId: codexSlashSession.sessionId,
      mode: 'default',
      agent: 'codex',
    }));
    const renamed = await client.waitForType(
      'session_renamed',
      (msg) => msg.sessionId === codexSlashSession.sessionId && msg.title === nativeRenameTitle,
      8000,
    );
    assert(renamed.title === nativeRenameTitle, 'Codex /rename should update the Web session title');
    await waitForCondition(
      () => !!findProcessLogLine(logsDir, codexSlashSession.sessionId, 'codex_thread_renamed'),
      { label: 'Codex native thread rename' },
    );

    const codexSlashSessionPath = path.join(sessionsDir, `${codexSlashSession.sessionId}.json`);
    const codexSlashStoredSession = readStoredSessionFile(sessionsDir, codexSlashSession.sessionId);
    codexSlashStoredSession.importedRolloutPath = codexFixture.rolloutPath;
    fs.writeFileSync(codexSlashSessionPath, JSON.stringify(codexSlashStoredSession, null, 2));

    const forkClientId = `fork-${Date.now()}`;
    const forkAccepted = await client.sendAndWaitType(
      buildAgentMessagePayload({
        text: '/fork',
        sessionId: codexSlashSession.sessionId,
        mode: 'yolo',
        agent: 'codex',
        clientMessageId: forkClientId,
      }),
      'message_accepted',
      (msg) => msg.clientMessageId === forkClientId && msg.execution === 'local',
      5000,
    );
    assert(forkAccepted, 'Codex /fork should be handled locally through App Server');
    const forkedSession = await client.waitForType(
      'session_info',
      (msg) => msg.agent === 'codex' && msg.sessionId !== codexSlashSession.sessionId && /分支/.test(msg.title || ''),
      8000,
    );
    const forkedStoredSession = readStoredSessionFile(sessionsDir, forkedSession.sessionId);
    const forkedThreadId = getActiveStoredRuntimeId(forkedStoredSession, 'codex');
    assert(
      forkedThreadId && forkedThreadId !== reviewThreadId,
      `Codex /fork should persist a distinct native thread id (forked=${forkedThreadId || 'empty'}, original=${reviewThreadId}, mirror=${forkedStoredSession.codexThreadId || 'empty'})`,
    );
    const forkedRuntimeIds = listAgentRuntimeContexts(forkedStoredSession, 'codex')
      .map((entry) => readRuntimeIdFromContextLike(entry.context))
      .filter(Boolean);
    assert(
      forkedRuntimeIds.length === 1 && forkedRuntimeIds[0] === forkedThreadId,
      'Codex /fork must not copy source thread ids into the forked Web session',
    );
    assert(!forkedStoredSession.importedRolloutPath, 'Codex /fork must not inherit the source rollout deletion path');

    const managedCodexHome = path.join(configDir, 'codex-runtime-home');
    const managedForkRollout = writeFakeCodexRolloutInHome(managedCodexHome, forkedThreadId);
    const managedForkStateDb = writeFakeCodexStateDbInHome(managedCodexHome, forkedThreadId, managedForkRollout);
    const managedForkLogsDb = writeFakeCodexLogsDbInHome(managedCodexHome, forkedThreadId);
    client.send({ type: 'delete_session', sessionId: forkedSession.sessionId });
    await client.waitForType(
      'session_list',
      (msg) => !msg.sessions.some((item) => item.id === forkedSession.sessionId),
      8000,
    );
    await waitForCondition(() => !fs.existsSync(managedForkRollout), { label: 'managed Codex fork rollout deletion' });
    await waitForCondition(
      () => sql(managedForkStateDb, `select count(*) from threads where id=${sqlQuote(forkedThreadId)}`) === '0',
      { label: 'managed Codex fork state row deletion' },
    );
    await waitForCondition(
      () => sql(managedForkLogsDb, `select count(*) from logs where thread_id=${sqlQuote(forkedThreadId)}`) === '0',
      { label: 'managed Codex fork log row deletion' },
    );
    assert(fs.existsSync(codexFixture.rolloutPath), 'Deleting a Codex fork must preserve the source imported rollout');

    // --- run-meta written on spawn ---
    const metaSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'hello run meta', mode: 'plan', agent: 'claude' }),
      'session_info',
      (msg) => msg.agent === 'claude' && msg.title === 'hello run meta',
    );
    await client.waitForType('done', (msg) => msg.sessionId === metaSession.sessionId, 8000);
    const runMetaPath = path.join(sessionsDir, `${metaSession.sessionId}-run`, 'run-meta.json');
    // run dir is cleaned after complete; check process log for mode instead if meta gone.
    const spawnLine = findProcessLogLine(logsDir, metaSession.sessionId, 'process_spawn');
    assert(spawnLine && spawnLine.includes('"mode":"plan"'), 'process_spawn should record plan mode from spawn snapshot');
    // If run dir still exists (race), validate meta content.
    if (fs.existsSync(runMetaPath)) {
      const meta = JSON.parse(fs.readFileSync(runMetaPath, 'utf8'));
      assert(meta.permissionMode === 'plan', 'run-meta should snapshot permissionMode=plan');
    }
  });
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
    const silentCodexError = await client.waitForType('error', (msg) => /Codex 任务失败（退出码 1）/.test(msg.message || ''), 8000);
    assert(/mock turn failed without additional output/.test(silentCodexError.message || ''), 'Codex failed App Server turn should surface its structured error');
    await client.waitForType('done', (msg) => msg.sessionId === silentCodexSession.sessionId, 8000);
    const silentCodexProcessCompleteLine = findProcessLogLine(logsDir, silentCodexSession.sessionId, 'process_complete');
    assert(silentCodexProcessCompleteLine.includes('Codex mock turn failed without additional output'), 'Codex failed turn should be explicit in process_complete log');

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

async function runPiManagedRuntimeRegressionCase({ port, password, configDir, homeDir, piFixture }) {
  await withAuthedClient(port, password, async ({ client }) => {
    await saveConfigAndWait(
      client,
      'save_model_config',
      {
        mode: 'custom',
        activeTemplate: 'Pi Responses Regression',
        templates: [{
          name: 'Pi Responses Regression',
          apiKey: 'sk-pi-regression',
          apiBase: 'https://example.com/v1',
          upstreamType: 'openai',
          defaultModel: 'pi-responses-model',
        }],
      },
      'model_config',
    );
    const piConfig = await saveConfigAndWait(
      client,
      'save_pi_config',
      { mode: 'unified', sharedTemplate: 'Pi Responses Regression' },
      'pi_config',
    );
    assert(piConfig.config.mode === 'unified', 'Pi should save unified provider mode');

    const runtimeDir = path.join(configDir, 'pi-runtime-home');
    const models = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'models.json'), 'utf8'));
    const provider = models.providers?.webcoding;
    assert(provider?.api === 'openai-responses', 'Pi unified runtime should use the Responses API');
    assert(/^http:\/\/127\.0\.0\.1:\d+\/openai$/.test(provider?.baseUrl || ''), 'Pi unified runtime should route through the local bridge');
    assert(provider?.apiKey === '$WEBCODING_PI_API_KEY', 'Pi runtime should reference the isolated bridge token env var');
    const managedModel = provider?.models?.[0] || {};
    assert(managedModel.id === 'pi-responses-model', 'Pi runtime should preserve the selected model id');
    assert(!Object.prototype.hasOwnProperty.call(managedModel, 'contextWindow'), 'Pi runtime must not invent a model context window');
    assert(!Object.prototype.hasOwnProperty.call(managedModel, 'maxTokens'), 'Pi runtime must not invent a model output limit');
    assert(!Object.prototype.hasOwnProperty.call(managedModel, 'input'), 'Pi runtime must not claim unsupported image input');

    const settings = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'settings.json'), 'utf8'));
    assert(settings.defaultProvider === 'webcoding' && settings.defaultModel === 'pi-responses-model', 'Pi managed settings should override only provider selection');
    assert(settings.defaultThinkingLevel === 'high' && settings.theme === 'light', 'Pi managed settings should inherit user behavior preferences');
    assert(Array.isArray(settings.packages) && settings.packages.includes('mock-pi-package'), 'Pi managed settings should inherit package configuration');
    assert(!Object.prototype.hasOwnProperty.call(settings, 'enabledModels'), 'Pi managed settings should not retain incompatible local model cycling filters');
    assert(!Object.prototype.hasOwnProperty.call(settings, 'sessionDir'), 'Pi managed settings should let Webcoding own session storage');
    for (const key of ['extensions', 'skills', 'prompts', 'themes']) {
      assert(
        Array.isArray(settings[key]) && settings[key].some((entry) => String(entry).startsWith(path.join(homeDir, '.pi', 'agent'))),
        `Pi managed settings should inherit global ${key}`,
      );
    }
    for (const dirName of ['npm', 'git']) {
      const mounted = path.join(runtimeDir, dirName);
      assert(fs.realpathSync(mounted) === fs.realpathSync(path.join(piFixture.agentDir, dirName)), `Pi managed runtime should mount the user ${dirName} package store`);
    }
  });
}

async function runPiNativeImportAndForkRegressionCase({ port, password, sessionsDir, piFixture }) {
  await withAuthedClient(port, password, async ({ client }) => {
    const listed = await client.sendAndWaitType(
      { type: 'list_pi_sessions' },
      'pi_sessions',
      (msg) => msg.groups?.some((group) => group.sessions?.some((item) => item.sessionId === piFixture.sessionId)),
      8000,
    );
    const listedItem = listed.groups.flatMap((group) => group.sessions || [])
      .find((item) => item.sessionId === piFixture.sessionId);
    assert(listedItem && listedItem.title === 'Pi import fixture', 'Pi native listing should expose session name and id');

    const imported = await client.sendAndWaitType(
      { type: 'import_pi_session', sessionId: piFixture.sessionId, sessionPath: piFixture.filePath },
      'session_info',
      (msg) => msg.agent === 'pi' && msg.imported === true,
      8000,
    );
    const importedText = (imported.messages || []).map((message) => message.content || '').join('\n');
    assert(importedText.includes('Pi import prompt') && importedText.includes('active Pi branch'), 'Pi import should restore the active branch');
    assert(!importedText.includes('discarded Pi branch') && !importedText.includes('discarded answer'), 'Pi import should exclude abandoned branches');
    const importedAssistant = imported.messages.find((message) => message.role === 'assistant' && /Pi import answer/.test(message.content || ''));
    assert(importedAssistant?.segments?.some((segment) => segment.thinking === true && /reasoning/.test(segment.text || '')), 'Pi import should preserve thinking segments');
    assert(importedAssistant?.toolCalls?.[0]?.result === 'fixture tool result', 'Pi import should attach tool results to their calls');
    const importedBash = imported.messages.find((message) => message.toolCalls?.some((tool) => tool.name === 'bash'));
    const importedBashTool = importedBash?.toolCalls?.find((tool) => tool.name === 'bash');
    assert(importedBashTool?.input?.command === 'printf fixture-bash && exit 7', 'Pi import should preserve native bashExecution commands');
    assert(/fixture-bash/.test(importedBashTool?.result || '') && /输出已截断/.test(importedBashTool?.result || ''), 'Pi import should preserve bashExecution output and truncation details');
    assert(importedBashTool?.isError === true && importedBashTool?.meta?.exitCode === 7, 'Pi import should preserve bashExecution failure state');
    assert(imported.totalUsage?.inputTokens === 8 && imported.totalUsage?.cachedInputTokens === 3 && imported.totalUsage?.outputTokens === 11, 'Pi import should aggregate active-branch usage only');
    assert(Math.abs(Number(imported.totalCost || 0) - 0.03) < 1e-9, 'Pi import should aggregate active-branch cost only');

    let stored = readStoredSessionFile(sessionsDir, imported.sessionId);
    assert(stored.piSessionId === piFixture.sessionId && stored.claudeSessionId === null, 'Pi import should persist its native id without reusing Claude metadata');
    assert(getActiveStoredRuntimeId(stored, 'pi') === piFixture.sessionId, 'Pi import should bind the native id to the active Pi runtime context');
    const importedStorageDir = path.join(sessionsDir, '_pi-sessions', imported.sessionId);
    assert(fs.readdirSync(importedStorageDir).some((name) => name.endsWith('.jsonl')), 'Pi import should copy native JSONL into Webcoding-owned storage');

    client.send(buildAgentMessagePayload({
      text: 'continue imported Pi context',
      sessionId: imported.sessionId,
      mode: 'yolo',
      agent: 'pi',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === imported.sessionId, 8000);
    stored = readStoredSessionFile(sessionsDir, imported.sessionId);
    assert(getActiveStoredRuntimeId(stored, 'pi') === piFixture.sessionId, 'Continuing an imported Pi session should retain its native id');

    const forkOptions = await client.sendAndWaitType(
      buildAgentMessagePayload({
        text: '/fork',
        sessionId: imported.sessionId,
        mode: 'yolo',
        agent: 'pi',
        clientMessageId: 'pi-native-fork',
      }),
      'pi_fork_options',
      (msg) => msg.sessionId === imported.sessionId,
      8000,
    );
    const selectedForkOption = forkOptions.options?.find((option) => option.entryId === 'active-user');
    assert(selectedForkOption?.text === 'active Pi branch', 'Pi /fork should expose native user-message branch points');
    client.send({
      type: 'fork_pi_session',
      sessionId: imported.sessionId,
      entryId: selectedForkOption.entryId,
    });
    client.send({ type: 'delete_session', sessionId: imported.sessionId });
    const blockedDelete = await client.waitForType(
      'error',
      (msg) => msg.sessionId === imported.sessionId && /正在创建分支/.test(msg.message || ''),
      8000,
    );
    assert(blockedDelete, 'Deleting a Pi session must be blocked while its fork selection is in progress');
    const forked = await client.waitForType(
      'session_info',
      (msg) => msg.agent === 'pi' && msg.sessionId !== imported.sessionId && /分支/.test(msg.title || ''),
      8000,
    );
    assert(forked.forked === true && forked.draftText === 'active Pi branch', 'Pi /fork should return the selected prompt as an editable Web draft');
    const forkedHistoryText = (forked.messages || []).map((message) => message.content || '').join('\n');
    assert(forkedHistoryText.includes('Pi import prompt') && !forkedHistoryText.includes('active Pi branch'), 'Pi /fork should show history only up to the selected branch point');
    assert(forked.totalUsage?.inputTokens === 5 && Math.abs(Number(forked.totalCost || 0) - 0.01) < 1e-9, 'Pi /fork should recalculate usage and cost for the selected history path');
    const sourceAfterFork = readStoredSessionFile(sessionsDir, imported.sessionId);
    const forkedStored = readStoredSessionFile(sessionsDir, forked.sessionId);
    const sourceRuntimeId = getActiveStoredRuntimeId(sourceAfterFork, 'pi');
    const forkedRuntimeId = getActiveStoredRuntimeId(forkedStored, 'pi');
    assert(sourceRuntimeId === piFixture.sessionId, 'Pi /fork should restore the original RPC session after cloning');
    assert(forkedRuntimeId && forkedRuntimeId !== sourceRuntimeId, 'Pi /fork should persist a distinct native session id');
    assert(forkedStored.piSessionId === forkedRuntimeId && forkedStored.claudeSessionId === null, 'Pi fork should use dedicated Pi metadata');
    const forkStorageDir = path.join(sessionsDir, '_pi-sessions', forked.sessionId);
    assert(fs.readdirSync(forkStorageDir).some((name) => name.endsWith('.jsonl')), 'Pi /fork should copy the cloned native JSONL into the forked Web session');
    assert(!fs.existsSync(path.join(importedStorageDir, `${forkedRuntimeId}.jsonl`)), 'Pi /fork should remove its temporary JSONL from the source Web session');

    client.send(buildAgentMessagePayload({
      text: 'continue forked Pi context',
      sessionId: forked.sessionId,
      mode: 'yolo',
      agent: 'pi',
    }));
    await client.waitForType('done', (msg) => msg.sessionId === forked.sessionId, 8000);
    assert(getActiveStoredRuntimeId(readStoredSessionFile(sessionsDir, forked.sessionId), 'pi') === forkedRuntimeId, 'Forked Pi session should resume its own native id');
  });
}

async function runPiAgentRegressionCase({ port, password, sessionsDir, logsDir }) {
  await withAuthedClient(port, password, async ({ client }) => {
    const session = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'hello from pi adapter', mode: 'yolo', agent: 'pi' }),
      'session_info',
      (msg) => msg.agent === 'pi' && /hello from pi adapter/.test(msg.title || ''),
    );
    assert(session.agent === 'pi', 'New session should be tagged as pi agent');

    const delta = await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === session.sessionId && /Pi mock handled/.test(msg.text || ''),
      8000,
    );
    assert(/Pi mock handled/.test(delta.text || ''), 'Pi mock should stream text_delta events');
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);
    const firstText = getLastStoredAssistantText(sessionsDir, session.sessionId);
    assert(/turn 1/.test(firstText || ''), 'First Pi turn should persist mock turn counter');

    const processSpawnLine = findProcessLogLine(logsDir, session.sessionId, 'process_spawn');
    assert(processSpawnLine && processSpawnLine.includes('"agent":"pi"'), 'Pi spawn should be logged with agent=pi');
    assert(processSpawnLine.includes('--mode') && processSpawnLine.includes('rpc'), 'Pi spawn should use persistent --mode rpc');
    assert(processSpawnLine.includes('"transport":"rpc"'), 'Pi spawn log should identify RPC transport');

    const modelList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model', sessionId: session.sessionId, mode: 'yolo', agent: 'pi' }),
      'model_list',
      (msg) => msg.agent === 'pi' && msg.source === 'pi-rpc',
      8000,
    );
    assert(modelList.entries.some((entry) => entry.value === 'mock/mock-pi-fast'), 'Pi RPC should discover real model metadata');

    const slashList = await client.sendAndWaitType(
      { type: 'get_slash_commands', agent: 'pi' },
      'slash_commands_list',
      (msg) => msg.agent === 'pi' && msg.commands?.some((command) => command.cmd === '/rpc-demo'),
      8000,
    );
    assert(slashList.capabilities?.protocol === 'pi-rpc', 'Pi capabilities should advertise the RPC protocol');
    assert(slashList.capabilities?.askUser === true, 'Pi RPC capabilities should advertise respondable interaction');
    assert(slashList.capabilities?.nativeStreamingQueue === true, 'Pi RPC capabilities should advertise its native streaming queue');
    assert(slashList.capabilities?.thinkingLevel === true, 'Pi RPC capabilities should advertise native thinking-level controls');
    assert(slashList.commands.find((entry) => entry.cmd === '/thinking')?.availability === 'platform', 'Pi /thinking should be handled through native RPC');
    assert(
      slashList.capabilities?.streamingBehaviors?.includes('steer')
        && slashList.capabilities?.streamingBehaviors?.includes('followUp'),
      'Pi RPC capabilities should advertise steer and followUp modes',
    );

    const thinkingList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/thinking', sessionId: session.sessionId, mode: 'yolo', agent: 'pi' }),
      'effort_list',
      (msg) => msg.sessionId === session.sessionId && msg.agent === 'pi' && msg.command === 'thinking',
      8000,
    );
    assert(thinkingList.current === 'medium', 'Pi /thinking should read the active RPC thinking level');
    assert(thinkingList.entries.some((entry) => entry.value === 'xhigh'), 'Pi /thinking should expose every current native thinking level');
    client.send(buildAgentMessagePayload({
      text: '/thinking high',
      sessionId: session.sessionId,
      mode: 'yolo',
      agent: 'pi',
    }));
    await client.waitForType(
      'system_message',
      (msg) => msg.sessionId === session.sessionId && /Pi 思考级别已切换为：high/.test(msg.message || ''),
      8000,
    );
    assert(readStoredSessionFile(sessionsDir, session.sessionId).thinking === 'high', 'Pi thinking level should persist with the Web session');
    const thinkingModelList = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: '/model', sessionId: session.sessionId, mode: 'yolo', agent: 'pi' }),
      'model_list',
      (msg) => msg.sessionId === undefined && msg.agent === 'pi' && msg.thinkingLevel === 'high',
      8000,
    );
    assert(thinkingModelList.thinkingLevel === 'high', 'Pi set_thinking_level should update the live RPC runtime without restarting it');

    // Multi-turn resume via --session-id
    client.send(buildAgentMessagePayload({
      text: 'second turn on same pi session',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
    }));
    await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === session.sessionId && /Pi mock handled/.test(msg.text || ''),
      8000,
    );
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);
    const secondText = getLastStoredAssistantText(sessionsDir, session.sessionId);
    assert(/turn 2/.test(secondText || ''), 'Pi second turn should resume the same mock session state');

    client.send(buildAgentMessagePayload({
      text: 'trigger pi rpc passive ui',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
    }));
    const passiveTitle = await client.waitForType(
      'pi_extension_ui',
      (msg) => msg.sessionId === session.sessionId && msg.method === 'setTitle',
      8000,
    );
    const passiveStatus = await client.waitForType(
      'pi_extension_ui',
      (msg) => msg.sessionId === session.sessionId && msg.method === 'setStatus',
      8000,
    );
    const passiveWidget = await client.waitForType(
      'pi_extension_ui',
      (msg) => msg.sessionId === session.sessionId && msg.method === 'setWidget',
      8000,
    );
    const passiveEditor = await client.waitForType(
      'pi_extension_ui',
      (msg) => msg.sessionId === session.sessionId && msg.method === 'set_editor_text',
      8000,
    );
    assert(passiveTitle.title === 'Pi Mock Workspace', 'Pi setTitle should reach the browser');
    assert(passiveStatus.key === 'build' && passiveStatus.text === 'Build ready', 'Pi setStatus should reach the browser');
    assert(passiveWidget.key === 'checks' && passiveWidget.lines?.length === 2, 'Pi setWidget should preserve widget lines');
    assert(passiveEditor.text === 'follow up from Pi extension', 'Pi set_editor_text should prefill the browser composer');
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);

    client.send({ type: 'load_session', sessionId: session.sessionId });
    await client.waitForType('session_info', (msg) => msg.sessionId === session.sessionId, 8000);
    await client.waitForType(
      'pi_extension_ui',
      (msg) => msg.sessionId === session.sessionId && msg.method === 'setStatus' && msg.text === 'Build ready',
      8000,
    );
    await client.waitForType(
      'pi_extension_ui',
      (msg) => msg.sessionId === session.sessionId && msg.method === 'setWidget' && msg.lines?.includes('Tests: passed'),
      8000,
    );

    // Native streaming queue: follow-up is accepted first, but steering runs first.
    client.send(buildAgentMessagePayload({
      text: 'trigger pi rpc queue',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
    }));
    await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === session.sessionId && /queue is waiting/.test(msg.text || ''),
      8000,
    );
    const followUpPayload = buildAgentMessagePayload({
      text: 'native follow-up message',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
      clientMessageId: 'pi-native-follow-up',
    });
    followUpPayload.streamingBehavior = 'followUp';
    client.send(followUpPayload);
    const followUpAck = await client.waitForType(
      'message_accepted',
      (msg) => msg.clientMessageId === 'pi-native-follow-up',
      8000,
    );
    assert(followUpAck.execution === 'pi-queue' && followUpAck.streamingBehavior === 'followUp', 'Pi follow-up should ACK only after native queue acceptance');

    const steerPayload = buildAgentMessagePayload({
      text: 'native steering message',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
      clientMessageId: 'pi-native-steer',
    });
    steerPayload.streamingBehavior = 'steer';
    client.send(steerPayload);
    client.send(steerPayload); // same in-flight id must merge into one Pi request
    const steerAck = await client.waitForType(
      'message_accepted',
      (msg) => msg.clientMessageId === 'pi-native-steer',
      8000,
    );
    assert(steerAck.execution === 'pi-queue' && steerAck.streamingBehavior === 'steer', 'Pi steering should preserve its native queue mode in the ACK');
    const queuedState = await client.waitForType(
      'pi_queue_update',
      (msg) => msg.sessionId === session.sessionId && msg.items?.length === 2,
      8000,
    );
    assert(queuedState.steeringCount === 1 && queuedState.followUpCount === 1, 'Pi queue state should expose one item in each native queue');

    const steerStart = await client.waitForType(
      'pi_queued_turn_start',
      (msg) => msg.sessionId === session.sessionId && msg.clientMessageId === 'pi-native-steer',
      8000,
    );
    assert(steerStart.streamingBehavior === 'steer', 'Pi should start the steering message before an earlier follow-up');
    const followUpStart = await client.waitForType(
      'pi_queued_turn_start',
      (msg) => msg.sessionId === session.sessionId && msg.clientMessageId === 'pi-native-follow-up',
      8000,
    );
    assert(followUpStart.streamingBehavior === 'followUp', 'Pi should start the follow-up after steering is drained');
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);

    const queuedHistory = readStoredSessionFile(sessionsDir, session.sessionId).messages;
    const queueRootIndex = queuedHistory.findIndex((message) => message.role === 'user' && message.content === 'trigger pi rpc queue');
    const queueSlice = queuedHistory.slice(queueRootIndex).map((message) => `${message.role}:${message.content || ''}`);
    assert(queueRootIndex >= 0, 'Pi queue root prompt should be persisted');
    assert(queueSlice[1]?.startsWith('assistant:Pi RPC queue is waiting...Pi RPC initial queued turn complete.'), 'Pi should persist the current assistant portion before queued user input');
    assert(queueSlice[2] === 'user:native steering message', 'Pi history should persist the steering user message when it actually starts');
    assert(queueSlice[3] === 'assistant:Pi RPC steer handled: native steering message', 'Pi history should keep the steering response adjacent to its user message');
    assert(queueSlice[4] === 'user:native follow-up message', 'Pi history should persist follow-up after steering');
    assert(queueSlice[5] === 'assistant:Pi RPC followUp handled: native follow-up message', 'Pi history should keep the follow-up response in order');
    assert(
      queuedHistory.filter((message) => message.role === 'user' && message.content === 'native steering message').length === 1,
      'Duplicate in-flight clientMessageId must enqueue and persist only one steering message',
    );

    client.send(buildAgentMessagePayload({
      text: 'trigger pi rpc select',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
    }));
    const selectRequest = await client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === session.sessionId && msg.requestId === 'mock-pi-select',
      8000,
    );
    assert(selectRequest.respondable === true, 'Pi RPC extension UI should be respondable from the Web client');
    assert(selectRequest.options?.includes('生产环境'), 'Pi RPC select options should reach the browser');
    client.send({
      type: 'interactive_response',
      sessionId: session.sessionId,
      requestId: selectRequest.requestId,
      value: '生产环境',
    });
    await client.waitForType(
      'interactive_response_result',
      (msg) => msg.sessionId === session.sessionId && msg.requestId === selectRequest.requestId && msg.success === true,
      8000,
    );
    await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === session.sessionId && /Pi RPC interaction/.test(msg.text || ''),
      8000,
    );
    await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);
    const interactionText = getLastStoredAssistantText(sessionsDir, session.sessionId);
    assert(/interaction result: 生产环境/.test(interactionText), 'Pi RPC should persist the selected interaction value');

    client.send(buildAgentMessagePayload({
      text: 'trigger pi rpc slow',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
    }));
    await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === session.sessionId && /still running/.test(msg.text || ''),
      8000,
    );
    const discardedPayload = buildAgentMessagePayload({
      text: 'discard this native follow-up',
      mode: 'yolo',
      agent: 'pi',
      sessionId: session.sessionId,
      clientMessageId: 'pi-native-discard',
    });
    discardedPayload.streamingBehavior = 'followUp';
    client.send(discardedPayload);
    await client.waitForType(
      'message_accepted',
      (msg) => msg.clientMessageId === 'pi-native-discard' && msg.execution === 'pi-queue',
      8000,
    );
    client.send({ type: 'abort' });
    const aborted = await client.waitForType(
      'done',
      (msg) => msg.sessionId === session.sessionId && msg.interrupted === true,
      8000,
    );
    assert(aborted.interrupted === true, 'Pi RPC abort should stop the turn without killing the persistent session');
    const abortedHistory = readStoredSessionFile(sessionsDir, session.sessionId).messages;
    assert(!abortedHistory.some((message) => message.role === 'user' && message.content === 'discard this native follow-up'), 'Pi abort should discard queued user messages before they enter history');

    // Plan mode maps to read-only tools (assert full stored text — deltas are chunked)
    const planSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'plan mode check', mode: 'plan', agent: 'pi' }),
      'session_info',
      (msg) => msg.agent === 'pi' && msg.title === 'plan mode check',
    );
    await client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === planSession.sessionId && /Pi mock handled/.test(msg.text || ''),
      8000,
    );
    await client.waitForType('done', (msg) => msg.sessionId === planSession.sessionId, 8000);
    const planText = getLastStoredAssistantText(sessionsDir, planSession.sessionId);
    assert(/tools=read,grep,find,ls/.test(planText || ''), 'Plan mode should map to read-only Pi tools');
    const planSpawnLine = findProcessLogLine(logsDir, planSession.sessionId, 'process_spawn');
    assert(planSpawnLine.includes('--tools') && planSpawnLine.includes('read,grep,find,ls'), 'Plan spawn should pass --tools read,grep,find,ls');

    // Auth error mapping
    const authSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger pi auth error', mode: 'yolo', agent: 'pi' }),
      'session_info',
      (msg) => msg.agent === 'pi' && msg.title === 'trigger pi auth error',
    );
    const authError = await client.waitForType('error', (msg) => /Pi 鉴权失败/.test(msg.message || ''), 8000);
    assert(/Pi 鉴权失败/.test(authError.message || ''), 'Pi auth stderr should map to friendly auth error');
    await client.waitForType('done', (msg) => msg.sessionId === authSession.sessionId, 8000);

    // Structured JSON failure (exit 0 + stopReason=error) must surface as error, not silent success
    const jsonErrSession = await client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger pi json error', mode: 'yolo', agent: 'pi' }),
      'session_info',
      (msg) => msg.agent === 'pi' && msg.title === 'trigger pi json error',
    );
    const jsonError = await client.waitForType(
      'error',
      (msg) => msg.sessionId === jsonErrSession.sessionId && /stopReason=error|Pi mock structured failure|Pi 请求失败/.test(msg.message || ''),
      8000,
    );
    assert(jsonError, 'Pi JSON stopReason=error should emit error event even with exit code 0');
    await client.waitForType('done', (msg) => msg.sessionId === jsonErrSession.sessionId, 8000);

    // Session dir should exist under sessions/_pi-sessions
    const piRoot = path.join(sessionsDir, '_pi-sessions');
    assert(fs.existsSync(piRoot), 'Pi session storage root should be created under sessions/_pi-sessions');
  });
}

async function runPiRpcReconnectRegressionCase({ port, password }) {
  let originalConnection = null;
  let resumedConnection = null;
  let sessionId = null;
  let completed = false;
  try {
    originalConnection = await connectAuthedClient(port, password);
    const session = await originalConnection.client.sendAndWaitType(
      buildAgentMessagePayload({ text: 'trigger pi rpc select', mode: 'yolo', agent: 'pi' }),
      'session_info',
      (msg) => msg.agent === 'pi' && msg.title === 'trigger pi rpc select',
    );
    sessionId = session.sessionId;
    const initialRequest = await originalConnection.client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === sessionId && msg.requestId === 'mock-pi-select',
      8000,
    );
    assert(initialRequest.respondable === true, 'Pi RPC interaction should initially be respondable');

    await closeWs(originalConnection.ws);
    resumedConnection = await connectAuthedClient(port, password);
    resumedConnection.client.send({ type: 'load_session', sessionId });
    await resumedConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === sessionId && msg.isRunning === true,
      5000,
    );
    await resumedConnection.client.waitForType(
      'resume_generating',
      (msg) => msg.sessionId === sessionId,
      5000,
    );
    const replayedRequest = await resumedConnection.client.waitForType(
      'interactive_request',
      (msg) => msg.sessionId === sessionId && msg.requestId === initialRequest.requestId,
      5000,
    );
    assert(replayedRequest.options?.includes('生产环境'), 'Pi RPC should replay pending interaction details after reconnect');

    resumedConnection.client.send({
      type: 'interactive_response',
      sessionId,
      requestId: replayedRequest.requestId,
      value: '测试环境',
    });
    await resumedConnection.client.waitForType(
      'interactive_response_result',
      (msg) => msg.sessionId === sessionId && msg.requestId === replayedRequest.requestId && msg.success === true,
      5000,
    );
    await resumedConnection.client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === sessionId && /Pi RPC interaction/.test(msg.text || ''),
      8000,
    );
    await resumedConnection.client.waitForType('done', (msg) => msg.sessionId === sessionId, 8000);

    resumedConnection.client.send(buildAgentMessagePayload({
      text: 'trigger pi rpc queue reconnect',
      mode: 'yolo',
      agent: 'pi',
      sessionId,
    }));
    await resumedConnection.client.waitForType(
      'text_delta',
      (msg) => msg.sessionId === sessionId && /queue is waiting/.test(msg.text || ''),
      8000,
    );
    const reconnectQueuePayload = buildAgentMessagePayload({
      text: 'restore this native queue item',
      mode: 'yolo',
      agent: 'pi',
      sessionId,
      clientMessageId: 'pi-native-reconnect',
    });
    reconnectQueuePayload.streamingBehavior = 'followUp';
    resumedConnection.client.send(reconnectQueuePayload);
    await resumedConnection.client.waitForType(
      'message_accepted',
      (msg) => msg.clientMessageId === 'pi-native-reconnect' && msg.execution === 'pi-queue',
      8000,
    );
    await resumedConnection.client.waitForType(
      'pi_queue_update',
      (msg) => msg.sessionId === sessionId && msg.items?.some((item) => item.clientMessageId === 'pi-native-reconnect'),
      8000,
    );

    await closeWs(resumedConnection.ws);
    resumedConnection = await connectAuthedClient(port, password);
    resumedConnection.client.send({ type: 'load_session', sessionId });
    await resumedConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === sessionId && msg.isRunning === true,
      5000,
    );
    await resumedConnection.client.waitForType('resume_generating', (msg) => msg.sessionId === sessionId, 5000);
    const restoredQueue = await resumedConnection.client.waitForType(
      'pi_queue_update',
      (msg) => msg.sessionId === sessionId && msg.items?.some((item) => item.clientMessageId === 'pi-native-reconnect'),
      5000,
    );
    assert(restoredQueue.followUpCount === 1, 'Pi native queue should be replayed after WebSocket reconnect');
    resumedConnection.client.send({ type: 'abort' });
    await resumedConnection.client.waitForType(
      'done',
      (msg) => msg.sessionId === sessionId && msg.interrupted === true,
      8000,
    );
    completed = true;
  } finally {
    if (!completed && resumedConnection?.ws?.readyState === WebSocket.OPEN && sessionId) {
      resumedConnection.client.send({ type: 'abort' });
      await sleep(100);
    }
    if (originalConnection) await closeWs(originalConnection.ws);
    if (resumedConnection) await closeWs(resumedConnection.ws);
  }
}

async function runClaudeCodexInteractionReconnectRegressionCase({ port, password }) {
  async function exercise({ agent, prompt, protocol, value, completionPattern }) {
    let originalConnection = null;
    let resumedConnection = null;
    let sessionId = null;
    let completed = false;
    try {
      originalConnection = await connectAuthedClient(port, password);
      const session = await originalConnection.client.sendAndWaitType(
        buildAgentMessagePayload({ text: prompt, mode: 'default', agent }),
        'session_info',
        (msg) => msg.agent === agent && msg.title === prompt,
      );
      sessionId = session.sessionId;
      const initialRequest = await originalConnection.client.waitForType(
        'interactive_request',
        (msg) => msg.sessionId === sessionId && msg.protocol === protocol && msg.respondable === true,
        8000,
      );

      await closeWs(originalConnection.ws);
      resumedConnection = await connectAuthedClient(port, password);
      resumedConnection.client.send({ type: 'load_session', sessionId });
      await resumedConnection.client.waitForType(
        'session_info',
        (msg) => msg.sessionId === sessionId && msg.isRunning === true,
        5000,
      );
      await resumedConnection.client.waitForType('resume_generating', (msg) => msg.sessionId === sessionId, 5000);
      const replayedRequest = await resumedConnection.client.waitForType(
        'interactive_request',
        (msg) => msg.sessionId === sessionId && msg.requestId === initialRequest.requestId,
        5000,
      );
      assert(replayedRequest.protocol === protocol, `${agent} should replay its pending native interaction after reconnect`);

      resumedConnection.client.send({
        type: 'interactive_response',
        sessionId,
        requestId: replayedRequest.requestId,
        value,
      });
      await resumedConnection.client.waitForType(
        'interactive_response_result',
        (msg) => msg.sessionId === sessionId && msg.requestId === replayedRequest.requestId && msg.success === true,
        5000,
      );
      await resumedConnection.client.waitForType(
        'text_delta',
        (msg) => msg.sessionId === sessionId && completionPattern.test(msg.text || ''),
        8000,
      );
      await resumedConnection.client.waitForType('done', (msg) => msg.sessionId === sessionId, 8000);
      completed = true;
    } finally {
      if (!completed && resumedConnection?.ws?.readyState === WebSocket.OPEN && sessionId) {
        resumedConnection.client.send({ type: 'abort' });
        await sleep(100);
      }
      if (originalConnection) await closeWs(originalConnection.ws);
      if (resumedConnection) await closeWs(resumedConnection.ws);
    }
  }

  await exercise({
    agent: 'claude',
    prompt: 'trigger claude interactive permission',
    protocol: 'claude-stream-json',
    value: 'allow-once',
    completionPattern: /Claude mock permission response:/,
  });
  await exercise({
    agent: 'codex',
    prompt: 'trigger codex interactive approval',
    protocol: 'codex-app-server',
    value: 'accept',
    completionPattern: /approval decision: accept/,
  });
}

async function runPiHeadlessFallbackRegressionCase({ tempRoot, password }) {
  const fallbackRoot = path.join(tempRoot, 'pi-headless-fallback');
  const configDir = path.join(fallbackRoot, 'config');
  const sessionsDir = path.join(fallbackRoot, 'sessions');
  const logsDir = path.join(fallbackRoot, 'logs');
  const homeDir = path.join(fallbackRoot, 'home');
  for (const dir of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(dir);
  const port = await getFreePort();
  const serverEnv = {
    PORT: String(port),
    HOST: '127.0.0.1',
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    CC_WEB_PI_TRANSPORT: 'headless',
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    PI_PATH: MOCK_PI,
  };

  await withServer(serverEnv, async () => {
    await withAuthedClient(port, password, async ({ client }) => {
      const session = await client.sendAndWaitType(
        buildAgentMessagePayload({ text: 'pi headless fallback', mode: 'yolo', agent: 'pi' }),
        'session_info',
        (msg) => msg.agent === 'pi' && msg.title === 'pi headless fallback',
      );
      await client.waitForType(
        'text_delta',
        (msg) => msg.sessionId === session.sessionId && /Pi mock handled/.test(msg.text || ''),
        8000,
      );
      await client.waitForType('done', (msg) => msg.sessionId === session.sessionId, 8000);
      assert(/turn 1/.test(getLastStoredAssistantText(sessionsDir, session.sessionId) || ''), 'Pi headless fallback should persist the assistant response');

      const spawnLine = findProcessLogLine(logsDir, session.sessionId, 'process_spawn');
      assert(spawnLine.includes('--mode json') && spawnLine.includes('-p'), 'Pi headless fallback should spawn the legacy JSON print mode');
      assert(!spawnLine.includes('"transport":"rpc"'), 'Pi headless fallback must not use the RPC transport');

      const modelList = await client.sendAndWaitType(
        buildAgentMessagePayload({ text: '/model', sessionId: session.sessionId, mode: 'yolo', agent: 'pi' }),
        'model_list',
        (msg) => msg.agent === 'pi',
        5000,
      );
      assert(modelList.source === 'pi-headless', 'Pi headless model menu should identify the compatibility source');
    });
  });
}

async function runPiRpcCapacityRegressionCase({ tempRoot, password }) {
  const caseRoot = path.join(tempRoot, 'pi-rpc-capacity');
  const configDir = path.join(caseRoot, 'config');
  const sessionsDir = path.join(caseRoot, 'sessions');
  const logsDir = path.join(caseRoot, 'logs');
  const homeDir = path.join(caseRoot, 'home');
  for (const dir of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(dir);
  const port = await getFreePort();

  await withServer({
    PORT: String(port),
    HOST: '127.0.0.1',
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    CC_WEB_PI_TRANSPORT: 'rpc',
    CC_WEB_PI_RPC_MAX_RUNTIMES: '1',
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    PI_PATH: MOCK_PI,
  }, async () => {
    const first = await connectAuthedClient(port, password);
    const second = await connectAuthedClient(port, password);
    let firstSessionId = null;
    try {
      const firstSession = await first.client.sendAndWaitType(
        buildAgentMessagePayload({ text: 'trigger pi rpc slow', mode: 'yolo', agent: 'pi' }),
        'session_info',
        (msg) => msg.agent === 'pi' && msg.title === 'trigger pi rpc slow',
      );
      firstSessionId = firstSession.sessionId;
      await first.client.waitForType(
        'text_delta',
        (msg) => msg.sessionId === firstSessionId && /still running/.test(msg.text || ''),
        8000,
      );

      const blockedSession = await second.client.sendAndWaitType(
        buildAgentMessagePayload({ text: 'second pi runtime', mode: 'yolo', agent: 'pi' }),
        'session_info',
        (msg) => msg.agent === 'pi' && msg.title === 'second pi runtime',
      );
      const capacityError = await second.client.waitForType(
        'error',
        (msg) => msg.sessionId === blockedSession.sessionId && /达到上限/.test(msg.message || ''),
        8000,
      );
      assert(/1/.test(capacityError.message || ''), 'Pi RPC capacity error should report the configured limit');
      await second.client.waitForType('done', (msg) => msg.sessionId === blockedSession.sessionId, 8000);

      first.client.send({ type: 'abort' });
      await first.client.waitForType(
        'done',
        (msg) => msg.sessionId === firstSessionId && msg.interrupted === true,
        8000,
      );
      firstSessionId = null;
    } finally {
      if (firstSessionId && first.ws.readyState === WebSocket.OPEN) {
        first.client.send({ type: 'abort' });
        await sleep(100);
      }
      await closeWs(first.ws);
      await closeWs(second.ws);
    }
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

async function runServerRestartRecoveryRegressionCase({ port, password, sessionsDir, serverHandle, serverEnv }) {
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
    const nativeThreadId = getActiveStoredRuntimeId(readStoredSessionFile(sessionsDir, restartSession.sessionId), 'codex');
    assert(nativeThreadId, 'Codex App Server should persist its native thread before restart');

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
      (msg) => msg.sessions.some((session) => session.id === restartSession.sessionId),
      5000,
    );
    assert(recoveredList.sessions.some((session) => session.id === restartSession.sessionId && !session.isRunning), 'Restarted server must not leave an interrupted App Server turn stuck as running');

    recoveredConnection.client.send({ type: 'load_session', sessionId: restartSession.sessionId });
    const loadedRestartSession = await recoveredConnection.client.waitForType(
      'session_info',
      (msg) => msg.sessionId === restartSession.sessionId && msg.isRunning === false,
      5000,
    );
    assert(loadedRestartSession.isRunning === false, 'Interrupted App Server turn should reopen as idle after server restart');
    recoveredConnection.client.send(buildAgentMessagePayload({
      text: 'continue after codex app server restart',
      sessionId: restartSession.sessionId,
      mode: 'yolo',
      agent: 'codex',
    }));
    await recoveredConnection.client.waitForType('text_delta', (msg) => /continue after codex app server restart/.test(msg.text || ''), 8000);
    await recoveredConnection.client.waitForType('done', (msg) => msg.sessionId === restartSession.sessionId, 10000);
    const resumedThreadId = getActiveStoredRuntimeId(readStoredSessionFile(sessionsDir, restartSession.sessionId), 'codex');
    assert(resumedThreadId === nativeThreadId, 'Codex should resume the persisted native thread after a Webcoding server restart');
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
    assert(modelRequests.length >= 2, `Version compatibility regression should hit /v1/models for both explicit fetches, got ${modelRequests.length}`);
    assert(!upstream.requests.some((req) => req.path.includes('/v1/v1/')), 'No fetch_models request should duplicate /v1 in upstream path');
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
      PI_PATH: MOCK_PI,
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
    PI_PATH: MOCK_PI,
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
  const runtimeSettingsPath = path.join(configDir, 'claude-runtime-settings.json');
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
    PI_PATH: MOCK_PI,
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

    const unchangedUserSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert(JSON.stringify(unchangedUserSettings) === JSON.stringify(originalSettings), 'Claude unified mode must not modify the user settings file');
    const unifiedSettings = JSON.parse(fs.readFileSync(runtimeSettingsPath, 'utf8'));
    assert(unifiedSettings.env?.PRESERVE_ME === 'still-here', 'Claude isolated runtime settings should preserve unrelated env keys');
    assert(unifiedSettings.permissions?.allow?.[0] === 'Read(/tmp)', 'Claude isolated runtime settings should preserve unrelated top-level settings');
    assert(unifiedSettings.env?.ANTHROPIC_API_KEY, 'Claude isolated runtime settings should inject the managed API key');
    assert(!unifiedSettings.env?.ANTHROPIC_AUTH_TOKEN, 'Claude isolated runtime settings should replace the local auth token');
    assert(/http:\/\/127\.0\.0\.1:\d+\/anthropic/.test(unifiedSettings.env?.ANTHROPIC_BASE_URL || ''), 'Claude isolated runtime settings should point at the local bridge');
    assert(!fs.existsSync(backupPath), 'Fresh Claude unified mode should not need a user-settings backup');
    const storedCustomRuntimeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeRuntimeSession.sessionId}.json`), 'utf8'));
    firstRuntimeSessionId = storedCustomRuntimeSession.claudeSessionId;
    assert(firstRuntimeSessionId, 'Claude runtime baseline should persist a native Claude session id');
    assert(storedCustomRuntimeSession.claudeRuntimeFingerprint, 'Claude runtime baseline should persist a runtime fingerprint');

    unchangedUserSettings.model = 'custom-temp-model';
    unchangedUserSettings.permissions.allow.push('Write(/tmp/generated)');
    unchangedUserSettings.someUnifiedOnlyField = true;
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(unchangedUserSettings, null, 2));

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
    assert(!fs.existsSync(backupPath), 'Claude isolated settings should not leave a backup file');
    assert(!fs.existsSync(runtimeSettingsPath), 'Switching back to local Claude should remove isolated runtime settings');
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
    PI_PATH: MOCK_PI,
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
    PI_PATH: MOCK_PI,
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
    PI_PATH: MOCK_PI,
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

      const spawnLines = findProcessLogLines(logsDir, session.sessionId, 'codex_app_turn_start');
      const latestSpawnLine = spawnLines[spawnLines.length - 1] || '';
      assert(spawnLines.length >= 2, 'Codex local fingerprint regression should produce at least two App Server turn records');
      assert(latestSpawnLine && latestSpawnLine.includes('"resume":true'), 'Codex local fingerprint change should keep resume on the next run by default');
      assert(latestSpawnLine.includes('"operation":"thread/resume"'), 'Codex local fingerprint change should use thread/resume on the next run');
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
    PI_PATH: MOCK_PI,
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
      const unifiedSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'codex_app_turn_start');
      const unifiedSpawn = unifiedSpawnLines[unifiedSpawnLines.length - 1] || '';
      assert(unifiedSpawn.includes('"resume":false'), 'Codex carryover switch to unified should not resume the old thread');
      assert(unifiedSpawn.includes('"operation":"thread/start"'), 'Codex carryover switch to unified should use thread/start after config change');

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
      const resumedCodexSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'codex_app_turn_start');
      const resumedCodexSpawn = resumedCodexSpawnLines[resumedCodexSpawnLines.length - 1] || '';
      assert(resumedCodexSpawn.includes('"resume":true'), 'Codex carryover unified model change should resume the existing thread');
      assert(resumedCodexSpawn.includes('"operation":"thread/resume"'), 'Codex carryover unified model change should use thread/resume');

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
      const restoredSpawnLines = findProcessLogLines(logsDir, session.sessionId, 'codex_app_turn_start');
      const restoredSpawn = restoredSpawnLines[restoredSpawnLines.length - 1] || '';
      assert(restoredSpawn.includes('"resume":true'), 'Codex carryover switch back to local should resume the original local thread');
      assert(restoredSpawn.includes('"operation":"thread/resume"'), 'Codex carryover switch back to local should use thread/resume');
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
    PI_PATH: MOCK_PI,
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
      const spawnLines = findProcessLogLines(logsDir, session.sessionId, 'codex_app_turn_start');
      const latestSpawnLine = spawnLines[spawnLines.length - 1] || '';
      assert(latestSpawnLine.includes('"resume":true'), 'Codex sticky unified resume should keep resume enabled after channel switch');
      assert(latestSpawnLine.includes('"operation":"thread/resume"'), 'Codex sticky unified resume should use thread/resume after channel switch');
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

    const spawnLine = findProcessLogLine(logsDir, legacySession.sessionId, 'codex_app_turn_start');
    assert(spawnLine && spawnLine.includes('"resume":false'), 'Legacy Codex session should not resume after config migration');
    assert(spawnLine.includes('"operation":"thread/start"'), 'Legacy Codex session should start a new App Server thread after config migration');

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

    const spawnLine = findProcessLogLine(logsDir, session.sessionId, 'codex_app_turn_start');
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

    const spawnLine = findProcessLogLine(logsDir, session.sessionId, 'codex_app_turn_start');
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
    const spawnLine = findProcessLogLine(logsDir, firstMessageSession.sessionId, 'codex_app_turn_start');
    const spawnArgs = spawnLine ? (JSON.parse(spawnLine).args || '') : '';
    const appTurnLog = spawnLine ? JSON.parse(spawnLine) : null;
    assert(appTurnLog?.attachmentCount === 1 && !spawnLine.includes('--search'), 'Codex App Server should receive one local image without unsupported --search flags');
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
    assert(claudeOneMSpawnLine && claudeOneMSpawnLine.includes('claude-sonnet-4-6[1m]'), 'Claude /model Sonnet 1M should honor the configured provider mapping');
    const storedClaudeOneMSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeModelSession.sessionId}.json`), 'utf8'));
    assert(storedClaudeOneMSession.model === 'claude-sonnet-4-6[1m]', 'Claude /model should persist the configured provider mapping');

    for (const inheritedName of ['constructor', '__proto__']) {
      const changed = await client.sendAndWaitType(
        buildAgentMessagePayload({ text: `/model ${inheritedName}`, sessionId: claudeModelSession.sessionId, mode: 'yolo', agent: 'claude' }),
        'model_changed',
        (msg) => msg.model === inheritedName,
      );
      assert(changed.model === inheritedName, `Claude /model should treat ${inheritedName} as a literal custom model name`);
    }
    const storedCustomModelSession = readStoredSessionFile(sessionsDir, claudeModelSession.sessionId);
    assert(storedCustomModelSession.model === '__proto__', 'Claude /model must not resolve inherited object properties as model mappings');

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
    assert(claudeSpawnLine && claudeSpawnLine.includes('--input-format stream-json'), 'Claude image message should use stream-json input');
    const storedClaudeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedClaudeSession.messages?.[0]?.attachments) && storedClaudeSession.messages[0].attachments.length === 1, 'Claude message should persist attachment metadata');
    const claudeSettingsPath = path.join(configDir, 'claude-runtime-settings.json');
    const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    assert(claudeSettings.env?.ANTHROPIC_API_KEY, 'Claude unified runtime should inject ANTHROPIC_API_KEY into isolated settings');
    assert(!claudeSettings.env?.ANTHROPIC_AUTH_TOKEN, 'Claude isolated runtime settings should not contain ANTHROPIC_AUTH_TOKEN');

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
    const piFixture = createFakePiHistory(homeDir);
    const expiredAttachmentFixture = createExpiredAttachmentFixture(sessionsDir);

    const port = await getFreePort();
    const password = 'Regression!234';
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082',
      'hex',
    );
    const claudeEnvCapturePath = path.join(tempRoot, 'claude-env-captures.jsonl');

    const serverEnv = {
      PORT: String(port),
      CC_WEB_PASSWORD: password,
      CC_WEB_CONFIG_DIR: configDir,
      CC_WEB_SESSIONS_DIR: sessionsDir,
      CC_WEB_LOGS_DIR: logsDir,
      HOME: homeDir,
      CLAUDE_PATH: './scripts/mock-claude.js',
      CODEX_PATH: MOCK_CODEX,
      PI_PATH: MOCK_PI,
      PI_CODING_AGENT_SESSION_DIR: '~/pi-native-sessions',
      CC_WEB_PI_TRANSPORT: 'rpc',
      MOCK_CLAUDE_ENV_CAPTURE: claudeEnvCapturePath,
      CC_WEB_CLI_ENV_PASSTHROUGH: 'MOCK_CLAUDE_ENV_CAPTURE',
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
        piFixture,
        expiredAttachmentFixture,
        tinyPng,
        claudeEnvCapturePath,
        serverEnv,
        serverHandle,
      };
      const runner = createTestRunner();
      await runner.run('agent runtime environment passthrough', () => runAgentRuntimeEnvironmentRegressionCase(ctx));
      await runner.run('claude run cost ledger idempotency', () => runClaudeCostLedgerRegressionCase(ctx));
      await runner.run('claude slash probe environment isolation', () => runClaudeSlashProbeEnvironmentRegressionCase(ctx));
      await runner.run('claude persistent stream client lifecycle', () => runClaudeStreamClientLifecycleRegressionCase(ctx));
      await runner.run('codex app server client lifecycle', () => runCodexAppServerClientLifecycleRegressionCase(ctx));
      await runner.run('pi rpc client lifecycle cleanup', () => runPiRpcClientLifecycleRegressionCase(ctx));
      await runner.run('custom CLI directories and server limits', () => runCustomCliDirectoriesRegressionCase(ctx));
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
      await runner.run('http asset and markdown security', () => runHttpSecurityRegressionCase(ctx));
      await runner.run('runtime error mapping', () => runRuntimeErrorRegressionCase(ctx));
      await runner.run('pi agent adapter', () => runPiAgentRegressionCase(ctx));
      await runner.run('pi managed responses runtime', () => runPiManagedRuntimeRegressionCase(ctx));
      await runner.run('pi native import and fork', () => runPiNativeImportAndForkRegressionCase(ctx));
      await runner.run('pi rpc interaction reconnect', () => runPiRpcReconnectRegressionCase(ctx));
      await runner.run('claude and codex interaction reconnect', () => runClaudeCodexInteractionReconnectRegressionCase(ctx));
      await runner.run('pi headless transport fallback', () => runPiHeadlessFallbackRegressionCase(ctx));
      await runner.run('pi rpc configurable capacity', () => runPiRpcCapacityRegressionCase(ctx));
      await runner.run('headless parity interactive and slash', () => runHeadlessParityRegressionCase(ctx));
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
    await cleanupRegressionBridgeProcesses(tempRoot);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
