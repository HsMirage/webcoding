#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PiRpcClient } = require('../lib/pi-rpc-client');

const ROOT = path.resolve(__dirname, '..');

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findExecutableCandidate(filePath) {
  const candidates = [filePath];
  if (process.platform === 'win32' && !path.extname(filePath)) {
    const extensions = String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean);
    candidates.push(...extensions.map((extension) => `${filePath}${extension}`));
  }
  return candidates.find(isExecutable) || null;
}

function resolveCommand(envValue, defaultName) {
  const requested = String(envValue || '').trim();
  if (requested && (path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\'))) {
    const resolved = path.isAbsolute(requested) ? requested : path.resolve(ROOT, requested);
    return findExecutableCandidate(resolved) || requested;
  }
  const name = requested || defaultName;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = findExecutableCandidate(path.join(dir, name));
    if (candidate) return candidate;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  for (const unresolved of [
    path.join(home, '.local', 'bin', name),
    path.join(home, '.volta', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    path.join('/usr/local/bin', name),
    path.join('/opt/homebrew/bin', name),
  ]) {
    const candidate = findExecutableCandidate(unresolved);
    if (candidate) return candidate;
  }
  return name;
}

const CLAUDE = resolveCommand(process.env.CLAUDE_PATH, 'claude');
const CODEX = resolveCommand(process.env.CODEX_PATH, 'codex');
const PI = resolveCommand(process.env.PI_PATH, 'pi');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || 20_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${command} ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function requireHelpTokens(label, help, tokens) {
  for (const token of tokens) {
    assert(help.includes(token), `${label} help is missing required contract token: ${token}`);
  }
}

function readVersion(command) {
  return run(command, ['--version']).trim().split('\n')[0];
}

function checkClaude() {
  const version = readVersion(CLAUDE);
  const help = run(CLAUDE, ['--help']);
  requireHelpTokens('Claude Code', help, [
    '--print',
    '--input-format',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--include-hook-events',
    '--replay-user-messages',
    '--no-session-persistence',
    '--session-id',
    '--resume',
    '--settings',
    '--permission-mode',
    '--effort',
    'low, medium, high, xhigh, max',
    '--bare',
  ]);
  return version;
}

function collectSchemaConstStrings(value, output = new Set()) {
  if (!value || typeof value !== 'object') return output;
  if (typeof value.const === 'string') output.add(value.const);
  if (Array.isArray(value.enum)) {
    for (const item of value.enum) {
      if (typeof item === 'string') output.add(item);
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaConstStrings(item, output);
    return output;
  }
  for (const child of Object.values(value)) collectSchemaConstStrings(child, output);
  return output;
}

function checkSchemaFileContains(schemaDir, relativePath, tokens) {
  const filePath = path.join(schemaDir, relativePath);
  assert(fs.existsSync(filePath), `Codex App Server schema is missing ${relativePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  for (const token of tokens) {
    assert(text.includes(`"${token}"`), `${relativePath} is missing field ${token}`);
  }
}

function checkCodex(tempRoot) {
  const version = readVersion(CODEX);
  const help = run(CODEX, ['app-server', '--help']);
  requireHelpTokens('Codex App Server', help, [
    'generate-json-schema',
    '--listen',
    'stdio://',
  ]);

  const schemaDir = path.join(tempRoot, 'codex-schema');
  fs.mkdirSync(schemaDir, { recursive: true });
  run(CODEX, ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir], { timeout: 30_000 });
  const bundlePath = path.join(schemaDir, 'codex_app_server_protocol.schemas.json');
  assert(fs.existsSync(bundlePath), 'Codex App Server did not generate its protocol schema bundle');
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const constants = collectSchemaConstStrings(bundle);
  for (const method of [
    'thread/start',
    'thread/resume',
    'thread/fork',
    'thread/name/set',
    'thread/settings/update',
    'thread/compact/start',
    'thread/backgroundTerminals/list',
    'thread/backgroundTerminals/terminate',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'review/start',
    'model/list',
    'collaborationMode/list',
    'skills/list',
    'mcpServerStatus/list',
    'account/usage/read',
    'account/rateLimits/read',
    'thread/goal/get',
    'thread/goal/set',
    'thread/goal/clear',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
    'item/tool/call',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
    'currentTime/read',
    'item/plan/delta',
    'turn/plan/updated',
  ]) {
    assert(constants.has(method), `Codex App Server schema is missing method ${method}`);
  }
  checkSchemaFileContains(schemaDir, 'v1/InitializeParams.json', ['clientInfo', 'capabilities']);
  checkSchemaFileContains(schemaDir, 'v2/ThreadForkParams.json', ['threadId', 'cwd', 'model', 'approvalPolicy', 'sandbox']);
  checkSchemaFileContains(schemaDir, 'v2/ThreadSetNameParams.json', ['threadId', 'name']);
  checkSchemaFileContains(schemaDir, 'v2/ThreadSettingsUpdateParams.json', ['threadId', 'personality', 'effort']);
  checkSchemaFileContains(schemaDir, 'v2/ThreadBackgroundTerminalsListParams.json', ['threadId', 'cursor', 'limit']);
  checkSchemaFileContains(schemaDir, 'v2/ThreadBackgroundTerminalsTerminateParams.json', ['threadId', 'processId']);
  checkSchemaFileContains(schemaDir, 'v2/CollaborationModeListResponse.json', ['data', 'mode', 'model', 'reasoning_effort']);
  checkSchemaFileContains(schemaDir, 'v2/SkillsListResponse.json', ['data', 'skills', 'name', 'enabled', 'scope']);
  checkSchemaFileContains(schemaDir, 'v2/ListMcpServerStatusResponse.json', ['data', 'authStatus', 'tools']);
  checkSchemaFileContains(schemaDir, 'v2/ThreadGoalSetParams.json', ['threadId', 'objective', 'status', 'tokenBudget']);
  checkSchemaFileContains(schemaDir, 'v2/TurnStartParams.json', ['threadId', 'input', 'cwd', 'model', 'approvalPolicy', 'sandboxPolicy', 'collaborationMode', 'effort']);
  checkSchemaFileContains(schemaDir, 'v2/ModelListResponse.json', ['defaultReasoningEffort', 'supportedReasoningEfforts', 'reasoningEffort']);
  checkSchemaFileContains(schemaDir, 'v2/TurnSteerParams.json', ['threadId', 'expectedTurnId', 'input']);
  checkSchemaFileContains(schemaDir, 'CommandExecutionRequestApprovalParams.json', ['availableDecisions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments']);
  checkSchemaFileContains(schemaDir, 'ToolRequestUserInputParams.json', ['questions', 'isOther', 'isSecret']);
  checkSchemaFileContains(schemaDir, 'McpServerElicitationRequestParams.json', ['requestedSchema', 'elicitationId', 'url']);
  checkSchemaFileContains(schemaDir, 'McpServerElicitationRequestResponse.json', ['action', 'content']);
  checkSchemaFileContains(schemaDir, 'DynamicToolCallParams.json', ['threadId', 'turnId', 'callId', 'tool', 'arguments']);
  checkSchemaFileContains(schemaDir, 'DynamicToolCallResponse.json', ['success', 'contentItems']);
  checkSchemaFileContains(schemaDir, 'CurrentTimeReadResponse.json', ['currentTimeAt']);
  checkSchemaFileContains(schemaDir, 'v2/PlanDeltaNotification.json', ['threadId', 'turnId', 'itemId', 'delta']);
  checkSchemaFileContains(schemaDir, 'v2/TurnPlanUpdatedNotification.json', ['threadId', 'turnId', 'explanation', 'plan']);
  checkSchemaFileContains(schemaDir, 'v2/ServerRequestResolvedNotification.json', ['requestId', 'threadId']);
  return version;
}

async function waitForExit(client, timeoutMs = 4000) {
  const child = client?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function checkPi(tempRoot) {
  const version = readVersion(PI);
  const help = run(PI, ['--help']);
  requireHelpTokens('Pi', help, [
    '--mode <mode>',
    'rpc',
    '--session-id',
    '--session-dir',
    '--fork',
    '--provider',
    '--model',
    '--thinking',
    '--approve',
    '--no-approve',
    '--extension',
    '--skill',
    '--prompt-template',
    '--theme',
    '--offline',
  ]);

  const agentDir = path.join(tempRoot, 'pi-agent');
  const sessionDir = path.join(tempRoot, 'pi-sessions');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProjectTrust: 'never',
    enableInstallTelemetry: false,
  }, null, 2));

  const client = new PiRpcClient({
    command: PI,
    args: [
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--session-id', crypto.randomUUID(),
      '--no-approve',
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
    ],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    },
    cwd: ROOT,
  });
  try {
    await client.start();
    let state = (await client.request({ type: 'get_state' })).data;
    assert(state && typeof state.sessionId === 'string' && state.sessionId, 'Pi RPC get_state did not return a session id');
    assert(typeof state.sessionFile === 'string' && state.sessionFile, 'Pi RPC get_state did not return a session file');
    const bashResponse = await client.request({ type: 'bash', command: 'printf webcoding-pi-contract' });
    assert(bashResponse?.success === true, 'Pi RPC rejected local bash contract probe');
    state = (await client.request({ type: 'get_state' })).data;
    const entryResponse = await client.request({ type: 'get_entries' });
    const nativeEntries = Array.isArray(entryResponse.data?.entries) ? entryResponse.data.entries : [];
    assert(nativeEntries.length > 0, 'Pi RPC local bash probe did not create a native session entry');
    fs.writeFileSync(state.sessionFile, `${[
      { type: 'session', version: 3, id: state.sessionId, timestamp: new Date().toISOString(), cwd: ROOT },
      ...nativeEntries,
    ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    for (const command of [
      { type: 'get_available_models' },
      { type: 'get_commands' },
      { type: 'get_entries' },
      { type: 'get_tree' },
      { type: 'get_fork_messages' },
      { type: 'get_session_stats' },
      { type: 'set_thinking_level', level: 'high' },
      { type: 'set_steering_mode', mode: 'all' },
      { type: 'set_follow_up_mode', mode: 'all' },
    ]) {
      const response = await client.request(command);
      assert(response?.success === true, `Pi RPC rejected ${command.type}`);
    }
    state = (await client.request({ type: 'get_state' })).data;
    assert(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(state?.thinkingLevel),
      'Pi RPC returned an invalid thinking level after set_thinking_level',
    );

    const cloneResponse = await client.request({ type: 'clone' });
    assert(cloneResponse?.success === true && cloneResponse.data?.cancelled !== true, 'Pi RPC rejected clone');
    const clonedState = (await client.request({ type: 'get_state' })).data;
    assert(clonedState?.sessionId && clonedState.sessionId !== state.sessionId, 'Pi RPC clone did not create a distinct native session');

    const switchResponse = await client.request({ type: 'switch_session', sessionPath: state.sessionFile });
    assert(switchResponse?.success === true && switchResponse.data?.cancelled !== true, 'Pi RPC rejected switch_session');
    const restoredState = (await client.request({ type: 'get_state' })).data;
    assert(restoredState?.sessionId === state.sessionId, 'Pi RPC switch_session did not restore the source session');

    const newSessionResponse = await client.request({ type: 'new_session', parentSession: state.sessionFile });
    assert(newSessionResponse?.success === true, 'Pi RPC rejected new_session');
    const newState = (await client.request({ type: 'get_state' })).data;
    assert(newState?.sessionId && newState.sessionId !== state.sessionId, 'Pi RPC new_session did not create a distinct native session');
  } finally {
    client.dispose();
    await waitForExit(client);
  }
  return version;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webcoding-cli-contract-'));
  try {
    const claudeVersion = checkClaude();
    const codexVersion = checkCodex(tempRoot);
    const piVersion = await checkPi(tempRoot);
    console.log(`ok - Claude Code contract (${claudeVersion})`);
    console.log(`ok - Codex App Server contract (${codexVersion})`);
    console.log(`ok - Pi RPC contract (${piVersion})`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
