const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { createAgentRuntime } = require('./lib/agent-runtime');
const { createCodexRolloutStore } = require('./lib/codex-rollouts');
const { getStaticHeadlessCapabilities } = require('./lib/runtime-capabilities');
const { PiRpcClient } = require('./lib/pi-rpc-client');
const { getPiSessionFiles, parsePiSessionFile, summarizePiSessionFile } = require('./lib/pi-sessions');
const { CodexAppServerClient } = require('./lib/codex-app-server-client');
const { ClaudeStreamClient } = require('./lib/claude-stream-client');
const PACKAGE_VERSION = require('./package.json').version || 'unknown';

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = String(m[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
      val = val.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = val;
  }
}

const PORT = parseInt(process.env.PORT) || 8001;
const HOST = String(process.env.HOST || '').trim() || '0.0.0.0';
const DEFAULT_WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const requestedWsMaxPayload = Number.parseInt(process.env.CC_WEB_WS_MAX_PAYLOAD || '', 10);
const WS_MAX_PAYLOAD_BYTES = Number.isFinite(requestedWsMaxPayload) && requestedWsMaxPayload > 0
  ? Math.min(Math.max(requestedWsMaxPayload, 64 * 1024), 32 * 1024 * 1024)
  : DEFAULT_WS_MAX_PAYLOAD_BYTES;
const PI_TRANSPORT = String(process.env.CC_WEB_PI_TRANSPORT || 'rpc').trim().toLowerCase() === 'headless'
  ? 'headless'
  : 'rpc';
const CODEX_TRANSPORT = String(process.env.CC_WEB_CODEX_TRANSPORT || 'app-server').trim().toLowerCase() === 'exec'
  ? 'exec'
  : 'app-server';
const CLAUDE_TRANSPORT = String(process.env.CC_WEB_CLAUDE_TRANSPORT || 'stream-json').trim().toLowerCase() === 'headless'
  ? 'headless'
  : 'stream-json';
const requestedPiRpcIdleMinutes = Number.parseInt(process.env.CC_WEB_PI_RPC_IDLE_TIMEOUT_MINUTES || '', 10);
const PI_RPC_IDLE_TIMEOUT_MINUTES = Number.isFinite(requestedPiRpcIdleMinutes) && requestedPiRpcIdleMinutes > 0
  ? Math.min(Math.max(requestedPiRpcIdleMinutes, 1), 24 * 60)
  : 30;
const PI_RPC_IDLE_TIMEOUT_MS = PI_RPC_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const requestedMaxPiRpcRuntimes = Number.parseInt(process.env.CC_WEB_PI_RPC_MAX_RUNTIMES || '', 10);
const MAX_PI_RPC_RUNTIMES = Number.isFinite(requestedMaxPiRpcRuntimes) && requestedMaxPiRpcRuntimes > 0
  ? Math.min(Math.max(requestedMaxPiRpcRuntimes, 1), 64)
  : 8;
const requestedCodexAppIdleMinutes = Number.parseInt(process.env.CC_WEB_CODEX_APP_IDLE_TIMEOUT_MINUTES || '', 10);
const CODEX_APP_IDLE_TIMEOUT_MINUTES = Number.isFinite(requestedCodexAppIdleMinutes) && requestedCodexAppIdleMinutes > 0
  ? Math.min(Math.max(requestedCodexAppIdleMinutes, 1), 24 * 60)
  : 30;
const CODEX_APP_IDLE_TIMEOUT_MS = CODEX_APP_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const requestedMaxCodexAppRuntimes = Number.parseInt(process.env.CC_WEB_CODEX_APP_MAX_RUNTIMES || '', 10);
const MAX_CODEX_APP_RUNTIMES = Number.isFinite(requestedMaxCodexAppRuntimes) && requestedMaxCodexAppRuntimes > 0
  ? Math.min(Math.max(requestedMaxCodexAppRuntimes, 1), 64)
  : 8;
const requestedClaudeStreamIdleMinutes = Number.parseInt(process.env.CC_WEB_CLAUDE_STREAM_IDLE_TIMEOUT_MINUTES || '', 10);
const CLAUDE_STREAM_IDLE_TIMEOUT_MINUTES = Number.isFinite(requestedClaudeStreamIdleMinutes) && requestedClaudeStreamIdleMinutes > 0
  ? Math.min(Math.max(requestedClaudeStreamIdleMinutes, 1), 24 * 60)
  : 30;
const CLAUDE_STREAM_IDLE_TIMEOUT_MS = CLAUDE_STREAM_IDLE_TIMEOUT_MINUTES * 60 * 1000;
const requestedMaxClaudeStreamRuntimes = Number.parseInt(process.env.CC_WEB_CLAUDE_STREAM_MAX_RUNTIMES || '', 10);
const MAX_CLAUDE_STREAM_RUNTIMES = Number.isFinite(requestedMaxClaudeStreamRuntimes) && requestedMaxClaudeStreamRuntimes > 0
  ? Math.min(Math.max(requestedMaxClaudeStreamRuntimes, 1), 64)
  : 8;

/**
 * Resolve a CLI binary path robustly.
 * Parent shells / IDE launchers sometimes set CLAUDE_PATH to a stale absolute path
 * (e.g. missing ~/.volta/bin/claude) while the real binary lives in ~/.local/bin.
 */
function isExecutablePath(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    const st = fs.statSync(filePath);
    // Accept regular files and symlinks-to-files (stat follows links).
    if (!st.isFile()) return false;
    // On Windows, X_OK is unreliable; existence is enough for spawn.
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichOnPath(commandName, pathEnv = process.env.PATH) {
  const name = String(commandName || '').trim();
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const dirs = String(pathEnv || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean))
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + (ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ''));
      if (isExecutablePath(candidate)) return candidate;
    }
  }
  return null;
}

function resolveCliBinary(envValue, defaultName, extraCandidates = []) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const requested = String(envValue || '').trim() || defaultName;
  const baseName = path.basename(requested.replace(/\\/g, '/')) || defaultName;
  const requestedHasPath = path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  const candidates = [];

  // 1) Explicit env value (absolute or relative path)
  if (requested) {
    candidates.push(path.isAbsolute(requested)
      ? requested
      : requestedHasPath
        ? path.resolve(__dirname, requested)
        : requested);
  }

  // 2) Well-known install locations (Claude Code installer uses ~/.local/bin)
  if (home) {
    candidates.push(
      path.join(home, '.local', 'bin', baseName),
      path.join(home, '.volta', 'bin', baseName),
      path.join(home, '.npm-global', 'bin', baseName),
      path.join(home, '.yarn', 'bin', baseName),
      path.join(home, '.cargo', 'bin', baseName),
    );
  }
  candidates.push(
    path.join('/usr/local/bin', baseName),
    path.join('/opt/homebrew/bin', baseName),
  );
  for (const extra of extraCandidates) {
    if (extra) candidates.push(extra);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : null;
    // Absolute candidates: check existence
    if (resolved) {
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (isExecutablePath(resolved)) {
        if (requested !== resolved && requestedHasPath) {
          // Stale absolute env path — fall through quietly, log later at boot.
        }
        return resolved;
      }
      continue;
    }
  }

  // 3) Search PATH for bare command name
  const fromPath = whichOnPath(baseName, process.env.PATH);
  if (fromPath) return fromPath;

  // 4) Keep bare name so spawn can still try (and surface a clear ENOENT)
  return baseName;
}

// Prefer env when valid; otherwise recover common real install locations.
const CLAUDE_PATH = resolveCliBinary(process.env.CLAUDE_PATH, 'claude');
const CODEX_PATH = resolveCliBinary(process.env.CODEX_PATH, 'codex');
const PI_PATH = resolveCliBinary(process.env.PI_PATH, 'pi');
const CONFIG_DIR = process.env.CC_WEB_CONFIG_DIR || path.join(__dirname, 'config');
const SESSIONS_DIR = process.env.CC_WEB_SESSIONS_DIR || path.join(__dirname, 'sessions');
const PUBLIC_DIR = process.env.CC_WEB_PUBLIC_DIR || path.join(__dirname, 'public');
const LOGS_DIR = process.env.CC_WEB_LOGS_DIR || path.join(__dirname, 'logs');
const ATTACHMENTS_DIR = path.join(SESSIONS_DIR, '_attachments');
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 4;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const NOTIFY_CONFIG_PATH = path.join(CONFIG_DIR, 'notify.json');
const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'auth.json');
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_DIR, 'codex.json');
const PI_CONFIG_PATH = path.join(CONFIG_DIR, 'pi.json');
const PROJECTS_CONFIG_PATH = path.join(CONFIG_DIR, 'projects.json');
const BRIDGE_RUNTIME_PATH = path.join(CONFIG_DIR, 'bridge-runtime.json');
const BRIDGE_STATE_PATH = path.join(CONFIG_DIR, 'bridge-state.json');
const TUNNEL_STATE_PATH = path.join(CONFIG_DIR, 'tunnel-state.json');
const TUNNEL_SCRIPT_PATH = path.join(__dirname, 'lib', 'cf-tunnel.js');
const TUNNEL_START_TIMEOUT_MS = 30000;
const CLAUDE_SETTINGS_BACKUP_PATH = path.join(CONFIG_DIR, 'claude-settings-backup.json');
const CLAUDE_RUNTIME_SETTINGS_PATH = path.join(CONFIG_DIR, 'claude-runtime-settings.json');
const BRIDGE_SCRIPT_PATH = path.join(__dirname, 'lib', 'local-api-bridge.js');
const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);
const USER_HOME = process.env.HOME || process.env.USERPROFILE || '';
const BROWSE_ROOTS = USER_HOME ? [path.resolve(USER_HOME)] : [path.resolve(process.cwd())];
const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_TOKEN_CLEANUP_MS = 60 * 60 * 1000;
const HISTORY_CHUNK_BUFFER_LIMIT = 512 * 1024;
const HISTORY_CHUNK_RETRY_MS = 16;
const ATTACHMENT_CLEANUP_THROTTLE_MS = 30 * 60 * 1000;
const BRIDGE_START_TIMEOUT_MS = 5000;
const HTTP_BODY_MAX_BYTES = 2 * 1024 * 1024;
const AUTH_LOCK_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;
const MAX_AUTO_COMPACT_RETRIES = 2;
const SESSION_LIST_CACHE_TTL_MS = 300;
const FILE_TAIL_DEBOUNCE_MS = 40;
const FILE_TAIL_MAX_READ_BYTES = 8 * 1024 * 1024;
const IMPORTED_SESSION_IDS_CACHE_TTL_MS = 2000;
const JSONL_HEAD_READ_BYTES = 128 * 1024;
const JSONL_TAIL_READ_BYTES = 128 * 1024;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; script-src 'self' https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; frame-ancestors 'none'; base-uri 'none'",
};

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const jsonConfigCache = new Map();
const authAttemptByIp = new Map();

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function readCachedJsonConfig(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    const cached = jsonConfigCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cloneJson(cached.value);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    jsonConfigCache.set(filePath, { mtimeMs: stat.mtimeMs, value: cloneJson(parsed) });
    return cloneJson(parsed);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function writeCachedJsonConfig(filePath, value) {
  writeJsonAtomic(filePath, value);
  try {
    const stat = fs.statSync(filePath);
    jsonConfigCache.set(filePath, { mtimeMs: stat.mtimeMs, value: cloneJson(value) });
  } catch {
    jsonConfigCache.set(filePath, { mtimeMs: null, value: cloneJson(value) });
  }
}

function deleteCachedJsonConfig(filePath) {
  jsonConfigCache.delete(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function writeHeadWithSecurity(res, statusCode, headers = {}) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
}

// === Process Lifecycle Logger ===
const LOG_FILE = path.join(LOGS_DIR, 'process.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024; // 2MB per file

function plog(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    // Simple rotation: if file > 2MB, rename to .old and start fresh
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > LOG_MAX_SIZE) {
        const oldFile = LOG_FILE.replace('.log', '.old.log');
        try { fs.unlinkSync(oldFile); } catch {}
        fs.renameSync(LOG_FILE, oldFile);
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// === Notification System ===
function loadNotifyConfig() {
  const cached = readCachedJsonConfig(NOTIFY_CONFIG_PATH);
  if (cached) return cached;
  // First run: migrate from .env PUSHPLUS_TOKEN
  const token = process.env.PUSHPLUS_TOKEN || '';
  const config = {
    provider: token ? 'pushplus' : 'off',
    pushplus: { token },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
  };
  saveNotifyConfig(config);
  return config;
}

function saveNotifyConfig(config) {
  writeCachedJsonConfig(NOTIFY_CONFIG_PATH, config);
}

function maskToken(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function validateFeishuWebhook(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: '飞书 Webhook 必须使用 HTTPS' };
    }
    const host = parsed.hostname.toLowerCase();
    const hostAllowed = host === 'feishu.cn'
      || host.endsWith('.feishu.cn')
      || host === 'larksuite.com'
      || host.endsWith('.larksuite.com');
    if (!hostAllowed) {
      return { ok: false, error: '飞书 Webhook 域名不合法' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '飞书 Webhook URL 无效' };
  }
}

function getNotifyConfigMasked() {
  const config = loadNotifyConfig();
  return {
    provider: config.provider,
    pushplus: { token: maskToken(config.pushplus?.token) },
    telegram: { botToken: maskToken(config.telegram?.botToken), chatId: config.telegram?.chatId || '' },
    serverchan: { sendKey: maskToken(config.serverchan?.sendKey) },
    feishu: { webhook: maskToken(config.feishu?.webhook) },
    qqbot: { qmsgKey: maskToken(config.qqbot?.qmsgKey) },
  };
}

function sendNotification(title, content) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') return Promise.resolve({ ok: true, skipped: true });

  return new Promise((resolve) => {
    let url, data;
    let isFormData = false;
    switch (config.provider) {
      case 'pushplus': {
        if (!config.pushplus?.token) return resolve({ ok: false, error: 'PushPlus token 未配置' });
        url = 'https://www.pushplus.plus/send';
        data = JSON.stringify({ token: config.pushplus.token, title, content, template: 'txt' });
        break;
      }
      case 'telegram': {
        if (!config.telegram?.botToken || !config.telegram?.chatId) return resolve({ ok: false, error: 'Telegram botToken 或 chatId 未配置' });
        url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        data = JSON.stringify({ chat_id: config.telegram.chatId, text: `${title}\n\n${content}` });
        break;
      }
      case 'serverchan': {
        if (!config.serverchan?.sendKey) return resolve({ ok: false, error: 'Server酱 sendKey 未配置' });
        url = `https://sctapi.ftqq.com/${config.serverchan.sendKey}.send`;
        data = JSON.stringify({ title, desp: content });
        break;
      }
      case 'feishu': {
        if (!config.feishu?.webhook) return resolve({ ok: false, error: '飞书 Webhook 未配置' });
        const feishuValidation = validateFeishuWebhook(config.feishu.webhook);
        if (!feishuValidation.ok) return resolve({ ok: false, error: feishuValidation.error });
        url = config.feishu.webhook;
        data = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${content}` } });
        break;
      }
      case 'qqbot': {
        if (!config.qqbot?.qmsgKey) return resolve({ ok: false, error: 'Qmsg Key 未配置' });
        url = `https://qmsg.zendee.cn/send/${config.qqbot.qmsgKey}`;
        data = `msg=${encodeURIComponent(`${title}\n\n${content}`)}`;
        isFormData = true;
        break;
      }
      default:
        return resolve({ ok: false, error: `未知通知方式: ${config.provider}` });
    }

    const parsed = new URL(url);
    const contentType = isFormData ? 'application/x-www-form-urlencoded' : 'application/json';
    const reqOptions = {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(parsed, reqOptions, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        plog('INFO', 'notify_response', { provider: config.provider, status: res.statusCode, body: body.slice(0, 200) });
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (e) => {
      plog('WARN', 'notify_error', { provider: config.provider, error: e.message });
      resolve({ ok: false, error: e.message });
    });
    req.setTimeout(10000, () => req.destroy(new Error('notification timeout')));
    req.write(data);
    req.end();
  });
}

// Load config on startup (ensures migration)
loadNotifyConfig();

// === Auth Config ===
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, PASSWORD_HASH_BYTES).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function isPasswordHashFormat(stored) {
  const parts = String(stored || '').split(':');
  return parts.length === 3 && parts[0] === 'scrypt' && parts[1] && /^[a-f0-9]+$/i.test(parts[2]);
}

function verifyPasswordHash(password, stored) {
  if (!isPasswordHashFormat(stored)) return false;
  try {
    const [, salt, expectedHex] = String(stored).split(':');
    const derivedHex = crypto.scryptSync(String(password || ''), salt, PASSWORD_HASH_BYTES).toString('hex');
    return timingSafeStringEqual(derivedHex, expectedHex);
  } catch {
    return false;
  }
}

function normalizeAuthConfig(raw) {
  const mustChange = !!raw?.mustChange;
  if (isPasswordHashFormat(raw?.passwordHash)) {
    return { passwordHash: String(raw.passwordHash), mustChange };
  }
  if (typeof raw?.password === 'string' && raw.password) {
    return { passwordHash: hashPassword(raw.password), mustChange };
  }
  return null;
}

function loadAuthConfig() {
  // Priority 1: config/auth.json exists
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const rawConfig = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
      const normalized = normalizeAuthConfig(rawConfig);
      if (normalized) {
        if (!isPasswordHashFormat(rawConfig?.passwordHash) || rawConfig?.password) {
          saveAuthConfig(normalized);
          plog('INFO', 'auth_password_migrated_to_hash', {});
        }
        return normalized;
      }
    }
  } catch {}

  // Priority 2: .env has CC_WEB_PASSWORD → migrate
  const envPw = process.env.CC_WEB_PASSWORD;
  if (envPw && envPw !== 'changeme') {
    const config = { passwordHash: hashPassword(envPw), mustChange: false };
    saveAuthConfig(config);
    return config;
  }

  // Priority 3: Generate random password
  const pw = generateRandomPassword(12);
  const config = { passwordHash: hashPassword(pw), mustChange: true };
  saveAuthConfig(config);
  console.log('========================================');
  console.log('  自动生成初始密码: ' + pw);
  console.log('  首次登录后将要求修改密码');
  console.log('========================================');
  return config;
}

function saveAuthConfig(config) {
  const normalized = normalizeAuthConfig(config);
  if (!normalized) return;
  writeCachedJsonConfig(AUTH_CONFIG_PATH, normalized);
}

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) {
    return { valid: false, message: '密码长度至少 8 位' };
  }
  let types = 0;
  if (/[a-z]/.test(pw)) types++;
  if (/[A-Z]/.test(pw)) types++;
  if (/[0-9]/.test(pw)) types++;
  if (/[^a-zA-Z0-9]/.test(pw)) types++;
  if (types < 2) {
    return { valid: false, message: '密码需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
  }
  return { valid: true, message: '' };
}

let authConfig = loadAuthConfig();
let PASSWORD_HASH = authConfig.passwordHash || '';

const activeTokens = new Map();

function timingSafeStringEqual(left, right) {
  const leftBuf = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuf = Buffer.from(String(right ?? ''), 'utf8');
  const maxLen = Math.max(leftBuf.length, rightBuf.length, 1);
  const paddedLeft = Buffer.alloc(maxLen);
  const paddedRight = Buffer.alloc(maxLen);
  leftBuf.copy(paddedLeft);
  rightBuf.copy(paddedRight);
  return crypto.timingSafeEqual(paddedLeft, paddedRight) && leftBuf.length === rightBuf.length;
}

function hasConfiguredPassword() {
  return !!PASSWORD_HASH;
}

function verifyConfiguredPassword(inputPassword) {
  if (!hasConfiguredPassword()) return false;
  return verifyPasswordHash(inputPassword, PASSWORD_HASH);
}

function getWsClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'unknown';
}

function getAuthLockState(ip, now = Date.now()) {
  const state = authAttemptByIp.get(ip);
  if (!state) return { locked: false, remainingMs: 0, count: 0 };
  if (state.lockedUntil && state.lockedUntil > now) {
    return { locked: true, remainingMs: state.lockedUntil - now, count: state.count || 0 };
  }
  if (state.lockedUntil && state.lockedUntil <= now) {
    authAttemptByIp.delete(ip);
  }
  return { locked: false, remainingMs: 0, count: 0 };
}

function clearAuthFailures(ip) {
  if (!ip) return;
  authAttemptByIp.delete(ip);
}

function recordAuthFailure(ip, now = Date.now()) {
  const prev = authAttemptByIp.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  const count = (prev.firstAt + AUTH_LOCK_WINDOW_MS < now) ? 1 : (prev.count + 1);
  const firstAt = (prev.firstAt + AUTH_LOCK_WINDOW_MS < now) ? now : prev.firstAt;
  const lockedUntil = count >= AUTH_MAX_FAILURES ? now + AUTH_LOCK_WINDOW_MS : 0;
  const next = { count, firstAt, lockedUntil };
  authAttemptByIp.set(ip, next);
  return {
    locked: lockedUntil > now,
    remainingMs: lockedUntil > now ? (lockedUntil - now) : 0,
    count,
  };
}

function rememberActiveToken(token, now = Date.now()) {
  if (!token) return null;
  activeTokens.set(token, now + AUTH_TOKEN_TTL_MS);
  return token;
}

function hasActiveToken(token, now = Date.now()) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    activeTokens.delete(token);
    return false;
  }
  activeTokens.set(token, now + AUTH_TOKEN_TTL_MS);
  return true;
}

function cleanupExpiredTokens(now = Date.now()) {
  for (const [token, expiresAt] of activeTokens) {
    if (expiresAt <= now) activeTokens.delete(token);
  }
}

function cleanupAuthAttempts(now = Date.now()) {
  for (const [ip, state] of authAttemptByIp) {
    if (!state) {
      authAttemptByIp.delete(ip);
      continue;
    }
    const expired = state.lockedUntil ? state.lockedUntil <= now : (state.firstAt + AUTH_LOCK_WINDOW_MS <= now);
    if (expired) authAttemptByIp.delete(ip);
  }
}

function clearPendingSlashCommand(sessionId, expected) {
  const current = pendingSlashCommands.get(sessionId);
  if (!current) return;
  if (!expected || current === expected) pendingSlashCommands.delete(sessionId);
}

// Pending slash command metadata: sessionId -> { kind: string }
const pendingSlashCommands = new Map();

// Slash commands cache: per-agent discovered commands from CLI init events
const SLASH_COMMAND_DESCRIPTIONS = {
  // Webcoding platform commands (server-side handled)
  model: '查看/切换模型（Webcoding 平台）',
  effort: '查看/切换推理强度（Webcoding 平台）',
  thinking: '查看/切换 Pi 思考级别（Webcoding 平台）',
  mode: '查看/切换权限模式（Webcoding 平台）',
  compact: '压缩上下文（Webcoding 平台）',
  'web-help': '显示 Webcoding 平台帮助与已发现的斜杠命令',
  // Claude CLI native commands
  clear: '清除当前会话（含上下文）',
  cost: '查看会话费用/统计',
  help: '显示 CLI 帮助',
  debug: '调试模式',
  simplify: '精简代码',
  batch: '批量处理',
  review: '代码审查',
  'security-review': '安全审查',
  init: '初始化项目',
  context: '查看上下文',
  heapdump: '堆内存快照',
  insights: '洞察分析',
  goal: '设置目标条件（/goal <条件>）',
  usage: '查看用量',
  'reload-skills': '重新加载 skills',
  run: '运行 skill',
  verify: '验证结果',
  'team-onboarding': '团队引导',
  // Claude skills (user-installed) — descriptions are best-effort; new skills show their raw name
  'update-config': '更新配置',
  loop: '循环执行',
  'claude-api': 'Claude API 开发',
  'web-access': '联网访问',
  opencli: 'OpenCLI 社交操作',
  'frontend-design': '前端设计',
  // Claude plugin commands
  'claude-hud:setup': '配置 HUD 状态栏',
  'claude-hud:configure': '配置 HUD 显示',
  'ralph-loop:help': 'Ralph Loop 帮助',
  'ralph-loop:cancel-ralph': '取消 Ralph Loop',
  'ralph-loop:ralph-loop': '启动 Ralph Loop',
  // Codex CLI built-in interactive commands
  status: '查看当前模型、审批和 Token 使用量',
  fork: '分支当前对话到新线程',
  new: '开始新的对话',
  feedback: '发送反馈日志给维护者',
  mcp: '列出已配置的 MCP 工具',
  permissions: '控制 Codex 何时请求确认',
  personality: '自定义 Codex 的沟通风格',
  rename: '重命名线程',
  skills: '列出可用技能',
  statusline: '配置状态栏显示内容',
  ide: '把当前 IDE 上下文加入下一条提示',
  keymap: '配置 TUI 快捷键',
  vim: '切换 TUI Vim 编辑模式',
  'setup-default-sandbox': '配置 Windows 提升权限沙箱',
  'sandbox-add-read-dir': '为 Windows 沙箱增加可读目录',
  agent: '切换当前子 Agent 线程',
  subagents: '查看或切换子 Agent 线程',
  apps: '浏览可用 Apps / Connectors',
  plugins: '浏览和管理插件',
  hooks: '查看和管理生命周期 Hooks',
  archive: '归档当前线程',
  delete: '永久删除当前线程',
  copy: '复制最近一条 Codex 回复',
  diff: '查看当前 Git 变更',
  exit: '退出 Codex TUI',
  quit: '退出 Codex TUI',
  experimental: '配置实验功能',
  approve: '重试最近一次被自动审查拒绝的操作',
  memories: '配置 Codex Memories',
  import: '导入外部 Agent 配置与历史',
  logout: '退出 Codex 登录',
  mention: '把文件或目录加入下一条提示',
  fast: '切换支持模型的 Fast 服务层级',
  plan: '切换 Plan 模式',
  ps: '查看当前线程的后台终端',
  stop: '停止当前线程的后台终端',
  app: '在 ChatGPT 桌面应用中继续当前线程',
  side: '开启不打断主线程的临时对话',
  btw: '开启不打断主线程的临时对话',
  raw: '切换 TUI 原始滚动模式',
  resume: '恢复已保存的 Codex 线程',
  'debug-config': '显示 Codex 配置层与策略诊断',
  title: '配置终端窗口标题',
  theme: '选择 TUI 代码高亮主题',
  pets: '选择或隐藏 TUI Pet',
  pet: '选择或隐藏 TUI Pet',
  // Codex skills (user-installed) — discovered at runtime from ~/.codex/skills/
  imagegen: 'AI 图像生成',
  'openai-docs': 'OpenAI 官方文档查询',
  'plugin-creator': '创建 Codex 插件',
  'skill-creator': '创建 Codex 技能',
  'skill-installer': '安装 Codex 技能',
  pdf: 'PDF 文件处理',
  slides: 'PowerPoint 演示文稿',
  spreadsheets: 'Excel 电子表格',
  'computer-use': 'macOS 桌面控制',
};

/** Codex slash commands whose interactive TUI surface has no Web/App Server equivalent. */
const CODEX_TUI_ONLY_COMMANDS = new Set([
  'ide', 'keymap', 'vim', 'setup-default-sandbox', 'sandbox-add-read-dir',
  'agent', 'subagents', 'apps', 'plugins', 'hooks', 'clear', 'archive', 'delete', 'copy', 'diff',
  'exit', 'quit', 'experimental', 'approve', 'memories', 'import', 'feedback', 'init', 'logout',
  'mcp', 'mention', 'fast', 'plan', 'goal', 'permissions', 'personality', 'ps', 'stop',
  'fork', 'new', 'app', 'side', 'btw', 'raw', 'resume', 'rename', 'skills', 'status', 'usage',
  'debug-config', 'statusline', 'title', 'theme', 'pets', 'pet',
]);
const CODEX_APP_PLATFORM_COMMANDS = new Set([
  'fork', 'new', 'permissions', 'personality', 'rename', 'status', 'usage', 'ps', 'stop',
  'mcp', 'skills', 'goal',
]);
const PI_RPC_PLATFORM_COMMANDS = new Set(['fork', 'clone', 'thinking']);
const PI_RPC_PLATFORM_SLASH_COMMANDS = [
  { name: 'fork', desc: '从当前 Pi 活动分支创建新的 Web 会话' },
  { name: 'clone', desc: '复制当前 Pi 活动分支到新的 Web 会话' },
  { name: 'thinking', desc: SLASH_COMMAND_DESCRIPTIONS.thinking },
];

/** Platform-handled slash commands (not CLI passthrough). */
const PLATFORM_SLASH_COMMANDS = [
  { name: 'model', desc: SLASH_COMMAND_DESCRIPTIONS.model },
  { name: 'effort', desc: SLASH_COMMAND_DESCRIPTIONS.effort },
  { name: 'mode', desc: SLASH_COMMAND_DESCRIPTIONS.mode },
  { name: 'compact', desc: SLASH_COMMAND_DESCRIPTIONS.compact },
  { name: 'web-help', desc: SLASH_COMMAND_DESCRIPTIONS['web-help'] },
];

/** Honest labels for Webcoding permission modes (match actual CLI flags). */
const PERMISSION_MODE_META = {
  yolo: {
    label: 'YOLO',
    short: '跳过审批与沙箱限制',
    claude: 'Claude: --permission-mode bypassPermissions',
    codex: 'Codex: approvalPolicy=never + danger-full-access',
    pi: 'Pi: --approve（信任项目本地扩展/技能）',
  },
  default: {
    label: '默认',
    short: '受限写入；支持时在网页中请求审批',
    claude: 'Claude: 默认权限模式；stream-json 支持网页审批',
    codex: 'Codex: App Server on-request + workspace-write',
    pi: 'Pi: --no-approve（忽略项目本地文件自动信任）',
  },
  plan: {
    label: 'Plan',
    short: '规划/只读模式（按当前 Agent 原生能力映射）',
    claude: 'Claude: --permission-mode plan',
    codex: 'Codex: Plan 协作模式 + read-only 沙箱',
    pi: 'Pi: --tools read,grep,find,ls（只读工具集）',
  },
};

function agentDisplayName(agent) {
  const normalized = normalizeAgent(agent);
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'pi') return 'Pi';
  return 'Claude';
}

function formatPermissionModeHelp(agent, mode) {
  const meta = PERMISSION_MODE_META[mode] || PERMISSION_MODE_META.yolo;
  const normalized = normalizeAgent(agent);
  const detail = normalized === 'codex'
    ? meta.codex
    : normalized === 'pi'
      ? meta.pi
      : meta.claude;
  return `${meta.label} — ${meta.short}\n  ${detail}`;
}

const slashCommandsCache = {
  claude: { commands: null, discoveredAt: 0 }, // normalized: [{ name, desc }]
  codex: { commands: null, discoveredAt: 0 },
  pi: { commands: null, discoveredAt: 0 },
};
const CLAUDE_SLASH_DISCOVERY_TTL_MS = 5 * 60 * 1000;
let claudeSlashDiscoveryPromise = null;

function normalizeSlashCommandName(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const fromObj = raw.name || raw.command || raw.cmd || raw.id || '';
    return normalizeSlashCommandName(fromObj);
  }
  let name = String(raw).trim();
  if (!name) return '';
  if (name.startsWith('/')) name = name.slice(1);
  // Keep plugin-style names like "claude-hud:setup"
  return name;
}

function extractSlashCommandDescription(raw, name) {
  if (raw && typeof raw === 'object') {
    const fromObj = raw.description || raw.desc || raw.summary || raw.help || '';
    if (String(fromObj).trim()) return String(fromObj).trim();
  }
  if (name && SLASH_COMMAND_DESCRIPTIONS[name]) return SLASH_COMMAND_DESCRIPTIONS[name];
  return name || '';
}

/**
 * Normalize heterogeneous CLI discovery payloads into { name, desc }[].
 * Accepts strings, or objects with name/description fields.
 */
function normalizeDiscoveredSlashCommands(commands) {
  if (!Array.isArray(commands)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of commands) {
    const name = normalizeSlashCommandName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const source = (raw && typeof raw === 'object' && raw.source)
      ? String(raw.source)
      : '';
    out.push({
      name,
      desc: extractSlashCommandDescription(raw, name),
      ...(source ? { source } : {}),
    });
  }
  return out;
}

function classifySlashCommand(agent, name, sourceHint = '') {
  const normalizedAgent = normalizeAgent(agent);
  const key = normalizeSlashCommandName(name);
  if (!key) {
    return { availability: 'unknown', execution: 'passthrough', reason: '' };
  }
  if (PLATFORM_SLASH_COMMANDS.some((c) => c.name === key)) {
    return {
      availability: 'platform',
      execution: 'platform',
      reason: '由 Webcoding 平台处理，不透传 CLI',
    };
  }
  if (
    normalizedAgent === 'codex'
    && CODEX_TRANSPORT === 'app-server'
    && CODEX_APP_PLATFORM_COMMANDS.has(key)
  ) {
    return {
      availability: 'platform',
      execution: 'platform',
      reason: '由 Webcoding 通过 Codex App Server 处理',
    };
  }
  if (
    normalizedAgent === 'pi'
    && PI_TRANSPORT === 'rpc'
    && PI_RPC_PLATFORM_COMMANDS.has(key)
  ) {
    return {
      availability: 'platform',
      execution: 'platform',
      reason: '由 Webcoding 通过 Pi RPC 处理',
    };
  }
  if (normalizedAgent === 'codex' && CODEX_TUI_ONLY_COMMANDS.has(key)) {
    return {
      availability: 'tui-only',
      execution: 'blocked',
      reason: CODEX_TRANSPORT === 'app-server'
        ? '该命令依赖 Codex 交互式 TUI，当前 App Server 没有等价网页接口'
        : '该命令依赖 Codex 交互式 TUI，exec 协议不支持',
    };
  }

  // Custom/unified Codex: if managed runtime cannot see user content, do not advertise as runnable.
  if (normalizedAgent === 'codex') {
    const source = String(sourceHint || '');
    const needsPrompts = source === 'codex-prompts' || key.startsWith('prompts:');
    const needsSkills = source === 'codex-skills';
    const needsPlugins = source === 'codex-plugin';
    if (needsPrompts && !isCodexOverlayMountOk('prompts')) {
      return {
        availability: 'runtime-unavailable',
        execution: 'blocked',
        reason: 'Codex custom runtime 未成功挂载 prompts；子进程看不到该命令',
      };
    }
    if (needsSkills && !isCodexOverlayMountOk('skills')) {
      return {
        availability: 'runtime-unavailable',
        execution: 'blocked',
        reason: 'Codex custom runtime 未成功挂载 skills；子进程看不到该技能',
      };
    }
    if (needsPlugins && !isCodexOverlayMountOk('plugins')) {
      return {
        availability: 'runtime-unavailable',
        execution: 'blocked',
        reason: 'Codex custom runtime 未成功挂载 plugins；子进程看不到该插件命令',
      };
    }
    if (needsPrompts) {
      return {
        availability: 'passthrough',
        execution: 'passthrough',
        reason: 'Codex 自定义 prompt（~/.codex/prompts）',
      };
    }
  }
  return {
    availability: 'passthrough',
    execution: 'passthrough',
    reason: '',
  };
}

function buildSlashCommandList(agent) {
  const normalizedAgent = normalizeAgent(agent);
  const cache = slashCommandsCache[normalizedAgent];
  const cliCommands = (cache && Array.isArray(cache.commands)) ? cache.commands : [];
  const defaultCliSource = normalizedAgent === 'claude'
    ? 'claude-cli'
    : normalizedAgent === 'pi'
      ? 'pi-cli'
      : 'codex-cli';

  const out = [];
  const seen = new Set();

  const platformCommands = normalizedAgent === 'pi' && PI_TRANSPORT === 'rpc'
    ? [...PLATFORM_SLASH_COMMANDS, ...PI_RPC_PLATFORM_SLASH_COMMANDS]
    : PLATFORM_SLASH_COMMANDS;

  // 1) Platform controls first (always available in Webcoding)
  for (const entry of platformCommands) {
    const name = entry.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const classified = classifySlashCommand(normalizedAgent, name, 'webcoding');
    out.push({
      cmd: `/${name}`,
      desc: entry.desc || SLASH_COMMAND_DESCRIPTIONS[name] || name,
      source: 'webcoding',
      availability: classified.availability,
      execution: classified.execution,
      reason: classified.reason,
    });
  }

  // 2) CLI-discovered / filesystem-discovered commands
  for (const entry of cliCommands) {
    const name = entry?.name || normalizeSlashCommandName(entry);
    if (!name || seen.has(name)) continue;
    // Platform handlers take precedence over same-named CLI entries
    if (platformCommands.some((c) => c.name === name)) continue;
    seen.add(name);
    const source = entry?.source || defaultCliSource;
    const classified = classifySlashCommand(normalizedAgent, name, source);
    let desc = (entry && entry.desc) || SLASH_COMMAND_DESCRIPTIONS[name] || name;
    if (classified.availability === 'tui-only' && !/TUI|不支持|headless/i.test(desc)) {
      desc = `${desc}（仅 TUI）`;
    }
    if (classified.availability === 'runtime-unavailable' && !/不可用|未挂载|runtime/i.test(desc)) {
      desc = `${desc}（runtime 未挂载）`;
    }
    out.push({
      cmd: `/${name}`,
      desc,
      source,
      availability: classified.availability,
      execution: classified.execution,
      reason: classified.reason,
    });
  }

  out.sort((a, b) => {
    // platform first, then available passthrough, then unavailable last
    const rank = (item) => {
      if (item.availability === 'platform') return 0;
      if (item.availability === 'passthrough') return 1;
      if (item.availability === 'tui-only') return 2;
      if (item.availability === 'runtime-unavailable') return 3;
      return 4;
    };
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.cmd.localeCompare(b.cmd);
  });
  return out;
}

function isKnownSlashCommand(agent, cmdOrName) {
  const name = normalizeSlashCommandName(cmdOrName);
  if (!name) return false;
  const cmd = `/${name}`;
  return buildSlashCommandList(agent).some((item) => item.cmd === cmd);
}

function getSlashCommandMeta(agent, cmdOrName) {
  const name = normalizeSlashCommandName(cmdOrName);
  if (!name) return null;
  const cmd = `/${name}`;
  return buildSlashCommandList(agent).find((item) => item.cmd === cmd) || null;
}

function formatSlashHelpMessage(agent) {
  const list = buildSlashCommandList(agent);
  const label = agentDisplayName(agent);
  const lines = [
    `## Webcoding 平台帮助`,
    '',
    '平台命令（不透传 CLI）:',
    '  /model — 查看/切换模型',
    '  /effort — 查看/切换当前 Agent 的推理强度',
    '  /mode — 查看/切换权限模式（真实 CLI 标志见描述）',
    '  /compact — 压缩上下文',
    '  /web-help — 显示本帮助',
    '',
    '会话能力: 多会话侧栏、发送队列与幂等 ACK、stick-to-bottom、thinking 折叠、图片附件、完成通知。',
    '',
    `权限模式说明（当前 Agent: ${label}）:`,
    ...['yolo', 'default', 'plan'].map((m) => `  ${formatPermissionModeHelp(agent, m).replace(/\n/g, '\n  ')}`),
    '',
  ];
  if (list.length === 0) {
    lines.push(`${label} 斜杠命令列表为空。请确认本机 CLI 可用，或稍后重新打开会话以刷新发现结果。`);
    return lines.join('\n');
  }
  const platform = list.filter((i) => i.availability === 'platform');
  const passthrough = list.filter((i) => i.availability === 'passthrough');
  const tuiOnly = list.filter((i) => i.availability === 'tui-only');
  if (platform.length) {
    lines.push('平台命令:');
    platform.forEach((item) => lines.push(`  ${item.cmd} — ${item.desc || item.cmd}`));
    lines.push('');
  }
  if (passthrough.length) {
    lines.push(`${label} 可透传命令（由当前原生协议执行）:`);
    passthrough.forEach((item) => lines.push(`  ${item.cmd} — ${item.desc || item.cmd}`));
    lines.push('');
  }
  if (tuiOnly.length) {
    lines.push(`${label} 仅 TUI 命令（网页中会拦截并提示）:`);
    tuiOnly.forEach((item) => lines.push(`  ${item.cmd} — ${item.desc || item.cmd}`));
    lines.push('');
  }
  lines.push('说明：/ 菜单合并平台命令与 CLI/文件系统发现结果；TUI-only 不会伪装成可用。');
  return lines.join('\n');
}

function onSlashCommandsDiscovered(agent, commands) {
  if (!agent || !Array.isArray(commands)) return;
  const normalizedAgent = normalizeAgent(agent);
  const normalized = normalizeDiscoveredSlashCommands(commands);
  // Keep previous cache if discovery returned empty (avoid wiping good data on probe failure).
  if (normalized.length === 0 && Array.isArray(slashCommandsCache[normalizedAgent]?.commands)
      && slashCommandsCache[normalizedAgent].commands.length > 0) {
    return;
  }
  slashCommandsCache[normalizedAgent] = { commands: normalized, discoveredAt: Date.now() };
  broadcastSlashCommands(normalizedAgent);
}

function broadcastSlashCommands(agent) {
  const normalizedAgent = normalizeAgent(agent);
  const list = buildSlashCommandList(normalizedAgent);
  const msg = {
    type: 'slash_commands_list',
    agent: normalizedAgent,
    commands: list,
    capabilities: getRuntimeCapabilities(normalizedAgent),
  };
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      wsSend(client, msg);
    }
  }
}

function readSkillDescriptionFromFile(skillMdPath) {
  try {
    if (!fs.existsSync(skillMdPath)) return '';
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    // YAML frontmatter: ---\n...\n---
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return '';
    const block = match[1];
    // description: "..." or description: ...
    const descMatch = block.match(/^description:\s*(.+)$/m);
    if (!descMatch) return '';
    let desc = descMatch[1].trim();
    if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
      desc = desc.slice(1, -1);
    }
    // Keep UI compact
    if (desc.length > 120) desc = `${desc.slice(0, 117)}...`;
    return desc;
  } catch {
    return '';
  }
}

function discoverClaudeSlashCommands(options = {}) {
  const cached = slashCommandsCache.claude;
  if (
    Array.isArray(cached?.commands)
    && cached.commands.length > 0
    && Date.now() - Number(cached.discoveredAt || 0) < CLAUDE_SLASH_DISCOVERY_TTL_MS
  ) {
    return Promise.resolve(cached.commands);
  }
  if (claudeSlashDiscoveryPromise) return claudeSlashDiscoveryPromise;

  claudeSlashDiscoveryPromise = new Promise((resolve) => {
    // Streaming stdin stays open without sending a user turn. Claude can emit its
    // init metadata, but no model request is made merely to populate a menu.
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--no-session-persistence',
      '--bare',
    ];
    let resolved = false;
    let proc = null;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        try { proc.stdin.end(); } catch {}
        try { proc.kill('SIGTERM'); } catch {}
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, 10_000);
    timer.unref?.();

    try {
      const modelConfig = loadModelConfig();
      proc = spawn(CLAUDE_PATH, args, {
        env: buildClaudeEnv(modelConfig.mode !== 'custom'),
        cwd: options.cwd || process.env.HOME || process.env.USERPROFILE || __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        shell: shouldUseShellForCommand(CLAUDE_PATH),
      });

      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'system' && Array.isArray(evt.slash_commands)) {
              onSlashCommandsDiscovered('claude', evt.slash_commands);
              finish(evt.slash_commands);
            }
          } catch {}
        }
      });

      proc.stderr.on('data', () => {});
      proc.on('error', () => finish(null));
      proc.on('close', () => finish(null));
    } catch {
      finish(null);
    }
  }).finally(() => {
    claudeSlashDiscoveryPromise = null;
  });
  return claudeSlashDiscoveryPromise;
}

// Codex has no runtime slash-command discovery API — combine:
//   1. The official built-in command catalog (kept explicit and marked by Web availability)
//   2. Skills from ~/.codex/skills/ (user-installed + .system/)
//   3. Custom prompts from ~/.codex/prompts/*.md → /prompts:<stem>
function discoverCodexSlashCommands() {
  // Menu discovery always reads the user-facing Codex home (where skills/prompts are installed).
  // Custom/unified mode remaps CODEX_HOME to a managed runtime; prepareCodexCustomRuntime
  // overlays skills/prompts into that home so execution stays consistent.
  const codexHome = getUserCodexHome();
  // Best-effort: keep managed runtime overlays fresh so /prompts:* and skills work in custom mode.
  try {
    const mode = normalizeCodexMode(loadCodexConfig()?.mode);
    if (mode && mode !== 'local') ensureCodexRuntimeOverlays(CODEX_RUNTIME_HOME);
    else markCodexOverlayLocal();
  } catch {}
  const skillsDir = path.join(codexHome, 'skills');
  const promptsDir = path.join(codexHome, 'prompts');
  /** @type {Map<string, { desc: string, source: string }>} */
  const commands = new Map();

  function addCommand(name, desc = '', source = 'codex-cli') {
    const key = normalizeSlashCommandName(name);
    if (!key) return;
    const existing = commands.get(key);
    const nextDesc = String(desc || '').trim();
    const fallback = SLASH_COMMAND_DESCRIPTIONS[key] || key;
    if (!existing) {
      commands.set(key, { desc: nextDesc || fallback, source });
      return;
    }
    // Prefer richer descriptions when available; keep first non-cli source if more specific
    if (nextDesc && nextDesc.length > (existing.desc || '').length) {
      existing.desc = nextDesc;
    }
    if (source && source !== 'codex-cli' && existing.source === 'codex-cli') {
      existing.source = source;
    }
  }

  // 1. Built-in commands from the official Codex command reference.
  // Note: interactive-only TUI commands are marked tui-only in buildSlashCommandList.
  const builtIn = [
    'permissions', 'ide', 'keymap', 'vim', 'setup-default-sandbox', 'sandbox-add-read-dir',
    'agent', 'subagents', 'apps', 'plugins', 'hooks', 'clear', 'rename', 'archive', 'delete',
    'compact', 'copy', 'diff', 'exit', 'experimental', 'approve', 'memories', 'skills', 'import',
    'feedback', 'init', 'logout', 'mcp', 'mention', 'model', 'fast', 'plan', 'goal', 'personality',
    'ps', 'stop', 'fork', 'app', 'side', 'btw', 'raw', 'resume', 'new', 'quit', 'review', 'status',
    'usage', 'debug-config', 'statusline', 'title', 'theme', 'pets', 'pet',
  ];
  builtIn.forEach((c) => addCommand(c, SLASH_COMMAND_DESCRIPTIONS[c] || (
    c === 'goal' ? '设置/管理目标（Goals）' : c
  ), 'codex-cli'));

  // 2. User-installed skills (directories under ~/.codex/skills/, excluding .system)
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '.system') continue;
      if (entry.isDirectory()) {
        const subDir = path.join(skillsDir, entry.name);
        try {
          const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
          const skillMdPath = path.join(subDir, 'SKILL.md');
          const hasSkillMd = subEntries.some((e) => e.isFile() && e.name === 'SKILL.md');
          if (hasSkillMd) {
            addCommand(entry.name, readSkillDescriptionFromFile(skillMdPath), 'codex-skills');
          } else {
            for (const sub of subEntries) {
              if (sub.isDirectory() && !sub.name.startsWith('.')) {
                const subSkillMd = path.join(subDir, sub.name, 'SKILL.md');
                if (fs.existsSync(subSkillMd)) {
                  addCommand(sub.name, readSkillDescriptionFromFile(subSkillMd), 'codex-skills');
                }
              }
            }
          }
        } catch {}
      } else if (entry.isSymbolicLink()) {
        const targetSkillMd = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          if (fs.existsSync(targetSkillMd)) {
            addCommand(entry.name, readSkillDescriptionFromFile(targetSkillMd), 'codex-skills');
          }
        } catch {}
      }
    }
  } catch {}

  // 3. System skills (under ~/.codex/skills/.system/)
  try {
    const sysDir = path.join(skillsDir, '.system');
    const sysEntries = fs.readdirSync(sysDir, { withFileTypes: true });
    for (const entry of sysEntries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const skillMd = path.join(sysDir, entry.name, 'SKILL.md');
        try {
          if (fs.existsSync(skillMd)) {
            addCommand(entry.name, readSkillDescriptionFromFile(skillMd), 'codex-skills');
          }
        } catch {}
      }
    }
  } catch {}

  // 4. Custom prompts (~/.codex/prompts/*.md) → official slash form /prompts:<stem>
  // Docs: https://developers.openai.com/codex/custom-prompts
  try {
    if (fs.existsSync(promptsDir)) {
      const promptEntries = fs.readdirSync(promptsDir, { withFileTypes: true });
      for (const entry of promptEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (entry.name.startsWith('.')) continue;
        const stem = entry.name.slice(0, -3).trim();
        if (!stem) continue;
        const promptPath = path.join(promptsDir, entry.name);
        let desc = readSkillDescriptionFromFile(promptPath);
        if (!desc) {
          // Fallback: first non-empty non-frontmatter line, truncated
          try {
            const raw = fs.readFileSync(promptPath, 'utf8');
            const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
            const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) || '';
            desc = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
          } catch {}
        }
        if (!desc) desc = `自定义 prompt: ${stem}`;
        addCommand(`prompts:${stem}`, desc, 'codex-prompts');
      }
    }
  } catch {}

  const result = [...commands.entries()].map(([name, meta]) => ({
    name,
    desc: meta?.desc || SLASH_COMMAND_DESCRIPTIONS[name] || name,
    source: meta?.source || 'codex-cli',
  }));
  onSlashCommandsDiscovered('codex', result);
  return result;
}

// Pending compact retry metadata: sessionId -> { text: string, mode: string, reason: string, autoRetryCount: number }
const pendingCompactRetries = new Map();

// Active processes: sessionId -> { pid, ws, fullText, toolCalls, segments, lastCost, tailer }
const activeProcesses = new Map();
const piRpcRuntimes = new Map();
const codexAppRuntimes = new Map();
const claudeStreamRuntimes = new Map();
const piForkOperations = new Set();
const codexForkOperations = new Set();

// Track which session each ws is viewing: ws -> sessionId
const wsSessionMap = new Map();

const sessionListCache = {
  expiresAt: 0,
  sessions: [],
};

const importedSessionIdsCache = {
  expiresAt: 0,
  ids: new Set(),
};

function invalidateSessionListCache() {
  sessionListCache.expiresAt = 0;
}

function invalidateImportedSessionIdsCache() {
  importedSessionIdsCache.expiresAt = 0;
  importedSessionIdsCache.ids = new Set();
}

function setActiveProcess(sessionId, entry) {
  activeProcesses.set(sessionId, entry);
  invalidateSessionListCache();
}

function removeActiveProcess(sessionId) {
  const removed = activeProcesses.delete(sessionId);
  if (removed) invalidateSessionListCache();
  return removed;
}

function execFileQuiet(command, args = []) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

const DEFAULT_CLAUDE_MODEL_MAP = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

// Default fallback MODEL_MAP (overridden by model config at runtime)
let MODEL_MAP = { ...DEFAULT_CLAUDE_MODEL_MAP };

const CLAUDE_MODEL_MENU_ENTRIES = [
  {
    alias: 'default',
    label: '默认（推荐）',
    desc: '使用当前 Claude Code 或提供商配置的默认模型',
  },
  {
    alias: 'sonnet[1m]',
    label: 'Sonnet（1M 上下文）',
    desc: '使用当前 Sonnet 映射并启用 1M 上下文',
  },
  {
    alias: 'opus',
    label: 'Opus',
    desc: '使用当前 Opus 模型映射',
  },
  {
    alias: 'opus[1m]',
    label: 'Opus（1M 上下文）',
    desc: '使用当前 Opus 映射并启用 1M 上下文',
  },
  {
    alias: 'haiku',
    label: 'Haiku',
    desc: '使用当前 Haiku 模型映射',
  },
];

const VALID_AGENTS = new Set(['claude', 'codex', 'pi']);

// === Models API fetch ===
let _modelCache = null; // { models: [{id, display_name}], fetchedAt: number, source: 'anthropic'|'openai' }

function resolveActiveApiCredentials() {
  // Check Claude-selected provider first
  try {
    const tpl = getClaudeSelectedTemplate(loadModelConfig());
    if (tpl && tpl.apiKey) {
      return {
        apiKey: tpl.apiKey,
        apiBase: tpl.apiBase || 'https://api.anthropic.com',
        upstreamType: tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
      };
    }
  } catch {}
  // Check ~/.claude/settings.json env block
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const env = settings.env || {};
    const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
    if (key) return { apiKey: key, apiBase: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', upstreamType: 'anthropic' };
  } catch {}
  // Fall back to process.env
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (key) return { apiKey: key, apiBase: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', upstreamType: 'anthropic' };
  return null;
}

function fetchModelsFromApi(credentials) {
  return new Promise((resolve, reject) => {
    const apiBase = credentials.apiBase || 'https://api.anthropic.com';
    const isAnthropic = credentials.upstreamType === 'anthropic';
    let spec;
    let url;
    try {
      spec = buildModelsRequestSpec(apiBase, credentials.apiKey, credentials.upstreamType);
      url = new URL(spec.fullUrl);
    } catch (error) {
      return reject(error);
    }
    url.searchParams.set('limit', '100');
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: {
        ...spec.headers,
        'content-type': 'application/json',
      },
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      let body = '';
      let bodyBytes = 0;
      res.on('data', (d) => {
        bodyBytes += d.length;
        if (bodyBytes > HTTP_BODY_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        body += d;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const json = JSON.parse(body);
          // Anthropic format: { data: [{id, display_name, ...}] }
          // OpenAI-compat format: { data: [{id, object, ...}] }
          const raw = json.data || json.models || [];
          const models = raw
            .filter(m => typeof m.id === 'string' && m.id.toLowerCase().includes('claude'))
            .map(m => ({ id: m.id, display_name: m.display_name || m.id }));
          const source = isAnthropic ? 'anthropic' : 'openai';
          resolve({ models, source });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function getModelList() {
  const now = Date.now();
  if (_modelCache && now - _modelCache.fetchedAt < 3600_000) return _modelCache;
  const creds = resolveActiveApiCredentials();
  if (!creds) return null; // no credentials — caller uses stable CLI aliases
  try {
    const { models, source } = await fetchModelsFromApi(creds);
    if (models.length > 0) {
      _modelCache = { models, fetchedAt: now, source };
      return _modelCache;
    }
  } catch (e) {
    console.error('[model-api] fetch failed:', e.message);
  }
  return null; // caller uses stable CLI aliases
}

// === Model Config ===
const DEFAULT_MODEL_CONFIG = {
  mode: 'local',      // 'local' | 'custom'
  templates: [],      // array of { name, apiKey, apiBase, upstreamType, defaultModel, opusModel, sonnetModel, haikuModel }
  activeTemplate: '', // name of active template (for 'custom' mode)
};

const DEFAULT_CODEX_CONFIG = {
  mode: 'local',
  legacyMode: '',
  activeProfile: '',
  sharedTemplate: '',
  profiles: [],
  enableSearch: false,
  supportsSearch: false,
};

const DEFAULT_PI_CONFIG = {
  mode: 'local', // 'local' | 'unified'
  sharedTemplate: '',
};

function normalizeModelTemplate(template) {
  const apiBase = String(template?.apiBase || '').trim();
  const name = String(template?.name || '').trim();
  const modelHints = [
    String(template?.defaultModel || '').trim(),
    String(template?.opusModel || '').trim(),
    String(template?.sonnetModel || '').trim(),
    String(template?.haikuModel || '').trim(),
  ].filter(Boolean);
  const combinedHints = `${name}\n${apiBase}\n${modelHints.join('\n')}`.toLowerCase();
  const looksLikeAnthropicProtocol = /(^|\b)claude-|anthropic|messages\b/.test(combinedHints);
  const looksLikeOpenAiProtocol = /(^|\b)(gpt-|o1|o3|o4|openai|responses\b|chat\/completions|\/v1\b)/.test(combinedHints);
  const upstreamType = template?.upstreamType === 'anthropic'
    ? (looksLikeOpenAiProtocol && !looksLikeAnthropicProtocol ? 'openai' : 'anthropic')
    : 'openai';
  return {
    name,
    apiKey: String(template?.apiKey || ''),
    apiBase,
    upstreamType,
    defaultModel: String(template?.defaultModel || '').trim(),
    opusModel: String(template?.opusModel || '').trim(),
    sonnetModel: String(template?.sonnetModel || '').trim(),
    haikuModel: String(template?.haikuModel || '').trim(),
  };
}

function normalizeModelTemplates(templates) {
  return Array.isArray(templates)
    ? templates.map(normalizeModelTemplate).filter((template) => template.name)
    : [];
}

function normalizeModelMode(mode) {
  return mode === 'custom' ? 'custom' : 'local';
}

function selectTemplateByName(templates, templateName) {
  const normalizedName = String(templateName || '').trim();
  if (!normalizedName) return null;
  return (Array.isArray(templates) ? templates : []).find((template) => template.name === normalizedName) || null;
}

function pickConfiguredTemplate(templates, preferredName, fallbackName = '') {
  return selectTemplateByName(templates, preferredName)
    || selectTemplateByName(templates, fallbackName)
    || (Array.isArray(templates) ? templates[0] || null : null);
}

function getClaudeSelectedTemplate(config = null) {
  const modelConfig = config || loadModelConfig();
  if (!modelConfig || normalizeModelMode(modelConfig.mode) !== 'custom') return null;
  return pickConfiguredTemplate(modelConfig.templates, modelConfig.activeTemplate);
}

function getCodexSelectedTemplate(codexConfig = null, modelConfig = null) {
  const resolvedCodexConfig = codexConfig || loadCodexConfig();
  const resolvedModelConfig = modelConfig || loadModelConfig();
  const templates = Array.isArray(resolvedModelConfig.templates) ? resolvedModelConfig.templates : [];
  const preferredName = String(resolvedCodexConfig?.sharedTemplate || '').trim();
  const fallbackName = !preferredName ? String(resolvedModelConfig.activeTemplate || '').trim() : '';
  return pickConfiguredTemplate(templates, preferredName, fallbackName);
}

function normalizeCodexProfile(profile) {
  return {
    name: String(profile?.name || '').trim(),
    apiKey: String(profile?.apiKey || ''),
    apiBase: String(profile?.apiBase || '').trim(),
    defaultModel: String(profile?.defaultModel || '').trim(),
  };
}

function normalizeCodexProfiles(profiles) {
  return Array.isArray(profiles)
    ? profiles.map(normalizeCodexProfile).filter((profile) => profile.name)
    : [];
}

function normalizeCodexMode(mode) {
  return mode === 'unified' || mode === 'shared' || mode === 'custom' ? 'unified' : 'local';
}

function resolveCodexLegacyMode(raw) {
  if (raw === 'custom' || raw === 'shared') return raw;
  return '';
}

function loadModelConfig() {
  const raw = readCachedJsonConfig(MODEL_CONFIG_PATH);
  if (!raw) return cloneJson(DEFAULT_MODEL_CONFIG);
  const templates = normalizeModelTemplates(raw.templates);
  const normalized = {
    mode: normalizeModelMode(raw.mode),
    activeTemplate: String(raw.activeTemplate || '').trim(),
    templates,
  };
  if (normalized.mode === 'custom' && !selectTemplateByName(templates, normalized.activeTemplate)) {
    normalized.activeTemplate = templates[0]?.name || '';
  }
  if (normalized.mode === 'local') {
    normalized.activeTemplate = '';
  }
  return normalized;
}

function saveModelConfig(config) {
  const normalized = {
    mode: normalizeModelMode(config?.mode),
    activeTemplate: String(config?.activeTemplate || '').trim(),
    templates: normalizeModelTemplates(config?.templates),
  };
  if (normalized.mode === 'custom' && !selectTemplateByName(normalized.templates, normalized.activeTemplate)) {
    normalized.activeTemplate = normalized.templates[0]?.name || '';
  }
  if (normalized.mode === 'local') {
    normalized.activeTemplate = '';
  }
  writeCachedJsonConfig(MODEL_CONFIG_PATH, normalized);
}

// === Projects Config ===
function loadProjectsConfig() {
  const raw = readCachedJsonConfig(PROJECTS_CONFIG_PATH);
  if (raw) {
    return { projects: Array.isArray(raw.projects) ? raw.projects : [] };
  }
  return { projects: [] };
}

function saveProjectsConfig(config) {
  writeCachedJsonConfig(PROJECTS_CONFIG_PATH, config);
}

function normalizeProjectPathKey(projectPath) {
  const raw = String(projectPath || '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

function isSameOrChildProjectPath(parentPath, childPath) {
  const parent = normalizeProjectPathKey(parentPath);
  const child = normalizeProjectPathKey(childPath);
  if (!parent || !child) return false;
  if (parent === child) return true;
  const relativePath = path.relative(parent, child);
  return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function findBestProjectForPath(projects, targetPath) {
  const normalizedTargetPath = normalizeProjectPathKey(targetPath);
  if (!normalizedTargetPath) return null;
  let matchedProject = null;
  let matchedPathLength = -1;
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project?.path || !isSameOrChildProjectPath(project.path, normalizedTargetPath)) continue;
    const normalizedProjectPath = normalizeProjectPathKey(project.path);
    if (normalizedProjectPath.length > matchedPathLength) {
      matchedProject = project;
      matchedPathLength = normalizedProjectPath.length;
    }
  }
  return matchedProject;
}

function ensureProjectForPath(projectPath, options = {}) {
  const normalizedProjectPath = normalizeProjectPathKey(projectPath);
  if (!normalizedProjectPath) return { project: null, created: false };
  const config = loadProjectsConfig();
  const existing = findBestProjectForPath(config.projects, normalizedProjectPath);
  if (existing) {
    let changed = false;
    if (normalizeProjectPathKey(existing.path) === normalizedProjectPath && existing.path !== normalizedProjectPath) {
      existing.path = normalizedProjectPath;
      changed = true;
    }
    if (changed) saveProjectsConfig(config);
    return { project: existing, created: false };
  }
  const project = {
    id: options.id || crypto.randomUUID(),
    name: String(options.name || path.basename(normalizedProjectPath) || normalizedProjectPath).trim(),
    path: normalizedProjectPath,
  };
  config.projects.push(project);
  saveProjectsConfig(config);
  return { project, created: true };
}

function loadCodexConfig() {
  const raw = readCachedJsonConfig(CODEX_CONFIG_PATH);
  if (raw) {
    return {
      mode: normalizeCodexMode(raw.mode),
      legacyMode: resolveCodexLegacyMode(raw.legacyMode || raw.mode),
      activeProfile: raw.activeProfile || '',
      sharedTemplate: String(raw.sharedTemplate || '').trim(),
      profiles: normalizeCodexProfiles(raw.profiles),
      enableSearch: false,
      supportsSearch: false,
      storedEnableSearch: !!raw.enableSearch,
    };
  }
  return cloneJson(DEFAULT_CODEX_CONFIG);
}

function saveCodexConfig(config) {
  writeCachedJsonConfig(CODEX_CONFIG_PATH, {
    mode: normalizeCodexMode(config.mode),
    legacyMode: resolveCodexLegacyMode(config.legacyMode || config.mode),
    activeProfile: config.activeProfile || '',
    sharedTemplate: String(config.sharedTemplate || '').trim(),
    profiles: normalizeCodexProfiles(config.profiles),
    enableSearch: false,
  });
}

function getCodexConfigMasked() {
  const config = loadCodexConfig();
  const effectiveTemplate = normalizeCodexMode(config.mode) === 'unified'
    ? getCodexSelectedTemplate(config, loadModelConfig())
    : null;
  return {
    mode: normalizeCodexMode(config.mode),
    legacyMode: resolveCodexLegacyMode(config.legacyMode),
    activeProfile: config.activeProfile || '',
    sharedTemplate: effectiveTemplate?.name || config.sharedTemplate || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      apiKey: maskSecret(profile.apiKey),
      apiBase: profile.apiBase || '',
      defaultModel: profile.defaultModel || '',
    })),
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: !!config.storedEnableSearch,
  };
}

function normalizePiMode(mode) {
  return mode === 'unified' || mode === 'custom' ? 'unified' : 'local';
}

function loadPiConfig() {
  const raw = readCachedJsonConfig(PI_CONFIG_PATH);
  if (raw) {
    return {
      mode: normalizePiMode(raw.mode),
      sharedTemplate: String(raw.sharedTemplate || '').trim(),
    };
  }
  return cloneJson(DEFAULT_PI_CONFIG);
}

function savePiConfig(config) {
  writeCachedJsonConfig(PI_CONFIG_PATH, {
    mode: normalizePiMode(config?.mode),
    sharedTemplate: String(config?.sharedTemplate || '').trim(),
  });
}

function getPiSelectedTemplate(config, modelConfig = null) {
  const cfg = config || loadPiConfig();
  if (normalizePiMode(cfg.mode) !== 'unified') return null;
  const models = modelConfig || loadModelConfig();
  const templates = Array.isArray(models.templates) ? models.templates : [];
  const named = String(cfg.sharedTemplate || '').trim();
  if (named) {
    const found = templates.find((t) => t.name === named);
    if (found) return found;
  }
  return templates[0] || null;
}

function getPiConfigMasked() {
  const config = loadPiConfig();
  const effectiveTemplate = normalizePiMode(config.mode) === 'unified'
    ? getPiSelectedTemplate(config, loadModelConfig())
    : null;
  return {
    mode: normalizePiMode(config.mode),
    sharedTemplate: effectiveTemplate?.name || config.sharedTemplate || '',
  };
}

function resolvePiActiveSource(config) {
  const cfg = config || loadPiConfig();
  if (normalizePiMode(cfg.mode) === 'local') return { mode: 'local' };
  const template = getPiSelectedTemplate(cfg);
  if (!template) {
    return { error: 'Pi 渠道选择了 AI 提供商，但当前没有可用的提供商配置。请先在设置中创建至少一个 AI 提供商。' };
  }
  if (!template.apiKey || !template.apiBase) {
    return { error: `Pi 渠道「${template.name}」缺少 API Key 或 API Base URL。` };
  }
  return {
    mode: 'unified',
    name: template.name,
    apiKey: template.apiKey,
    apiBase: String(template.apiBase || '').trim().replace(/\/+$/, ''),
    upstreamType: template.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
    defaultModel: String(template.defaultModel || '').trim(),
  };
}

const PI_RUNTIME_HOME = path.join(CONFIG_DIR, 'pi-runtime-home');
const PI_MANAGED_PROVIDER_ID = 'webcoding';
const PI_RESOURCE_SETTING_KEYS = ['extensions', 'skills', 'prompts', 'themes'];
const PI_PACKAGE_STORE_DIRS = ['npm', 'git'];

function expandPiUserPath(value) {
  const configured = String(value || '');
  if (!configured) return '';
  const home = getUserHomeDir();
  if (configured === '~') return home;
  if (configured.startsWith('~/') || (process.platform === 'win32' && configured.startsWith('~\\'))) {
    return path.join(home, configured.slice(2));
  }
  return configured;
}

function getUserPiAgentDir() {
  return expandPiUserPath(process.env.PI_CODING_AGENT_DIR)
    || path.join(getUserHomeDir(), '.pi', 'agent');
}

function getUserPiSessionsDir() {
  return expandPiUserPath(process.env.PI_CODING_AGENT_SESSION_DIR)
    || path.join(getUserPiAgentDir(), 'sessions');
}

function loadUserPiSettings() {
  const filePath = path.join(getUserPiAgentDir(), 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveInheritedPiResourceEntry(entry, userPiDir) {
  if (typeof entry !== 'string') return null;
  const value = entry.trim();
  if (!value) return null;
  const prefix = ['!', '+', '-'].includes(value[0]) ? value[0] : '';
  const resourcePath = prefix ? value.slice(1) : value;
  if (!resourcePath || path.isAbsolute(resourcePath) || resourcePath.startsWith('~')) return value;
  return `${prefix}${path.resolve(userPiDir, resourcePath)}`;
}

function buildManagedPiSettings(modelId) {
  const userPiDir = getUserPiAgentDir();
  const inherited = cloneJson(loadUserPiSettings());
  delete inherited.defaultProvider;
  delete inherited.defaultModel;
  delete inherited.enabledModels;
  delete inherited.sessionDir;

  for (const key of PI_RESOURCE_SETTING_KEYS) {
    const entries = Array.isArray(inherited[key]) ? inherited[key] : [];
    const resolvedEntries = entries
      .map((entry) => resolveInheritedPiResourceEntry(entry, userPiDir))
      .filter(Boolean);
    const conventionalDir = path.join(userPiDir, key);
    if (fs.existsSync(conventionalDir)) resolvedEntries.unshift(conventionalDir);
    if (resolvedEntries.length > 0) inherited[key] = Array.from(new Set(resolvedEntries));
    else delete inherited[key];
  }

  return {
    ...inherited,
    defaultProvider: PI_MANAGED_PROVIDER_ID,
    defaultModel: modelId,
  };
}

function syncManagedPiPackageStores() {
  const userPiDir = getUserPiAgentDir();
  for (const dirName of PI_PACKAGE_STORE_DIRS) {
    const source = path.join(userPiDir, dirName);
    const target = path.join(PI_RUNTIME_HOME, dirName);
    let targetStat = null;
    try { targetStat = fs.lstatSync(target); } catch {}
    if (!fs.existsSync(source)) {
      if (targetStat?.isSymbolicLink()) {
        try { fs.unlinkSync(target); } catch {}
      }
      continue;
    }
    if (targetStat?.isSymbolicLink()) {
      try {
        if (fs.realpathSync(target) === fs.realpathSync(source)) continue;
        fs.unlinkSync(target);
      } catch {
        try { fs.unlinkSync(target); } catch {}
      }
    } else if (targetStat) {
      // Keep existing managed content rather than deleting data we did not create as a link.
      continue;
    }
    try {
      fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      plog('WARN', 'pi_resource_mount_failed', { dirName, error: error.message });
    }
  }
}

function getPiRuntimeFingerprint(config) {
  const source = resolvePiActiveSource(config || loadPiConfig());
  if (!source || source.mode === 'local') {
    const piDir = getUserPiAgentDir();
    return JSON.stringify({
      runtimeVersion: 2,
      mode: 'local',
      modelsFingerprint: fileContentFingerprint(path.join(piDir, 'models.json')),
      settingsFingerprint: fileContentFingerprint(path.join(piDir, 'settings.json')),
      authFingerprint: fileContentFingerprint(path.join(piDir, 'auth.json')),
    });
  }
  if (source.error) return `error:${source.error}`;
  return JSON.stringify({
    runtimeVersion: 2,
    mode: 'remote',
    sourceName: String(source.name || '').trim(),
    apiBase: String(source.apiBase || '').trim().replace(/\/+$/, ''),
    upstreamType: String(source.upstreamType || 'openai').toLowerCase(),
    defaultModel: String(source.defaultModel || '').trim(),
    userSettingsFingerprint: fileContentFingerprint(path.join(getUserPiAgentDir(), 'settings.json')),
  });
}

/**
 * Build a managed PI_CODING_AGENT_DIR so Pi uses the selected AI provider
 * without mutating the user's ~/.pi/agent.
 */
function preparePiCustomRuntime(config) {
  const source = resolvePiActiveSource(config || loadPiConfig());
  if (source?.error) return source;
  if (!source || source.mode === 'local') {
    return { mode: 'local' };
  }

  const modelId = source.defaultModel || 'default';
  let bridge;
  try {
    bridge = ensureBridgeRuntimeForTemplate(source);
  } catch (error) {
    return { error: `启动 Pi 本地 API 桥接失败: ${error.message || error}` };
  }
  const modelsJson = {
    providers: {
      [PI_MANAGED_PROVIDER_ID]: {
        baseUrl: bridge.openaiBaseUrl,
        api: 'openai-responses',
        apiKey: '$WEBCODING_PI_API_KEY',
        models: [
          {
            id: modelId,
            name: modelId,
          },
        ],
      },
    },
  };
  const settingsJson = buildManagedPiSettings(modelId);

  try {
    fs.mkdirSync(PI_RUNTIME_HOME, { recursive: true });
    syncManagedPiPackageStores();
    writeJsonAtomic(path.join(PI_RUNTIME_HOME, 'models.json'), modelsJson);
    writeJsonAtomic(path.join(PI_RUNTIME_HOME, 'settings.json'), settingsJson);
    // Keep an empty auth file so Pi doesn't fall back to host auth unexpectedly.
    if (!fs.existsSync(path.join(PI_RUNTIME_HOME, 'auth.json'))) {
      writeJsonAtomic(path.join(PI_RUNTIME_HOME, 'auth.json'), {});
    }
  } catch (error) {
    return { error: `写入 Pi 运行时配置失败: ${error.message || error}` };
  }

  return {
    mode: 'custom',
    homeDir: PI_RUNTIME_HOME,
    provider: PI_MANAGED_PROVIDER_ID,
    apiKey: bridge.token,
    apiBase: bridge.openaiBaseUrl,
    defaultModel: modelId,
    profileName: source.name,
    upstreamType: source.upstreamType,
  };
}

function maskSecret(str) {
  if (!str || str.length <= 12) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function mergeSecretField(nextValue, currentValue) {
  const next = String(nextValue || '');
  if (next && !next.includes('****')) return next;
  return String(currentValue || '');
}

function getModelConfigMasked() {
  const config = loadModelConfig();
  return {
    mode: config.mode,
    activeTemplate: config.activeTemplate,
    templates: (config.templates || []).map(t => ({
      name: t.name,
      apiKey: maskSecret(t.apiKey),
      apiBase: t.apiBase || '',
      upstreamType: t.upstreamType || 'openai',
      defaultModel: t.defaultModel || '',
      opusModel: t.opusModel || '',
      sonnetModel: t.sonnetModel || '',
      haikuModel: t.haikuModel || '',
    })),
  };
}

const CODEX_RUNTIME_HOME = path.join(CONFIG_DIR, 'codex-runtime-home');

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function resolveCodexCustomProfile(config) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const activeProfile = profiles.find((profile) => profile.name === config?.activeProfile) || null;
  if (!activeProfile) {
    return { error: 'Codex 独立配置缺少已激活的配置项。请先在设置中创建并激活一个 API 配置。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Codex 配置「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }
  return {
    mode: 'custom',
    name: activeProfile.name,
    apiKey: activeProfile.apiKey,
    apiBase: activeProfile.apiBase,
    upstreamType: 'openai',
    defaultModel: activeProfile.defaultModel || '',
  };
}

function resolveCodexUnifiedSource(config) {
  const modelConfig = loadModelConfig();
  // Fallback priority:
  // 1) Codex selected provider
  // 2) legacy Claude-selected provider (for old configs that never chose a separate Codex provider)
  // 3) first available provider
  // 4) legacy custom profile
  // 5) legacy shared(local Claude credentials)
  const template = getCodexSelectedTemplate(config, modelConfig);

  if (template) {
    if (!template.apiKey || !template.apiBase) {
      if (config?.legacyMode === 'custom') return resolveCodexCustomProfile(config);
      return { error: `AI 提供商配置「${template.name}」缺少 API Key 或 API Base URL。` };
    }
    return {
      mode: 'unified',
      name: template.name,
      apiKey: template.apiKey,
      apiBase: template.apiBase,
      upstreamType: template.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
      defaultModel: template.defaultModel || '',
    };
  }

  if (config?.legacyMode === 'custom') {
    return resolveCodexCustomProfile(config);
  }

  if (config?.legacyMode === 'shared') {
    const localClaude = readClaudeSettingsCredentials();
    if (localClaude) {
      return {
        mode: 'unified',
        name: '当前 Claude Code 配置',
        apiKey: localClaude.apiKey,
        apiBase: localClaude.apiBase,
        upstreamType: 'anthropic',
        defaultModel: localClaude.defaultModel || '',
      };
    }
  }

  return { error: '当前没有可用的 AI 提供商配置。请先在设置中创建至少一个可用提供商。' };
}

function resolveCodexActiveSource(config) {
  if (!config || normalizeCodexMode(config.mode) === 'local') return { mode: 'local' };
  return resolveCodexUnifiedSource(config);
}

function getCodexRuntimeFingerprint(config) {
  const source = resolveCodexActiveSource(config || loadCodexConfig());
  if (!source || source.mode === 'local') {
    const codexHome = getUserCodexHome();
    const codexLocalConfigPath = path.join(codexHome, 'config.toml');
    const codexLocalAuthPath = path.join(codexHome, 'auth.json');
    return JSON.stringify({
      runtimeVersion: 5,
      mode: 'local',
      configFingerprint: fileContentFingerprint(codexLocalConfigPath),
      authFingerprint: fileContentFingerprint(codexLocalAuthPath),
    });
  }
  if (source.error) return `error:${source.error}`;
  return JSON.stringify({
    runtimeVersion: 5,
    mode: 'remote',
    sourceName: String(source.name || '').trim(),
    apiBase: String(source.apiBase || '').trim().replace(/\/+$/, ''),
    upstreamType: String(source.upstreamType || 'openai').toLowerCase(),
  });
}

/**
 * User-facing Codex home (skills/prompts live here).
 * Custom/unified mode spawns with CODEX_HOME=CODEX_RUNTIME_HOME, so we overlay
 * skills + prompts from the user home into the managed runtime home.
 */
function getUserHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getClaudeConfigDir() {
  const configured = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return path.resolve(configured || path.join(getUserHomeDir(), '.claude'));
}

function getUserCodexHome() {
  const configured = String(process.env.CODEX_HOME || '').trim();
  return path.resolve(configured || path.join(getUserHomeDir(), '.codex'));
}

/** Last known Codex runtime overlay status (local = no overlay needed). */
let codexOverlayState = {
  updatedAt: null,
  mode: 'local',
  mounts: {
    skills: { status: 'native' },
    prompts: { status: 'native' },
    plugins: { status: 'native' },
  },
};

function markCodexOverlayLocal() {
  codexOverlayState = {
    updatedAt: Date.now(),
    mode: 'local',
    mounts: {
      skills: { status: 'native' },
      prompts: { status: 'native' },
      plugins: { status: 'native' },
    },
  };
  return codexOverlayState;
}

function isCodexOverlayMountOk(mountKey) {
  const status = codexOverlayState?.mounts?.[mountKey]?.status;
  return status === 'native' || status === 'linked' || status === 'missing';
}

/**
 * Ensure managed runtime home can see the same skills/prompts as the user's Codex install.
 * Uses directory symlinks (junction on Windows). Never deletes a real directory.
 * @returns {{ mode: string, mounts: Record<string, { status: string, error?: string }> }}
 */
function ensureCodexRuntimeOverlays(runtimeHome) {
  const userHome = getUserCodexHome();
  if (!runtimeHome || path.resolve(runtimeHome) === path.resolve(userHome)) {
    return markCodexOverlayLocal();
  }
  const mounts = {
    skills: { status: 'missing' },
    prompts: { status: 'missing' },
    plugins: { status: 'missing' },
  };
  try {
    fs.mkdirSync(runtimeHome, { recursive: true });
  } catch (err) {
    const failed = {
      updatedAt: Date.now(),
      mode: 'custom',
      mounts: {
        skills: { status: 'error', error: err.message },
        prompts: { status: 'error', error: err.message },
        plugins: { status: 'error', error: err.message },
      },
    };
    codexOverlayState = failed;
    return failed;
  }
  // skills/prompts: user-installed content. plugins live under .tmp/bundled-marketplaces.
  const overlays = [
    { key: 'skills', name: 'skills', target: path.join(userHome, 'skills') },
    { key: 'prompts', name: 'prompts', target: path.join(userHome, 'prompts') },
    { key: 'plugins', name: path.join('.tmp', 'bundled-marketplaces'), target: path.join(userHome, '.tmp', 'bundled-marketplaces') },
  ];
  for (const { key, name, target } of overlays) {
    const resolvedTarget = path.resolve(target);
    if (!fs.existsSync(resolvedTarget)) {
      mounts[key] = { status: 'missing' };
      continue;
    }
    const linkPath = path.join(runtimeHome, name);
    try {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      let st = null;
      try { st = fs.lstatSync(linkPath); } catch { st = null; }
      if (st) {
        if (st.isSymbolicLink()) {
          let current = '';
          try { current = fs.readlinkSync(linkPath); } catch { current = ''; }
          const resolved = path.resolve(path.isAbsolute(current) ? current : path.join(path.dirname(linkPath), current));
          if (resolved === resolvedTarget) {
            mounts[key] = { status: 'linked' };
            continue;
          }
          try { fs.unlinkSync(linkPath); } catch (unlinkErr) {
            mounts[key] = { status: 'blocked', error: unlinkErr.message };
            continue;
          }
        } else {
          // Real dir/file already present — do not replace; child may not see user content.
          mounts[key] = {
            status: 'blocked',
            error: `runtime home already has real ${name}; not replaced`,
          };
          continue;
        }
      }
      fs.symlinkSync(resolvedTarget, linkPath, IS_WIN ? 'junction' : 'dir');
      mounts[key] = { status: 'linked' };
    } catch (err) {
      mounts[key] = { status: 'error', error: err.message };
      plog('WARN', 'codex_runtime_overlay_failed', { name, error: err.message });
    }
  }
  codexOverlayState = { updatedAt: Date.now(), mode: 'custom', mounts };
  return codexOverlayState;
}

/**
 * Honest headless capability snapshot (not a fake TUI feature matrix).
 * Merges static protocol catalog (lib/runtime-capabilities.js) with live overlay state.
 */
function getRuntimeCapabilities(agent) {
  const normalizedAgent = normalizeAgent(agent);
  let codexMode = 'local';
  try {
    codexMode = normalizeCodexMode(loadCodexConfig()?.mode) || 'local';
  } catch {
    codexMode = 'local';
  }
  if (normalizedAgent === 'codex' && codexMode !== 'local') {
    // Refresh overlay status so capability report matches what spawn will see.
    try { ensureCodexRuntimeOverlays(CODEX_RUNTIME_HOME); } catch {}
  } else if (normalizedAgent === 'codex' && codexMode === 'local') {
    markCodexOverlayLocal();
  }
  const overlay = codexOverlayState;
  const extras = {
    codexMode: normalizedAgent === 'codex' ? codexMode : null,
    overlay: normalizedAgent === 'codex' ? {
      mode: overlay.mode,
      mounts: overlay.mounts,
      skillsOk: isCodexOverlayMountOk('skills'),
      promptsOk: isCodexOverlayMountOk('prompts'),
      pluginsOk: isCodexOverlayMountOk('plugins'),
    } : null,
  };
  if (normalizedAgent === 'codex' && CODEX_TRANSPORT === 'app-server') {
    Object.assign(extras, {
      headless: false,
      protocol: 'codex-app-server',
      interactiveApproval: true,
      askUser: true,
      planConfirmUi: true,
      goalsStructured: true,
      goalsWritable: true,
      reasoningEffort: true,
      nativeStreamingQueue: true,
      streamingBehaviors: ['steer'],
      respondableInteractiveKinds: ['select', 'confirm', 'input', 'editor', 'questions'],
      notes: [
        'Codex 使用持久 App Server，支持原生线程续接、流式事件、运行中转向、中断、审批、用户问答和内联 Review。',
        '默认模式采用 workspace-write，并把需要确认的命令或文件操作发送到网页审批卡片。',
      ],
    });
  }
  if (normalizedAgent === 'claude' && CLAUDE_TRANSPORT === 'stream-json') {
    Object.assign(extras, {
      protocol: 'claude-stream-json',
      persistentSession: true,
      streamingInput: true,
      interactiveApproval: true,
      askUser: true,
      planConfirmUi: true,
      reasoningEffort: true,
      respondableInteractiveKinds: ['select', 'confirm', 'questions'],
      nativeStreamingQueue: false,
      notes: [
        'Claude 使用常驻 stream-json 输入/输出，普通文本与图片采用同一结构化协议，并启用 partial message 与 hook 事件。',
        'Claude 的 can_use_tool 与 MCP elicitation 会显示为可回应的网页审批卡片；运行中的新消息仍由网页队列在下一轮发送。',
      ],
    });
  }
  if (normalizedAgent === 'codex' && codexMode !== 'local') {
    extras.notes = [
      ...(extras.notes || getStaticHeadlessCapabilities(normalizedAgent).notes || []),
      'Codex custom/unified 模式依赖 managed runtime 对 skills/prompts/plugins 的 overlay。',
    ];
  }
  if (normalizedAgent === 'pi' && PI_TRANSPORT === 'rpc') {
    Object.assign(extras, {
      headless: false,
      protocol: 'pi-rpc',
      interactiveApproval: false,
      askUser: true,
      planConfirmUi: false,
      thinkingLevel: true,
      nativeStreamingQueue: true,
      streamingBehaviors: ['steer', 'followUp'],
      respondableInteractiveKinds: ['select', 'confirm', 'input', 'editor'],
      notes: [
        'Pi 使用持久 RPC 通道，支持扩展对话框、状态/Widget/输入框更新、运行中转向/接着做、模型发现、命令发现和原生中断。',
        'Pi 本身没有 Claude/Codex 式权限审批；Plan 模式仍映射为只读工具集。',
      ],
    });
  }
  return getStaticHeadlessCapabilities(normalizedAgent, extras);
}

function prepareCodexCustomRuntime(config) {
  const source = resolveCodexActiveSource(config);
  if (source?.error) return source;
  if (!source || source.mode === 'local') {
    markCodexOverlayLocal();
    return { mode: 'local' };
  }

  let bridge = null;
  try {
    bridge = ensureBridgeRuntimeForTemplate(source);
  } catch (error) {
    return { error: error.message || '本地 API 中间件初始化失败' };
  }

  fs.mkdirSync(CODEX_RUNTIME_HOME, { recursive: true });
  // Make user skills/prompts visible to the child (CODEX_HOME points here).
  ensureCodexRuntimeOverlays(CODEX_RUNTIME_HOME);
  const configToml = [
    '# Generated by webcoding. Codex startup is also forced via CLI -c overrides.',
    `# bridge_base_url = ${tomlString(bridge.openaiBaseUrl)}`,
    `# bridge_api_key = ${tomlString(bridge.token)}`,
    bridge.defaultModel ? `model = ${tomlString(bridge.defaultModel)}` : null,
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    '',
    '[model_providers.openai_compat]',
    `name = ${tomlString(source.name || 'AI Provider')}`,
    `base_url = ${tomlString(bridge.openaiBaseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].filter((line) => line !== null).join('\n');
  fs.writeFileSync(path.join(CODEX_RUNTIME_HOME, 'config.toml'), configToml);

  return {
    mode: 'custom',
    homeDir: CODEX_RUNTIME_HOME,
    apiKey: bridge.token,
    apiBase: bridge.openaiBaseUrl,
    profileName: source.name,
    defaultModel: bridge.defaultModel || '',
  };
}

function normalizeCodexModelEntries(rawModels) {
  const entries = [];
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const value = String(raw?.slug || raw?.id || raw?.model || raw?.name || raw || '').trim();
    if (!value) continue;
    const visibility = String(raw?.visibility || '').toLowerCase();
    if (visibility && visibility !== 'list') continue;
    const label = String(raw?.display_name || raw?.displayName || raw?.name || value).trim() || value;
    const desc = String(raw?.description || '').trim() || 'Codex 模型';
    entries.push({
      value,
      label,
      desc,
      priority: Number.isFinite(raw?.priority) ? raw.priority : 999,
    });
  }
  entries.sort((a, b) => (a.priority - b.priority) || a.label.localeCompare(b.label));
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    deduped.push({
      value: entry.value,
      label: entry.label,
      desc: entry.desc,
    });
  }
  return deduped;
}

function loadCodexModelsCacheEntries(cachePath) {
  try {
    if (!cachePath) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const entries = normalizeCodexModelEntries(parsed.models);
    if (!entries.length) return null;
    return {
      entries,
      source: 'codex-cache',
      fetchedAt: parsed.fetched_at || null,
      clientVersion: parsed.client_version || null,
    };
  } catch {
    return null;
  }
}

function getCodexModelsCachePaths(config) {
  const paths = [];
  if (config?.mode && config.mode !== 'local') {
    paths.push(path.join(CODEX_RUNTIME_HOME, 'models_cache.json'));
  }
  paths.push(path.join(getUserCodexHome(), 'models_cache.json'));
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function buildVersionedEndpointUrl(apiBase, endpoint) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  const normalizedEndpoint = String(endpoint || '').trim().replace(/^\/+/, '');
  if (!base) throw new Error('缺少 API Base URL');
  if (!normalizedEndpoint) throw new Error('缺少 API endpoint');
  if (base.toLowerCase().endsWith(`/${normalizedEndpoint.toLowerCase()}`)) return base;
  return /\/v\d+(?:\.\d+)?$/i.test(base) ? `${base}/${normalizedEndpoint}` : `${base}/v1/${normalizedEndpoint}`;
}

function buildFetchModelsUrl(apiBase) {
  return buildVersionedEndpointUrl(apiBase, 'models');
}

function buildModelsRequestSpec(apiBase, apiKey, upstreamType = 'openai') {
  const fullUrl = buildFetchModelsUrl(apiBase);
  const headers = upstreamType === 'anthropic'
    ? {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }
    : {
        Authorization: `Bearer ${apiKey}`,
      };
  return { fullUrl, headers };
}

function isTlsHandshakeFailure(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /eproto|handshake failure|alert handshake failure|protocol version|ssl3_read_bytes|tlsv1 alert protocol version/.test(text);
}

function getClaudeFallbackModels() {
  const models = [];
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    const value = MODEL_MAP[alias] || DEFAULT_CLAUDE_MODEL_MAP[alias];
    if (value) models.push(value);
  }
  return Array.from(new Set(models));
}

function fetchCodexModelsFromApi(profile) {
  return new Promise((resolve, reject) => {
    const base = String(profile?.apiBase || '').trim().replace(/\/$/, '');
    const token = String(profile?.apiKey || '').trim();
    const upstreamType = profile?.upstreamType === 'anthropic' ? 'anthropic' : 'openai';
    if (!base || !token) {
      return resolve(null);
    }
    let url;
    let spec;
    try {
      spec = buildModelsRequestSpec(base, token, upstreamType);
      url = new URL(spec.fullUrl);
    } catch (error) {
      return reject(error);
    }
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: {
        ...spec.headers,
        'content-type': 'application/json',
      },
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(options, (res) => {
      let body = '';
      let bodyBytes = 0;
      res.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > HTTP_BODY_MAX_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(body);
          const entries = normalizeCodexModelEntries(json.data || json.models || []);
          resolve(entries.length ? { entries, source: 'provider-api' } : null);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function getCodexModelMenuPayload(session) {
  const currentFull = session?.model || '';
  const current = currentFull || 'default';
  const modelConfig = loadModelConfig();
  const codexConfig = loadCodexConfig();
  const activeTemplate = normalizeCodexMode(codexConfig.mode) === 'unified'
    ? getCodexSelectedTemplate(codexConfig, modelConfig)
    : null;
  let dynamicEntries = [];
  let source = null;

  if (CODEX_TRANSPORT === 'app-server' && session) {
    try {
      const spawnSpec = buildCodexSpawnSpec(session, { transport: 'app-server' });
      if (!spawnSpec?.error) {
        const runtime = await ensureCodexAppRuntime(session, spawnSpec);
        const result = await runtime.client.request('model/list', { limit: 100 }, { timeoutMs: 15_000 });
        dynamicEntries = normalizeCodexModelEntries(result?.data || result?.models || []);
        if (dynamicEntries.length) source = 'codex-app-server';
      }
    } catch (error) {
      plog('WARN', 'codex_app_model_list_failed', { error: error.message });
    }
  }

  if (!dynamicEntries.length && activeTemplate?.apiBase && activeTemplate?.apiKey) {
    try {
      const fetched = await fetchCodexModelsFromApi(activeTemplate);
      if (fetched?.entries?.length) {
        dynamicEntries = fetched.entries;
        source = fetched.source;
      }
    } catch (error) {
      plog('WARN', 'codex_model_fetch_failed', { error: error.message });
    }
  }

  if (!dynamicEntries.length) {
    for (const cachePath of getCodexModelsCachePaths(codexConfig)) {
      const cached = loadCodexModelsCacheEntries(cachePath);
      if (cached?.entries?.length) {
        dynamicEntries = cached.entries;
        source = cached.source;
        break;
      }
    }
  }

  const entries = [{
    value: 'default',
    label: '默认模型（Codex）',
    desc: activeTemplate?.defaultModel
      ? `使用当前 Codex 默认模型（${activeTemplate.defaultModel}）`
      : '使用当前 Codex 默认模型',
  }];
  const seen = new Set(entries.map((entry) => entry.value));
  if (activeTemplate?.defaultModel && !seen.has(activeTemplate.defaultModel)) {
    seen.add(activeTemplate.defaultModel);
    entries.push({
      value: activeTemplate.defaultModel,
      label: activeTemplate.defaultModel,
      desc: '当前 AI 提供商默认模型（Codex）',
    });
  }
  for (const entry of dynamicEntries) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    entries.push(entry);
  }
  if (currentFull && !seen.has(currentFull)) {
    entries.push({
      value: currentFull,
      label: currentFull,
      desc: '当前会话模型',
    });
  }

  return {
    type: 'model_list',
    agent: 'codex',
    entries,
    current,
    currentFull,
    source,
  };
}

const CLAUDE_EFFORT_ENTRIES = [
  { value: 'default', label: '默认', desc: '使用 Claude Code 当前默认推理强度' },
  { value: 'low', label: 'Low', desc: '更快响应，适合简单任务' },
  { value: 'medium', label: 'Medium', desc: '速度与推理深度平衡' },
  { value: 'high', label: 'High', desc: '提高复杂任务的推理深度' },
  { value: 'xhigh', label: 'XHigh', desc: '用于高难度任务的额外推理' },
  { value: 'max', label: 'Max', desc: 'Claude Code 支持的最大推理强度' },
];
const CODEX_FALLBACK_EFFORT_ENTRIES = [
  { value: 'default', label: '默认', desc: '使用当前 Codex 模型的默认推理强度' },
  { value: 'low', label: 'Low', desc: '更快响应，使用较轻推理' },
  { value: 'medium', label: 'Medium', desc: '速度与推理深度平衡' },
  { value: 'high', label: 'High', desc: '提高复杂任务的推理深度' },
  { value: 'xhigh', label: 'XHigh', desc: '用于高难度任务的额外推理' },
];
const PI_THINKING_ENTRIES = [
  { value: 'default', label: '默认', desc: '使用 Pi 配置或当前模型的默认思考级别' },
  { value: 'off', label: 'Off', desc: '关闭额外思考' },
  { value: 'minimal', label: 'Minimal', desc: '最少量思考' },
  { value: 'low', label: 'Low', desc: '较低思考深度' },
  { value: 'medium', label: 'Medium', desc: '中等思考深度' },
  { value: 'high', label: 'High', desc: '较高思考深度' },
  { value: 'xhigh', label: 'XHigh', desc: '最高思考深度' },
];

function codexEffortEntries(models, requestedModel) {
  const list = Array.isArray(models) ? models : [];
  const model = list.find((entry) => {
    const id = String(entry?.id || entry?.model || entry?.slug || '');
    return requestedModel && id === requestedModel;
  }) || list.find((entry) => entry?.isDefault === true) || list[0] || null;
  const supported = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : (Array.isArray(model?.supported_reasoning_efforts) ? model.supported_reasoning_efforts : []);
  const entries = [{
    value: 'default',
    label: '默认',
    desc: model?.defaultReasoningEffort
      ? `使用当前模型默认值（${model.defaultReasoningEffort}）`
      : '使用当前 Codex 模型的默认推理强度',
  }];
  const seen = new Set(['default']);
  for (const item of supported) {
    const value = String(item?.reasoningEffort || item?.reasoning_effort || item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    entries.push({
      value,
      label: value.charAt(0).toUpperCase() + value.slice(1),
      desc: String(item?.description || `Codex 推理强度：${value}`),
    });
  }
  return entries.length > 1 ? entries : CODEX_FALLBACK_EFFORT_ENTRIES;
}

async function getEffortMenuPayload(session, agent) {
  const normalizedAgent = normalizeAgent(agent);
  if (normalizedAgent === 'codex' && CODEX_TRANSPORT === 'app-server' && session) {
    try {
      const spawnSpec = buildCodexSpawnSpec(session, { transport: 'app-server' });
      if (!spawnSpec?.error) {
        const runtime = await ensureCodexAppRuntime(session, spawnSpec);
        const result = await runtime.client.request('model/list', { limit: 100 }, { timeoutMs: 15_000 });
        return {
          type: 'effort_list',
          sessionId: session.id,
          agent: 'codex',
          entries: codexEffortEntries(result?.data || result?.models || [], session.model || ''),
          current: session.effort || 'default',
          command: 'effort',
          source: 'codex-app-server',
        };
      }
    } catch (error) {
      plog('WARN', 'codex_effort_menu_failed', { error: error.message });
    }
  }
  if (normalizedAgent === 'pi' && PI_TRANSPORT === 'rpc' && session) {
    let current = session.thinking || 'default';
    try {
      const spawnSpec = buildPiSpawnSpec(session, { transport: 'rpc' });
      if (!spawnSpec?.error) {
        const runtime = await ensurePiRpcRuntime(session, spawnSpec);
        const state = (await runtime.client.request({ type: 'get_state' }, { timeoutMs: 15_000 })).data;
        persistPiRpcState(runtime, state);
        current = session.thinking || state?.thinkingLevel || 'default';
      }
    } catch (error) {
      plog('WARN', 'pi_thinking_menu_failed', { error: error.message });
    }
    return {
      type: 'effort_list',
      sessionId: session.id,
      agent: 'pi',
      entries: PI_THINKING_ENTRIES,
      current,
      command: 'thinking',
      source: 'pi-rpc',
    };
  }
  return {
    type: 'effort_list',
    sessionId: session?.id || null,
    agent: normalizedAgent,
    entries: normalizedAgent === 'codex' ? CODEX_FALLBACK_EFFORT_ENTRIES : CLAUDE_EFFORT_ENTRIES,
    current: session?.effort || 'default',
    command: 'effort',
    source: normalizedAgent === 'claude' ? 'claude-cli' : null,
  };
}

function extractClaudeModelMapFromEnv(env) {
  const map = {};
  if (env?.ANTHROPIC_DEFAULT_OPUS_MODEL) map.opus = String(env.ANTHROPIC_DEFAULT_OPUS_MODEL).trim();
  if (env?.ANTHROPIC_DEFAULT_SONNET_MODEL) map.sonnet = String(env.ANTHROPIC_DEFAULT_SONNET_MODEL).trim();
  if (env?.ANTHROPIC_DEFAULT_HAIKU_MODEL) map.haiku = String(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).trim();
  if (!map.opus && env?.ANTHROPIC_MODEL) map.opus = String(env.ANTHROPIC_MODEL).trim();
  return Object.keys(map).length > 0 ? map : null;
}

function loadClaudeLocalModelMap() {
  const settingsEnv = readClaudeSettingsEnv();
  const settingsMap = extractClaudeModelMapFromEnv(settingsEnv);
  if (settingsMap) return settingsMap;

  try {
    const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const claudeJsonMap = extractClaudeModelMapFromEnv(raw?.env || {});
      if (claudeJsonMap) return claudeJsonMap;
    }
  } catch {}

  const processMap = extractClaudeModelMapFromEnv(process.env || {});
  return processMap;
}

function fileContentFingerprint(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 'missing';
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return 'unreadable';
  }
}

// Apply model config to runtime MODEL_MAP only (env vars are injected per-spawn, not here)
const CLAUDE_SETTINGS_PATH = path.join(getClaudeConfigDir(), 'settings.json');
const SETTINGS_API_KEYS = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_REASONING_MODEL'];
const LOCAL_CLAUDE_BRIDGE_BASE_RE = /^http:\/\/127\.0\.0\.1:\d+\/anthropic\/?$/i;

function readClaudeSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readClaudeSettingsSnapshot() {
  const exists = fs.existsSync(CLAUDE_SETTINGS_PATH);
  return {
    exists,
    settings: readClaudeSettings(),
  };
}

function writeClaudeSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    writeJsonAtomic(CLAUDE_SETTINGS_PATH, settings && typeof settings === 'object' ? settings : {});
  } catch {}
}

function deleteClaudeSettingsFile() {
  try {
    fs.unlinkSync(CLAUDE_SETTINGS_PATH);
  } catch {}
}

function stripManagedClaudeSettingsEnv(env) {
  const cleanedEnv = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (!SETTINGS_API_KEYS.includes(k)) cleanedEnv[k] = v;
  }
  return cleanedEnv;
}

function extractManagedClaudeSettingsEnv(env) {
  const managedEnv = {};
  for (const key of SETTINGS_API_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(env || {}, key)) continue;
    const value = env[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) managedEnv[key] = normalized;
  }
  return managedEnv;
}

function buildManagedClaudeSettingsEnv(tpl, bridge) {
  const managedEnv = {};
  const defaultModel = String(tpl?.defaultModel || '').trim();
  const opusModel = String(tpl?.opusModel || defaultModel || '').trim();
  const sonnetModel = String(tpl?.sonnetModel || defaultModel || '').trim();
  const haikuModel = String(tpl?.haikuModel || defaultModel || '').trim();

  if (bridge?.token) {
    managedEnv.ANTHROPIC_API_KEY = String(bridge.token).trim();
  } else if (tpl?.apiKey) {
    managedEnv.ANTHROPIC_API_KEY = String(tpl.apiKey).trim();
  }
  if (bridge?.anthropicBaseUrl) managedEnv.ANTHROPIC_BASE_URL = String(bridge.anthropicBaseUrl).trim();
  else if (tpl?.apiBase) managedEnv.ANTHROPIC_BASE_URL = String(tpl.apiBase).trim();
  if (defaultModel) managedEnv.ANTHROPIC_MODEL = defaultModel;
  if (opusModel) managedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
  if (sonnetModel) managedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
  if (haikuModel) managedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
  return managedEnv;
}

function managedClaudeSettingsEnvEquals(left, right) {
  const normalizedLeft = extractManagedClaudeSettingsEnv(left);
  const normalizedRight = extractManagedClaudeSettingsEnv(right);
  const keys = new Set([...Object.keys(normalizedLeft), ...Object.keys(normalizedRight)]);
  for (const key of keys) {
    if (String(normalizedLeft[key] || '') !== String(normalizedRight[key] || '')) return false;
  }
  return true;
}

function looksLikeManagedClaudeBridgeEnv(env, bridgeTokens) {
  const managedEnv = extractManagedClaudeSettingsEnv(env);
  const tokenSet = new Set(
    Array.isArray(bridgeTokens)
      ? bridgeTokens.map((token) => String(token || '').trim()).filter(Boolean)
      : [String(bridgeTokens || '').trim()].filter(Boolean)
  );
  if (!tokenSet.size) return false;
  return tokenSet.has(String(managedEnv.ANTHROPIC_API_KEY || '').trim())
    && LOCAL_CLAUDE_BRIDGE_BASE_RE.test(String(managedEnv.ANTHROPIC_BASE_URL || ''));
}

function loadClaudeSettingsBackup() {
  const raw = readCachedJsonConfig(CLAUDE_SETTINGS_BACKUP_PATH);
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version) !== 2) {
    clearClaudeSettingsBackup();
    return null;
  }
  return {
    version: 2,
    exists: raw.exists !== false,
    settings: raw.settings && typeof raw.settings === 'object'
      ? cloneJson(raw.settings)
      : null,
    capturedAt: String(raw.capturedAt || '').trim() || null,
  };
}

function saveClaudeSettingsBackup(snapshot) {
  writeCachedJsonConfig(CLAUDE_SETTINGS_BACKUP_PATH, {
    version: 2,
    exists: !!snapshot?.exists,
    settings: snapshot?.exists && snapshot?.settings && typeof snapshot.settings === 'object'
      ? cloneJson(snapshot.settings)
      : null,
    capturedAt: new Date().toISOString(),
  });
}

function clearClaudeSettingsBackup() {
  deleteCachedJsonConfig(CLAUDE_SETTINGS_BACKUP_PATH);
}

function ensureClaudeSettingsBackupForCustom(currentSnapshot, nextManagedEnv, bridge) {
  if (loadClaudeSettingsBackup()) return;
  const settings = currentSnapshot?.settings || {};
  const currentManagedEnv = extractManagedClaudeSettingsEnv(settings?.env || {});
  const bridgeTokens = bridge?.token ? [bridge.token] : listBridgeRuntimeTokens();
  const alreadyManaged = managedClaudeSettingsEnvEquals(currentManagedEnv, nextManagedEnv)
    || looksLikeManagedClaudeBridgeEnv(currentManagedEnv, bridgeTokens);
  if (alreadyManaged) return;
  saveClaudeSettingsBackup({
    exists: !!currentSnapshot?.exists,
    settings,
  });
}

function readClaudeSettingsEnv() {
  const settings = readClaudeSettings();
  return settings?.env && typeof settings.env === 'object' ? settings.env : {};
}

function readClaudeSettingsCredentials() {
  const env = readClaudeSettingsEnv();
  const apiKey = String(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiBase = String(env.ANTHROPIC_BASE_URL || '').trim();
  if (!apiKey || !apiBase) return null;
  return {
    apiKey,
    apiBase,
    defaultModel: String(env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || '').trim(),
  };
}

function getClaudeRuntimeFingerprint(config = null) {
  const modelConfig = config || loadModelConfig();
  const tpl = getClaudeSelectedTemplate(modelConfig);
  if (tpl) {
    return JSON.stringify({
      runtimeVersion: 3,
      mode: 'custom',
      templateName: String(tpl.name || '').trim(),
      apiBase: String(tpl.apiBase || '').trim().replace(/\/+$/, ''),
      upstreamType: String(tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai'),
    });
  }

  return JSON.stringify({
    runtimeVersion: 1,
    mode: 'local',
    settingsFingerprint: fileContentFingerprint(CLAUDE_SETTINGS_PATH),
    claudeJsonFingerprint: fileContentFingerprint(path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json')),
  });
}

function applyCustomTemplateToSettings(tpl, existingBridge) {
  let bridge = existingBridge || null;
  if (!bridge) {
    try {
      bridge = ensureBridgeRuntimeForTemplate(tpl);
    } catch {
      bridge = null;
    }
  }
  const currentSnapshot = readClaudeSettingsSnapshot();
  const settings = cloneJson(currentSnapshot.settings) || {};
  const managedEnv = buildManagedClaudeSettingsEnv(tpl, bridge);
  settings.env = {
    ...stripManagedClaudeSettingsEnv(settings.env),
    ...managedEnv,
  };
  writeJsonAtomic(CLAUDE_RUNTIME_SETTINGS_PATH, settings);
  return CLAUDE_RUNTIME_SETTINGS_PATH;
}

function clearClaudeRuntimeSettings() {
  try { fs.unlinkSync(CLAUDE_RUNTIME_SETTINGS_PATH); } catch {}
}

function refreshCodexGeneratedRuntimeSnapshot(context = 'runtime_refresh') {
  try {
    const result = prepareCodexCustomRuntime(loadCodexConfig());
    if (result?.error) {
      plog('WARN', context, { error: result.error });
    }
  } catch (error) {
    plog('WARN', context, { error: error.message });
  }
}

function restoreManagedClaudeSettings(previousTemplate = null, options = {}) {
  const backup = loadClaudeSettingsBackup();
  if (!backup && options.onlyIfBackupExists) return false;

  const settings = readClaudeSettings();
  const cleanedEnv = stripManagedClaudeSettingsEnv(settings.env);

  const writeMergedClaudeSettings = (nextSettings) => {
    const normalized = nextSettings && typeof nextSettings === 'object'
      ? cloneJson(nextSettings)
      : {};
    const env = normalized?.env && typeof normalized.env === 'object'
      ? Object.fromEntries(Object.entries(normalized.env).filter(([, value]) => value !== undefined && value !== null && String(value).trim()))
      : null;
    if (env && Object.keys(env).length > 0) normalized.env = env;
    else delete normalized.env;
    if (Object.keys(normalized).length > 0) writeClaudeSettings(normalized);
    else deleteClaudeSettingsFile();
  };

  if (backup) {
    const previousManagedEnv = extractManagedClaudeSettingsEnv(backup.settings?.env || {});
    const nextSettings = settings && typeof settings === 'object' ? cloneJson(settings) : {};
    nextSettings.env = {
      ...cleanedEnv,
      ...previousManagedEnv,
    };
    writeMergedClaudeSettings(nextSettings);
    clearClaudeSettingsBackup();
    return true;
  }

  const currentManagedEnv = extractManagedClaudeSettingsEnv(settings.env);
  if (!Object.keys(currentManagedEnv).length || !previousTemplate) return false;

  const fallbackManagedEnv = buildManagedClaudeSettingsEnv(previousTemplate, null);
  const bridgeTokens = listBridgeRuntimeTokens();
  const shouldClear = managedClaudeSettingsEnvEquals(currentManagedEnv, fallbackManagedEnv)
    || looksLikeManagedClaudeBridgeEnv(currentManagedEnv, bridgeTokens);
  if (!shouldClear) return false;

  settings.env = cleanedEnv;
  writeMergedClaudeSettings(settings);
  return true;
}

function applyModelConfig() {
  const config = loadModelConfig();
  const tpl = getClaudeSelectedTemplate(config);
  if (tpl) {
    const defaultModel = String(tpl.defaultModel || '').trim();
    if (tpl.opusModel || defaultModel) MODEL_MAP.opus = tpl.opusModel || defaultModel;
    if (tpl.sonnetModel || defaultModel) MODEL_MAP.sonnet = tpl.sonnetModel || defaultModel;
    if (tpl.haikuModel || defaultModel) MODEL_MAP.haiku = tpl.haikuModel || defaultModel;
    if (defaultModel || tpl.opusModel || tpl.sonnetModel || tpl.haikuModel) return;
  }
  // mode === 'local': read model names from local Claude settings / env overrides
  const localMap = loadClaudeLocalModelMap();
  if (localMap) {
    if (localMap.opus) MODEL_MAP.opus = localMap.opus;
    if (localMap.sonnet) MODEL_MAP.sonnet = localMap.sonnet;
    if (localMap.haiku) MODEL_MAP.haiku = localMap.haiku;
  }
}

// Apply on startup
applyModelConfig();
try {
  // Migrate installations from the older behavior that edited ~/.claude/settings.json.
  restoreManagedClaudeSettings(null, { onlyIfBackupExists: true });
  const activeTemplate = getActiveUnifiedTemplate();
  if (activeTemplate) {
    const bridge = ensureBridgeRuntimeForTemplate(activeTemplate);
    applyCustomTemplateToSettings(activeTemplate, bridge);
  } else {
    clearClaudeRuntimeSettings();
  }
  refreshCodexGeneratedRuntimeSnapshot('codex_runtime_refresh_on_startup');
} catch (error) {
  plog('WARN', 'bridge_startup_init_failed', { error: error.message });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function getPublicAssetVersion(name) {
  try {
    const stat = fs.statSync(path.join(PUBLIC_ROOT, name));
    return Math.trunc(stat.mtimeMs).toString(36);
  } catch {
    return 'dev';
  }
}

function renderIndexHtml() {
  const indexPath = path.join(PUBLIC_ROOT, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  return html.replace(/\b(href|src)="([^"?#]+\.(?:css|js))(?:\?[^"#]*)?(#[^"]*)?"/gi, (match, attribute, assetPath, fragment = '') => {
    if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(assetPath)) return match;
    const publicName = assetPath.replace(/^\/+/, '');
    if (!publicName || publicName.split('/').includes('..')) return match;
    return `${attribute}="${assetPath}?v=${getPublicAssetVersion(publicName)}${fragment}"`;
  });
}

// === Utility Functions ===

function wsSend(ws, data) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(data));
  } catch (error) {
    plog('WARN', 'ws_send_failed', {
      type: data?.type || null,
      error: error?.message || String(error),
    });
  }
}

function isPathInside(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9\-]/g, '');
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${sanitizeId(id)}.json`);
}

function runDir(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeId(sessionId)}-run`);
}

function attachmentDataPath(id, ext = '') {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}${ext}`);
}

function attachmentMetaPath(id) {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}.json`);
}

function safeFilename(name) {
  return String(name || 'image')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image';
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '';
  }
}

function detectMimeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}

function loadAttachmentMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(attachmentMetaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveAttachmentMeta(meta) {
  writeJsonAtomic(attachmentMetaPath(meta.id), meta);
}

function removeAttachmentById(id) {
  const meta = loadAttachmentMeta(id);
  const paths = new Set([attachmentMetaPath(id)]);
  if (meta?.path) paths.add(meta.path);
  for (const filePath of paths) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

function currentAttachmentState(meta) {
  if (!meta) return 'missing';
  const expiresAtMs = new Date(meta.expiresAt || 0).getTime();
  if (expiresAtMs && Date.now() > expiresAtMs) return 'expired';
  if (!meta.path || !fs.existsSync(meta.path)) return 'missing';
  return 'available';
}

let lastAttachmentCleanupAt = 0;

function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const normalized = [];
  for (const attachment of attachments) {
    const id = sanitizeId(attachment?.id || '');
    if (!id) continue;
    const meta = loadAttachmentMeta(id);
    const state = currentAttachmentState(meta);
    if (state === 'expired') removeAttachmentById(id);
    normalized.push({
      id,
      kind: 'image',
      filename: meta?.filename || attachment?.filename || 'image',
      mime: meta?.mime || attachment?.mime || 'image/png',
      size: meta?.size || attachment?.size || 0,
      createdAt: meta?.createdAt || attachment?.createdAt || null,
      expiresAt: meta?.expiresAt || attachment?.expiresAt || null,
      storageState: state === 'available' ? 'available' : 'expired',
    });
  }
  return normalized;
}

function resolveMessageAttachments(attachments) {
  const resolved = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    if (attachment.storageState !== 'available') continue;
    const meta = loadAttachmentMeta(attachment.id);
    if (!meta?.path || !fs.existsSync(meta.path)) continue;
    resolved.push({
      ...attachment,
      path: meta.path,
    });
  }
  return resolved;
}

function cleanupExpiredAttachments() {
  const now = Date.now();
  if (now - lastAttachmentCleanupAt < ATTACHMENT_CLEANUP_THROTTLE_MS) return;
  lastAttachmentCleanupAt = now;
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const meta = loadAttachmentMeta(id);
      if (!meta || currentAttachmentState(meta) === 'expired') {
        removeAttachmentById(id);
      }
    }
  } catch {}
}

function collectSessionAttachmentIds(session) {
  const ids = new Set();
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      const id = sanitizeId(attachment?.id || '');
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function jsonResponse(res, statusCode, payload) {
  writeHeadWithSecurity(res, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

const INITIAL_HISTORY_COUNT = 12;
const HISTORY_CHUNK_SIZE = 24;
const CONTEXT_REPLAY_RECENT_MESSAGE_LIMIT = 6;
const CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT = 900;
const CONTEXT_REPLAY_RECENT_CHAR_BUDGET = 4200;
const CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_MESSAGES = 4;
const CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_CHARS = 280;
const CONTEXT_REPLAY_FIELD_CHAR_LIMIT = 240;
const CONTEXT_REPLAY_MAX_COMPLETED_ITEMS = 3;
const CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS = 4;
const CONTEXT_REPLAY_MAX_EXACT_ITEMS = 4;
const CONTEXT_REPLAY_SUMMARY_MAX_CHARS = 3200;

function normalizeAgent(agent) {
  return VALID_AGENTS.has(agent) ? agent : 'claude';
}

function normalizeRuntimeContextEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const runtimeId = entry.runtimeId ? String(entry.runtimeId) : null;
  const runtimeFingerprint = entry.runtimeFingerprint ? String(entry.runtimeFingerprint) : null;
  const descriptor = entry.descriptor && typeof entry.descriptor === 'object' && !Array.isArray(entry.descriptor)
    ? cloneJson(entry.descriptor)
    : null;
  const updatedAt = entry.updatedAt ? String(entry.updatedAt) : null;
  const model = String(entry.model || '').trim();
  if (!runtimeId && !runtimeFingerprint && !descriptor && !updatedAt) return null;
  return {
    runtimeId,
    runtimeFingerprint,
    updatedAt,
    model,
    descriptor,
    legacy: !!entry.legacy,
  };
}

function normalizeRuntimeApiBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeRuntimeUpstreamType(value) {
  return String(value === 'anthropic' ? 'anthropic' : (value || 'openai')).toLowerCase();
}

function buildRuntimeChannelIdentityDescriptor(agent, descriptor = null) {
  const normalizedAgent = normalizeAgent(agent);
  const mode = String(descriptor?.mode || 'local').toLowerCase();
  if (mode === 'legacy') {
    return {
      mode: 'legacy',
      runtimeIdHint: String(descriptor?.runtimeIdHint || ''),
      runtimeFingerprintHint: String(descriptor?.runtimeFingerprintHint || ''),
    };
  }
  if (mode === 'error') {
    return {
      mode: 'error',
      error: String(descriptor?.error || ''),
    };
  }
  if (mode === 'local') {
    return { mode: 'local' };
  }
  if (normalizedAgent === 'codex') {
    return {
      mode: 'remote',
      sourceName: String(descriptor?.sourceName || ''),
      apiBase: normalizeRuntimeApiBase(descriptor?.apiBase),
      upstreamType: normalizeRuntimeUpstreamType(descriptor?.upstreamType),
    };
  }
  return {
    mode: 'custom',
    templateName: String(descriptor?.templateName || ''),
    apiBase: normalizeRuntimeApiBase(descriptor?.apiBase),
    upstreamType: normalizeRuntimeUpstreamType(descriptor?.upstreamType),
  };
}

function normalizeRuntimeFingerprintForComparison(agent, fingerprint) {
  const raw = String(fingerprint || '').trim();
  if (!raw) return null;
  if (raw.startsWith('error:')) {
    return { mode: 'error', error: raw.slice('error:'.length) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { raw };
  }
  const mode = String(parsed.mode || 'local').toLowerCase();
  if (mode === 'local') {
    if (normalizeAgent(agent) === 'codex') {
      return {
        mode: 'local',
        configFingerprint: String(parsed.configFingerprint || ''),
        authFingerprint: String(parsed.authFingerprint || ''),
      };
    }
    return {
      mode: 'local',
      settingsFingerprint: String(parsed.settingsFingerprint || ''),
      claudeJsonFingerprint: String(parsed.claudeJsonFingerprint || ''),
    };
  }
  if (mode === 'error') {
    return { mode: 'error', error: String(parsed.error || '') };
  }
  return buildRuntimeChannelIdentityDescriptor(agent, parsed);
}

function runtimeFingerprintsCompatible(agent, left, right) {
  const normalizedLeft = normalizeRuntimeFingerprintForComparison(agent, left);
  const normalizedRight = normalizeRuntimeFingerprintForComparison(agent, right);
  if (!normalizedLeft || !normalizedRight) return false;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function runtimeChannelDescriptorsCompatible(agent, left, right) {
  const normalizedLeft = buildRuntimeChannelIdentityDescriptor(agent, left);
  const normalizedRight = buildRuntimeChannelIdentityDescriptor(agent, right);
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function ensureRuntimeContextStore(session) {
  if (!session || typeof session !== 'object') {
    return { claude: {}, codex: {}, pi: {} };
  }
  const store = session.runtimeContexts && typeof session.runtimeContexts === 'object' && !Array.isArray(session.runtimeContexts)
    ? session.runtimeContexts
    : {};
  if (!store.claude || typeof store.claude !== 'object' || Array.isArray(store.claude)) store.claude = {};
  if (!store.codex || typeof store.codex !== 'object' || Array.isArray(store.codex)) store.codex = {};
  if (!store.pi || typeof store.pi !== 'object' || Array.isArray(store.pi)) store.pi = {};
  session.runtimeContexts = store;
  return store;
}

function currentSessionModelOverride(session) {
  return String(session?.model || '').trim();
}

function buildClaudeRuntimeChannelDescriptor(session, options = {}) {
  const modelConfig = options.modelConfig || loadModelConfig();
  const explicitModel = currentSessionModelOverride(session);
  const tpl = getClaudeSelectedTemplate(modelConfig);
  if (tpl) {
    return {
      mode: 'custom',
      templateName: String(tpl.name || ''),
      apiBase: String(tpl.apiBase || ''),
      upstreamType: String(tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai'),
      defaultModel: String(tpl.defaultModel || ''),
      explicitModel,
    };
  }
  return {
    mode: 'local',
    explicitModel,
  };
}

function buildCodexRuntimeChannelDescriptor(session, options = {}) {
  const codexConfig = options.codexConfig || loadCodexConfig();
  const explicitModel = currentSessionModelOverride(session);
  const source = resolveCodexActiveSource(codexConfig);
  if (!source || source.mode === 'local') {
    return {
      mode: 'local',
      explicitModel,
    };
  }
  if (source.error) {
    return {
      mode: 'error',
      error: String(source.error || ''),
      explicitModel,
    };
  }
  return {
    mode: String(source.mode || 'unified'),
    sourceName: String(source.name || ''),
    apiBase: String(source.apiBase || ''),
    upstreamType: String(source.upstreamType || 'openai'),
    defaultModel: String(source.defaultModel || ''),
    explicitModel,
  };
}

function buildPiRuntimeChannelDescriptor(session, options = {}) {
  const piConfig = options.piConfig || loadPiConfig();
  const explicitModel = currentSessionModelOverride(session);
  const source = resolvePiActiveSource(piConfig);
  if (!source || source.mode === 'local') {
    return {
      mode: 'local',
      explicitModel,
      provider: String(session?.piProvider || '').trim() || null,
    };
  }
  if (source.error) {
    return {
      mode: 'error',
      error: String(source.error || ''),
      explicitModel,
    };
  }
  return {
    mode: 'unified',
    sourceName: String(source.name || ''),
    apiBase: String(source.apiBase || ''),
    upstreamType: String(source.upstreamType || 'openai'),
    defaultModel: String(source.defaultModel || ''),
    explicitModel,
    provider: PI_MANAGED_PROVIDER_ID,
  };
}

function buildRuntimeChannelDescriptor(session, agent, options = {}) {
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  if (normalizedAgent === 'codex') return buildCodexRuntimeChannelDescriptor(session, options);
  if (normalizedAgent === 'pi') return buildPiRuntimeChannelDescriptor(session);
  return buildClaudeRuntimeChannelDescriptor(session, options);
}

function buildRuntimeChannelKey(agent, descriptor) {
  const normalizedAgent = normalizeAgent(agent);
  const identityDescriptor = buildRuntimeChannelIdentityDescriptor(normalizedAgent, descriptor);
  const digest = crypto.createHash('sha1')
    .update(JSON.stringify(identityDescriptor))
    .digest('hex');
  return `${normalizedAgent}:${digest}`;
}

function getLegacyRuntimeMirror(session, agent) {
  if (!session) return { runtimeId: null, runtimeFingerprint: null };
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  if (normalizedAgent === 'codex') {
    return {
      runtimeId: session.codexThreadId ? String(session.codexThreadId) : null,
      runtimeFingerprint: session.codexRuntimeFingerprint ? String(session.codexRuntimeFingerprint) : null,
    };
  }
  if (normalizedAgent === 'pi') {
    return {
      runtimeId: session.piSessionId ? String(session.piSessionId) : null,
      runtimeFingerprint: session.piRuntimeFingerprint ? String(session.piRuntimeFingerprint) : null,
    };
  }
  return {
    runtimeId: session.claudeSessionId ? String(session.claudeSessionId) : null,
    runtimeFingerprint: session.claudeRuntimeFingerprint ? String(session.claudeRuntimeFingerprint) : null,
  };
}

function listRuntimeContextEntries(session, agent) {
  const store = ensureRuntimeContextStore(session)[normalizeAgent(agent || session?.agent)] || {};
  return Object.entries(store)
    .map(([key, rawEntry]) => ({ key, entry: normalizeRuntimeContextEntry(rawEntry) }))
    .filter((item) => item.entry)
    .sort((a, b) => {
      const aTs = itemTimestampMs(a.entry?.updatedAt);
      const bTs = itemTimestampMs(b.entry?.updatedAt);
      return bTs - aTs;
    });
}

function itemTimestampMs(iso) {
  const ms = iso ? Date.parse(iso) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function currentAgentRuntimeFingerprint(agent, options = {}) {
  const normalizedAgent = normalizeAgent(agent);
  if (normalizedAgent === 'codex') {
    return getCodexRuntimeFingerprint(options.codexConfig);
  }
  if (normalizedAgent === 'pi') {
    return getPiRuntimeFingerprint(options.piConfig);
  }
  return getClaudeRuntimeFingerprint(options.modelConfig);
}

function canAdoptLegacyRuntimeForCurrentChannel(agent, currentDescriptor, legacy, options = {}) {
  if (!legacy?.runtimeId) return false;
  const currentFingerprint = currentAgentRuntimeFingerprint(agent, options);
  if (legacy.runtimeFingerprint && currentFingerprint) {
    return runtimeFingerprintsCompatible(agent, legacy.runtimeFingerprint, currentFingerprint);
  }
  if (legacy.runtimeFingerprint) return false;
  return currentDescriptor?.mode === 'local';
}

function buildLegacyRuntimeChannelDescriptor(session, agent, _currentDescriptor, legacy) {
  return {
    mode: 'legacy',
    legacy: true,
    importedFrom: String(session?.importedFrom || ''),
    runtimeIdHint: String(legacy?.runtimeId || ''),
    runtimeFingerprintHint: String(legacy?.runtimeFingerprint || ''),
    explicitModel: currentSessionModelOverride(session),
    agent: normalizeAgent(agent),
  };
}

function ensureLegacyRuntimeContextPreserved(session, agent, options = {}) {
  if (!session) return;
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  const legacy = getLegacyRuntimeMirror(session, normalizedAgent);
  if (!legacy.runtimeId) return;
  const existing = listRuntimeContextEntries(session, normalizedAgent)
    .find((item) => item.entry?.runtimeId === legacy.runtimeId);
  if (existing) return;

  const store = ensureRuntimeContextStore(session)[normalizedAgent];
  const currentDescriptor = buildRuntimeChannelDescriptor(session, normalizedAgent, options);
  const useCurrentChannel = canAdoptLegacyRuntimeForCurrentChannel(normalizedAgent, currentDescriptor, legacy, options);
  const descriptor = useCurrentChannel
    ? currentDescriptor
    : buildLegacyRuntimeChannelDescriptor(session, normalizedAgent, currentDescriptor, legacy);
  const key = buildRuntimeChannelKey(normalizedAgent, descriptor);
  const normalized = normalizeRuntimeContextEntry({
    runtimeId: legacy.runtimeId,
    runtimeFingerprint: legacy.runtimeFingerprint,
    updatedAt: session.updated || session.created || new Date().toISOString(),
    model: currentSessionModelOverride(session),
    descriptor,
    legacy: !useCurrentChannel,
  });
  if (normalized) {
    store[key] = normalized;
  }
}

function getRuntimeSessionState(session, options = {}) {
  const normalizedAgent = normalizeAgent(options.agent || session?.agent);
  if (!session) {
    return {
      agent: normalizedAgent,
      key: options.channelKey || null,
      descriptor: options.channelDescriptor || null,
      entry: null,
      store: null,
    };
  }

  ensureRuntimeContextStore(session);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);

  const descriptor = options.channelDescriptor || buildRuntimeChannelDescriptor(session, normalizedAgent, options);
  const key = options.channelKey || buildRuntimeChannelKey(normalizedAgent, descriptor);
  const store = ensureRuntimeContextStore(session)[normalizedAgent];
  let entry = normalizeRuntimeContextEntry(store[key]);

  if (!entry) {
    const migrated = listRuntimeContextEntries(session, normalizedAgent)
      .find((item) => item.key !== key && runtimeChannelDescriptorsCompatible(normalizedAgent, descriptor, item.entry?.descriptor || null));
    if (migrated?.entry) {
      entry = normalizeRuntimeContextEntry({
        ...migrated.entry,
        descriptor,
        updatedAt: migrated.entry.updatedAt || session.updated || session.created || new Date().toISOString(),
      });
      if (entry) {
        store[key] = entry;
        delete store[migrated.key];
      }
    }
  }

  if (!entry && options.create) {
    entry = normalizeRuntimeContextEntry({
      runtimeId: null,
      runtimeFingerprint: null,
      updatedAt: session.updated || session.created || new Date().toISOString(),
      model: currentSessionModelOverride(session),
      descriptor,
      legacy: false,
    });
  }

  if (entry) {
    if (!entry.descriptor) entry.descriptor = cloneJson(descriptor);
    if (!entry.updatedAt) entry.updatedAt = session.updated || session.created || new Date().toISOString();
    entry.model = currentSessionModelOverride(session);
    store[key] = entry;
  }

  return {
    agent: normalizedAgent,
    key,
    descriptor,
    entry,
    store,
  };
}

function syncLegacyRuntimeMirror(session) {
  if (!session || typeof session !== 'object') return;
  const agent = getSessionAgent(session);
  const state = getRuntimeSessionState(session, { agent });
  if (agent === 'codex') {
    session.codexThreadId = state.entry?.runtimeId || null;
    session.codexRuntimeFingerprint = state.entry?.runtimeFingerprint || null;
    session.claudeSessionId = null;
    session.claudeRuntimeFingerprint = null;
    session.piSessionId = null;
    session.piRuntimeFingerprint = null;
  } else if (agent === 'pi') {
    session.piSessionId = state.entry?.runtimeId || null;
    session.piRuntimeFingerprint = state.entry?.runtimeFingerprint || null;
    session.claudeSessionId = null;
    session.claudeRuntimeFingerprint = null;
    session.codexThreadId = null;
    session.codexRuntimeFingerprint = null;
  } else {
    session.claudeSessionId = state.entry?.runtimeId || null;
    session.claudeRuntimeFingerprint = state.entry?.runtimeFingerprint || null;
    session.codexThreadId = null;
    session.codexRuntimeFingerprint = null;
    session.piSessionId = null;
    session.piRuntimeFingerprint = null;
  }
}

function setRuntimeSessionState(session, updates = {}, options = {}) {
  if (!session) return null;
  const state = getRuntimeSessionState(session, { ...options, create: true });
  if (!state.store) return null;
  const nextEntry = {
    ...(state.entry || {}),
    runtimeId: Object.prototype.hasOwnProperty.call(updates, 'runtimeId')
      ? (updates.runtimeId ? String(updates.runtimeId) : null)
      : (state.entry?.runtimeId || null),
    runtimeFingerprint: Object.prototype.hasOwnProperty.call(updates, 'runtimeFingerprint')
      ? (updates.runtimeFingerprint ? String(updates.runtimeFingerprint) : null)
      : (state.entry?.runtimeFingerprint || null),
    updatedAt: new Date().toISOString(),
    model: currentSessionModelOverride(session),
    descriptor: cloneJson(updates.channelDescriptor || state.descriptor),
    legacy: false,
  };
  const normalized = normalizeRuntimeContextEntry(nextEntry);
  if (normalized) {
    state.store[state.key] = normalized;
  } else {
    delete state.store[state.key];
  }
  syncLegacyRuntimeMirror(session);
  return normalized;
}

function getRuntimeSessionId(session, options = {}) {
  if (!session) return null;
  const state = getRuntimeSessionState(session, options);
  syncLegacyRuntimeMirror(session);
  return state.entry?.runtimeId || null;
}

function getRuntimeSessionFingerprint(session, options = {}) {
  if (!session) return null;
  const state = getRuntimeSessionState(session, options);
  return state.entry?.runtimeFingerprint || null;
}

function setRuntimeSessionId(session, runtimeId, options = {}) {
  return setRuntimeSessionState(session, { runtimeId }, options);
}

function setRuntimeSessionFingerprint(session, runtimeFingerprint, options = {}) {
  return setRuntimeSessionState(session, { runtimeFingerprint }, options);
}

function clearRuntimeSessionId(session, options = {}) {
  if (!session) return;
  const normalizedAgent = normalizeAgent(options.agent || session?.agent);
  ensureRuntimeContextStore(session);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);
  const clearAllChannels = options.allChannels !== false && !options.currentOnly;
  if (clearAllChannels) {
    session.runtimeContexts[normalizedAgent] = {};
  } else {
    const state = getRuntimeSessionState(session, options);
    if (state.store && state.key) {
      delete state.store[state.key];
    }
  }
  syncLegacyRuntimeMirror(session);
}

function getFallbackRuntimeSessionState(session, options = {}) {
  if (!session) return null;
  const normalizedAgent = normalizeAgent(options.agent || session?.agent);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);
  const currentState = getRuntimeSessionState(session, options);
  const excludedKey = options.excludeChannelKey || currentState.key;
  const fallback = listRuntimeContextEntries(session, normalizedAgent)
    .find((item) => item.entry?.runtimeId && item.key !== excludedKey);
  if (!fallback) return null;
  return {
    agent: normalizedAgent,
    key: fallback.key,
    descriptor: fallback.entry?.descriptor || null,
    entry: fallback.entry,
  };
}

function getAllRuntimeSessionIds(session, agent, options = {}) {
  if (!session) return [];
  const normalizedAgent = normalizeAgent(agent || session?.agent);
  ensureLegacyRuntimeContextPreserved(session, normalizedAgent, options);
  return Array.from(new Set(
    listRuntimeContextEntries(session, normalizedAgent)
      .map((item) => item.entry?.runtimeId || null)
      .filter(Boolean)
  ));
}

function sessionHasRuntimeId(session, agent, runtimeId, options = {}) {
  if (!runtimeId) return false;
  return getAllRuntimeSessionIds(session, agent, options).includes(String(runtimeId));
}

function getPreferredRuntimeSessionId(session, agent, options = {}) {
  if (!session) return null;
  const current = getRuntimeSessionId(session, { ...options, agent });
  if (current) return current;
  const fallback = getFallbackRuntimeSessionState(session, { ...options, agent });
  return fallback?.entry?.runtimeId || null;
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  session.agent = normalizeAgent(session.agent);
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeSessionId')) session.claudeSessionId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeRuntimeFingerprint')) session.claudeRuntimeFingerprint = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexThreadId')) session.codexThreadId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexRuntimeFingerprint')) session.codexRuntimeFingerprint = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'piSessionId')) session.piSessionId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'piRuntimeFingerprint')) session.piRuntimeFingerprint = null;
  if (session.agent === 'pi' && !session.piSessionId && session.claudeSessionId) {
    session.piSessionId = session.claudeSessionId;
    session.piRuntimeFingerprint = session.claudeRuntimeFingerprint || null;
    session.claudeSessionId = null;
    session.claudeRuntimeFingerprint = null;
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'totalCost')) session.totalCost = 0;
  if (!Object.prototype.hasOwnProperty.call(session, 'projectId')) session.projectId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalUsage') || !session.totalUsage) {
    session.totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'messages')) session.messages = [];
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      if (message.attachments) {
        return { ...message, attachments: normalizeMessageAttachments(message.attachments) };
      }
      return message;
    });
  }
  const runtimeContexts = ensureRuntimeContextStore(session);
  for (const agentName of ['claude', 'codex', 'pi']) {
    const store = runtimeContexts[agentName];
    for (const [key, rawEntry] of Object.entries(store)) {
      const normalized = normalizeRuntimeContextEntry(rawEntry);
      if (normalized) store[key] = normalized;
      else delete store[key];
    }
  }
  ensureLegacyRuntimeContextPreserved(session, session.agent);
  syncLegacyRuntimeMirror(session);
  return session;
}

function getSessionAgent(session) {
  return normalizeAgent(session?.agent);
}

function isClaudeSession(session) {
  return getSessionAgent(session) === 'claude';
}

function isCodexSession(session) {
  return getSessionAgent(session) === 'codex';
}

function isPiSession(session) {
  return getSessionAgent(session) === 'pi';
}

function loadSession(id) {
  try {
    return normalizeSession(JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')));
  } catch {
    return null;
  }
}

function saveSession(session) {
  normalizeSession(session);
  writeJsonAtomic(sessionPath(session.id), session);
  invalidateSessionListCache();
  invalidateImportedSessionIdsCache();
}

function normalizeClaudeModelAliasInput(modelInput) {
  const raw = String(modelInput || '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'opus-1m' || lower === 'opus_1m') return 'opus[1m]';
  if (lower === 'sonnet-1m' || lower === 'sonnet_1m') return 'sonnet[1m]';
  return raw;
}

function getClaudeModelMapValue(alias) {
  const key = String(alias || '');
  if (!Object.prototype.hasOwnProperty.call(MODEL_MAP, key)) return null;
  const value = MODEL_MAP[key];
  return typeof value === 'string' && value ? value : null;
}

function modelShortName(fullModel) {
  if (!fullModel) return null;
  const normalized = normalizeClaudeModelAliasInput(fullModel);
  const lower = normalized.toLowerCase();
  if (lower === 'opus' || lower === 'sonnet' || lower === 'haiku' || lower === 'opus[1m]' || lower === 'sonnet[1m]') {
    return lower;
  }
  const isOneM = lower.endsWith('[1m]');
  const baseModel = isOneM ? normalized.slice(0, -4) : normalized;
  const baseLower = baseModel.toLowerCase();
  const entry = Object.entries(MODEL_MAP).find(([, value]) => String(value || '').toLowerCase() === baseLower);
  return entry ? (isOneM ? `${entry[0]}[1m]` : entry[0]) : null;
}

function getClaudeModelMenuLabel(modelOrAlias) {
  if (!modelOrAlias) return null;
  const normalized = normalizeClaudeModelAliasInput(modelOrAlias);
  const lower = normalized.toLowerCase();
  if (lower === 'default') {
    return CLAUDE_MODEL_MENU_ENTRIES.find((entry) => entry.alias === 'default')?.label || '默认';
  }
  const alias = modelShortName(normalized) || normalized;
  const entry = CLAUDE_MODEL_MENU_ENTRIES.find((item) => item.alias.toLowerCase() === String(alias).toLowerCase());
  return entry?.label || null;
}

function getClaudeModelMenuEntries() {
  const config = loadModelConfig();
  const useResolvedIds = config.mode === 'custom' && !!config.activeTemplate;
  return CLAUDE_MODEL_MENU_ENTRIES.map((entry) => {
    if (entry.alias === 'default') {
      return { ...entry, value: 'default' };
    }
    const isOneM = entry.alias.endsWith('[1m]');
    const baseAlias = isOneM ? entry.alias.slice(0, -4) : entry.alias;
    let value = entry.alias;
    const mappedModel = getClaudeModelMapValue(baseAlias);
    if (useResolvedIds && mappedModel) {
      value = isOneM ? `${mappedModel}[1m]` : mappedModel;
    }
    return { ...entry, value };
  });
}

function resolveClaudeModelInput(modelInput) {
  const raw = String(modelInput || '').trim();
  if (!raw) return null;
  const normalized = normalizeClaudeModelAliasInput(raw);
  const lower = normalized.toLowerCase();
  if (lower === 'default') {
    return { resolvedModel: null, resolvedAlias: 'default' };
  }
  if (lower.endsWith('[1m]')) {
    const baseAlias = lower.slice(0, -4);
    const mappedModel = getClaudeModelMapValue(baseAlias);
    if (mappedModel) {
      return {
        resolvedModel: `${mappedModel}[1m]`,
        resolvedAlias: `${baseAlias}[1m]`,
      };
    }
  }
  const mappedModel = getClaudeModelMapValue(lower);
  if (mappedModel) {
    return { resolvedModel: mappedModel, resolvedAlias: lower };
  }
  const exactEntry = Object.entries(MODEL_MAP).find(([, value]) => String(value || '').toLowerCase() === lower);
  if (exactEntry) {
    return { resolvedModel: exactEntry[1], resolvedAlias: exactEntry[0] };
  }
  const oneMEntry = Object.entries(MODEL_MAP).find(([, value]) => `${String(value || '').toLowerCase()}[1m]` === lower);
  if (oneMEntry) {
    return {
      resolvedModel: `${oneMEntry[1]}[1m]`,
      resolvedAlias: `${oneMEntry[0]}[1m]`,
    };
  }
  return { resolvedModel: normalized, resolvedAlias: modelShortName(normalized) || normalized };
}

/** Session-level model field for WS payloads — only explicit overrides, never invent defaults. */
function sessionModelLabel(session) {
  if (!session?.model) return null;
  return isClaudeSession(session) ? (modelShortName(session.model) || session.model) : session.model;
}

/**
 * Resolve a concrete model id for spawn / message labels (never "default" placeholder).
 * Order: session override → channel/provider default → agent built-in fallback.
 * Do NOT use this for session.model persistence on new_session.
 */
function resolveEffectiveModelId(session) {
  const agent = getSessionAgent(session);
  const explicit = String(session?.model || '').trim();
  if (explicit && !/^default$/i.test(explicit)) {
    return agent === 'claude' ? (modelShortName(explicit) || explicit) : explicit;
  }

  try {
    if (agent === 'claude') {
      const config = loadModelConfig();
      if (config.mode === 'custom') {
        const tpl = getClaudeSelectedTemplate(config);
        const fromTpl = String(tpl?.defaultModel || tpl?.sonnetModel || tpl?.opusModel || '').trim();
        if (fromTpl) return fromTpl;
      }
      const local = readClaudeSettingsCredentials();
      if (local?.defaultModel) return String(local.defaultModel).trim();
      // Runtime map sonnet is the Claude Code default.
      return String(MODEL_MAP.sonnet || DEFAULT_CLAUDE_MODEL_MAP.sonnet || '').trim() || null;
    }
    if (agent === 'codex') {
      const source = resolveCodexActiveSource(loadCodexConfig());
      if (source?.defaultModel) return String(source.defaultModel).trim();
      return null;
    }
    if (agent === 'pi') {
      const source = resolvePiActiveSource(loadPiConfig());
      if (source?.defaultModel) return String(source.defaultModel).trim();
      // Local Pi defaults from ~/.pi/agent/settings.json
      try {
        const piDir = process.env.PI_CODING_AGENT_DIR
          || path.join(process.env.HOME || process.env.USERPROFILE || '', '.pi', 'agent');
        const settings = JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8'));
        const model = String(settings?.defaultModel || '').trim();
        const provider = String(settings?.defaultProvider || '').trim();
        if (model && provider) return `${provider}/${model}`;
        if (model) return model;
      } catch {}
      return null;
    }
  } catch {}
  return null;
}

function getRuntimeContextCount(session, agent) {
  return listRuntimeContextEntries(session, agent).filter((item) => item.entry?.runtimeId).length;
}

function formatRuntimeChannelLabel(agent, descriptor) {
  const normalizedAgent = normalizeAgent(agent);
  const mode = String(descriptor?.mode || 'local').toLowerCase();
  if (normalizedAgent === 'claude') {
    if (mode === 'custom') return descriptor?.templateName ? `Claude · ${descriptor.templateName}` : 'Claude · AI 提供商';
    if (mode === 'legacy') return 'Claude · 旧线程';
    return 'Claude · 本地配置';
  }
  if (normalizedAgent === 'pi') {
    if (mode === 'unified' || mode === 'custom') {
      return descriptor?.sourceName ? `Pi · ${descriptor.sourceName}` : 'Pi · AI 提供商';
    }
    if (mode === 'error') return 'Pi · 配置异常';
    if (descriptor?.provider && descriptor.provider !== PI_MANAGED_PROVIDER_ID) {
      return `Pi · ${descriptor.provider}`;
    }
    return 'Pi · 本地配置';
  }
  if (mode === 'unified' || mode === 'custom') {
    return descriptor?.sourceName ? `Codex · ${descriptor.sourceName}` : 'Codex · AI 提供商';
  }
  if (mode === 'legacy') return 'Codex · 旧线程';
  if (mode === 'error') return 'Codex · 配置异常';
  return 'Codex · 本地配置';
}

function buildActiveRuntimeSummary(session, options = {}) {
  if (!session) return null;
  const agent = normalizeAgent(options.agent || session.agent);
  const state = getRuntimeSessionState(session, { ...options, agent });
  const descriptor = state.descriptor || {};
  const explicitModel = String(session?.model || '').trim();
  const fallbackModel = String(descriptor.defaultModel || '').trim();
  const summaryModel = explicitModel || fallbackModel || '';
  const displayModel = sessionModelLabel(session) || summaryModel;
  return {
    agent,
    channelKey: state.key || null,
    channelLabel: formatRuntimeChannelLabel(agent, descriptor),
    mode: String(descriptor.mode || 'local'),
    model: summaryModel,
    displayModel,
    explicitModel,
    defaultModel: fallbackModel,
    runtimeIdPresent: !!state.entry?.runtimeId,
    runtimeId: state.entry?.runtimeId || null,
    runtimeCount: getRuntimeContextCount(session, agent),
  };
}

function buildSessionRuntimeMeta(session, options = {}) {
  const activeRuntime = buildActiveRuntimeSummary(session, options);
  return {
    activeChannelKey: activeRuntime?.channelKey || null,
    activeRuntime,
    runtimeCount: activeRuntime?.runtimeCount || 0,
  };
}

function splitHistoryMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= INITIAL_HISTORY_COUNT) {
    return { recentMessages: list, olderChunks: [] };
  }
  const recentMessages = list.slice(-INITIAL_HISTORY_COUNT);
  const older = list.slice(0, -INITIAL_HISTORY_COUNT);
  const olderChunks = [];
  for (let end = older.length; end > 0; end -= HISTORY_CHUNK_SIZE) {
    const start = Math.max(0, end - HISTORY_CHUNK_SIZE);
    olderChunks.push(older.slice(start, end));
  }
  return { recentMessages, olderChunks };
}

function normalizeReplayText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateReplayText(text, maxLen = CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT) {
  const normalized = normalizeReplayText(text);
  if (!normalized || normalized.length <= maxLen) return normalized;
  if (maxLen <= 24) return `${normalized.slice(0, Math.max(0, maxLen - 1))}…`;
  const headLen = Math.ceil((maxLen - 1) * 0.62);
  const tailLen = Math.max(8, maxLen - headLen - 1);
  return `${normalized.slice(0, headLen)}…${normalized.slice(-tailLen)}`;
}

function pushUniqueCarryoverItem(list, seen, value, limit) {
  const normalized = truncateReplayText(value, CONTEXT_REPLAY_FIELD_CHAR_LIMIT);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
  if (typeof limit === 'number' && limit > 0 && list.length > limit) {
    list.length = limit;
  }
}

function messageTextForCarryover(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  const content = truncateReplayText(message.content || '', CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT);
  if (content) parts.push(content);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 0) {
    const names = attachments
      .map((attachment) => String(attachment?.filename || attachment?.id || 'image').trim())
      .filter(Boolean)
      .slice(0, 4);
    parts.push(`附件: ${names.join(', ')}${attachments.length > names.length ? ` 等 ${attachments.length} 项` : ''}`);
  }
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  if (toolCalls.length > 0) {
    const names = toolCalls
      .map((tool) => String(tool?.name || tool?.type || '').trim())
      .filter(Boolean)
      .slice(0, 4);
    if (names.length > 0) {
      parts.push(`工具: ${names.join(', ')}${toolCalls.length > names.length ? ` 等 ${toolCalls.length} 个` : ''}`);
    }
  }
  return parts.join('\n');
}

function extractCarryoverLead(text) {
  const normalized = normalizeReplayText(text);
  if (!normalized) return '';
  const lead = normalized
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || normalized;
  return truncateReplayText(lead, CONTEXT_REPLAY_FIELD_CHAR_LIMIT);
}

function collectRecentCarryoverMessages(messages) {
  const recent = Array.isArray(messages) ? messages.slice(-CONTEXT_REPLAY_RECENT_MESSAGE_LIMIT) : [];
  const blocks = [];
  let remaining = CONTEXT_REPLAY_RECENT_CHAR_BUDGET;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    const role = message?.role === 'assistant' ? '助手' : '用户';
    const baseText = messageTextForCarryover(message);
    if (!baseText) continue;
    const allowedBody = Math.max(140, Math.min(CONTEXT_REPLAY_MESSAGE_CHAR_LIMIT, remaining - 24));
    const body = truncateReplayText(baseText, allowedBody);
    if (!body) continue;
    const block = `[${role}]\n${body}`;
    blocks.unshift(block);
    remaining -= block.length;
    if (remaining <= 160) break;
  }
  return blocks;
}

function collectCompletedCarryoverItems(messages) {
  const items = [];
  const seen = new Set();
  const list = Array.isArray(messages) ? messages.slice() : [];
  for (let index = list.length - 1; index >= 0 && items.length < CONTEXT_REPLAY_MAX_COMPLETED_ITEMS; index -= 1) {
    const message = list[index];
    if (message?.role !== 'assistant') continue;
    const summary = extractCarryoverLead(messageTextForCarryover(message));
    if (summary) pushUniqueCarryoverItem(items, seen, summary, CONTEXT_REPLAY_MAX_COMPLETED_ITEMS);
  }
  return items;
}

function collectConstraintCarryoverItems(messages) {
  const items = [];
  const seen = new Set();
  const list = Array.isArray(messages) ? messages : [];
  const matcher = /不要|别|请勿|必须|不能|不可|优先|务必|默认|保留|切换|resume|线程|上下文|配置|路径|模型|报错|配置项/i;
  for (let index = list.length - 1; index >= 0 && items.length < CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS; index -= 1) {
    const message = list[index];
    if (message?.role !== 'user') continue;
    const text = normalizeReplayText(messageTextForCarryover(message));
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!matcher.test(line)) continue;
      pushUniqueCarryoverItem(items, seen, line, CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS);
      if (items.length >= CONTEXT_REPLAY_MAX_CONSTRAINT_ITEMS) break;
    }
  }
  return items;
}

function buildClaudeCarryoverConfigLines(session) {
  const lines = [];
  const config = loadModelConfig();
  const template = getClaudeSelectedTemplate(config);
  if (template) {
    lines.push(`Claude 当前运行配置: provider (${template.name})`);
    if (template.apiBase) lines.push(`Claude API Base: ${template.apiBase}`);
    if (template.defaultModel) lines.push(`Claude 默认模型: ${template.defaultModel}`);
    if (template.upstreamType) lines.push(`Claude 上游类型: ${template.upstreamType}`);
  } else {
    const localCreds = readClaudeSettingsCredentials();
    lines.push('Claude 当前运行配置: local');
    lines.push(`Claude 本地配置文件: ${CLAUDE_SETTINGS_PATH}`);
    if (localCreds?.apiBase) lines.push(`Claude 本地 API Base: ${localCreds.apiBase}`);
    if (localCreds?.defaultModel) lines.push(`Claude 本地默认模型: ${localCreds.defaultModel}`);
  }
  if (session?.model) lines.push(`当前会话模型覆盖: ${session.model}`);
  lines.push(`当前权限模式: ${session?.permissionMode || 'yolo'}`);
  if (session?.cwd) lines.push(`当前工作目录: ${session.cwd}`);
  return lines;
}

function buildCodexCarryoverConfigLines(session) {
  const lines = [];
  const config = loadCodexConfig();
  if (normalizeCodexMode(config.mode) === 'local') {
    const codexHome = getUserCodexHome();
    lines.push('Codex 当前运行配置: local');
    lines.push(`Codex 本地配置文件: ${path.join(codexHome, 'config.toml')}`);
    lines.push(`Codex 本地鉴权文件: ${path.join(codexHome, 'auth.json')}`);
  } else {
    const source = resolveCodexActiveSource(config);
    if (source?.error) {
      lines.push(`Codex 当前运行配置异常: ${source.error}`);
    } else {
      lines.push(`Codex 当前运行配置: ${source?.mode || 'unified'}${source?.name ? ` (${source.name})` : ''}`);
      if (source?.apiBase) lines.push(`Codex API Base: ${source.apiBase}`);
      if (source?.defaultModel) lines.push(`Codex 默认模型: ${source.defaultModel}`);
    }
    if (config.activeProfile) lines.push(`Codex 激活配置: ${config.activeProfile}`);
    if (config.sharedTemplate) lines.push(`Codex AI 提供商: ${config.sharedTemplate}`);
  }
  if (session?.model) lines.push(`当前会话模型覆盖: ${session.model}`);
  lines.push(`当前权限模式: ${session?.permissionMode || 'yolo'}`);
  if (session?.cwd) lines.push(`当前工作目录: ${session.cwd}`);
  return lines;
}

function buildPiCarryoverConfigLines(session) {
  const lines = [];
  const config = loadPiConfig();
  if (normalizePiMode(config.mode) === 'local') {
    lines.push('Pi 当前运行配置: local');
    lines.push('Pi 本地配置目录: ~/.pi/agent（可用 PI_CODING_AGENT_DIR 覆盖）');
  } else {
    const source = resolvePiActiveSource(config);
    if (source?.error) {
      lines.push(`Pi 当前运行配置异常: ${source.error}`);
    } else {
      lines.push(`Pi 当前运行配置: unified${source?.name ? ` (${source.name})` : ''}`);
      if (source?.apiBase) lines.push(`Pi API Base: ${source.apiBase}`);
      if (source?.defaultModel) lines.push(`Pi 默认模型: ${source.defaultModel}`);
      if (source?.upstreamType) lines.push(`Pi 上游类型: ${source.upstreamType}`);
    }
    if (config.sharedTemplate) lines.push(`Pi 激活提供商: ${config.sharedTemplate}`);
  }
  lines.push(`Pi CLI: ${PI_PATH}`);
  if (session?.model) lines.push(`当前会话模型覆盖: ${session.model}`);
  if (session?.piProvider) lines.push(`当前 Provider: ${session.piProvider}`);
  lines.push(`当前权限模式: ${session?.permissionMode || 'yolo'}`);
  if (session?.cwd) lines.push(`当前工作目录: ${session.cwd}`);
  return lines;
}

function buildCarryoverConfigLines(session) {
  if (isCodexSession(session)) return buildCodexCarryoverConfigLines(session);
  if (isPiSession(session)) return buildPiCarryoverConfigLines(session);
  return buildClaudeCarryoverConfigLines(session);
}

function collectCarryoverExactLines(messages, currentInputText, configLines) {
  const buckets = {
    paths: [],
    models: [],
    configs: [],
    errors: [],
  };
  const seen = {
    paths: new Set(),
    models: new Set(),
    configs: new Set(),
    errors: new Set(),
  };
  const pathRegex = /(?:~\/|\/)[^\s"'`<>|]+/g;
  const modelRegexes = [
    /\bclaude-[a-zA-Z0-9._-]+\b/g,
    /\bgpt-[a-zA-Z0-9._-]+\b/g,
    /\b(?:opus|sonnet|haiku)(?:\[1m\])?\b/g,
  ];
  const configRegex = /\b(?:ANTHROPIC_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+|model_provider|preferred_auth_method|base_url|apiBase|apiKey|defaultModel|sharedTemplate|activeTemplate|activeProfile|legacyMode|permissionMode)\b/g;
  const errorLineRegex = /error|failed|failure|失败|报错|超时|not found|invalid|forbidden|exceed|context|退出码/i;
  const sources = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageTextForCarryover(message);
    if (text) sources.push(text);
  }
  if (currentInputText) sources.push(String(currentInputText));
  for (const line of Array.isArray(configLines) ? configLines : []) {
    if (line) sources.push(String(line));
  }

  for (const source of sources) {
    const text = normalizeReplayText(source);
    if (!text) continue;
    const pathMatches = text.match(pathRegex) || [];
    for (const match of pathMatches) {
      pushUniqueCarryoverItem(buckets.paths, seen.paths, match, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
    }
    for (const regex of modelRegexes) {
      const matches = text.match(regex) || [];
      for (const match of matches) {
        pushUniqueCarryoverItem(buckets.models, seen.models, match, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
      }
    }
    const configMatches = text.match(configRegex) || [];
    for (const match of configMatches) {
      pushUniqueCarryoverItem(buckets.configs, seen.configs, match, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
    }
    for (const line of text.split('\n')) {
      if (!errorLineRegex.test(line)) continue;
      pushUniqueCarryoverItem(buckets.errors, seen.errors, line, CONTEXT_REPLAY_MAX_EXACT_ITEMS);
    }
  }

  const lines = [];
  if (buckets.paths.length > 0) lines.push(`- 路径/文件: ${buckets.paths.join(' | ')}`);
  if (buckets.models.length > 0) lines.push(`- 模型名: ${buckets.models.join(' | ')}`);
  if (buckets.configs.length > 0) lines.push(`- 配置项: ${buckets.configs.join(' | ')}`);
  if (buckets.errors.length > 0) lines.push(`- 报错/异常: ${buckets.errors.join(' | ')}`);
  return lines;
}

function buildCarryoverSummary(session, historyMessages, currentInputText, attachments) {
  const recentUser = [...(Array.isArray(historyMessages) ? historyMessages : [])]
    .reverse()
    .find((message) => message?.role === 'user' && messageTextForCarryover(message));
  const goal = extractCarryoverLead(recentUser ? messageTextForCarryover(recentUser) : currentInputText)
    || '继续当前会话中的最近任务';
  const pending = extractCarryoverLead(currentInputText)
    || (Array.isArray(attachments) && attachments.length > 0
      ? `继续处理本次新增的 ${attachments.length} 张图片相关请求`
      : '继续处理当前会话的下一步任务');
  const configLines = buildCarryoverConfigLines(session);
  const historyChars = (Array.isArray(historyMessages) ? historyMessages : [])
    .reduce((sum, message) => sum + messageTextForCarryover(message).length, 0);
  const detailed = (Array.isArray(historyMessages) ? historyMessages.length : 0) >= CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_MESSAGES
    || historyChars >= CONTEXT_REPLAY_MIN_DETAILED_SUMMARY_CHARS;

  const lines = [];
  lines.push(`当前目标: ${goal}`);
  if (detailed) {
    const completed = collectCompletedCarryoverItems(historyMessages);
    if (completed.length > 0) {
      lines.push('已完成操作:');
      for (const item of completed) lines.push(`- ${item}`);
    }
    const constraints = collectConstraintCarryoverItems(historyMessages);
    if (constraints.length > 0) {
      lines.push('关键约束:');
      for (const item of constraints) lines.push(`- ${item}`);
    }
  }
  if (configLines.length > 0) {
    lines.push('关键配置状态:');
    for (const item of configLines) lines.push(`- ${truncateReplayText(item, CONTEXT_REPLAY_FIELD_CHAR_LIMIT)}`);
  }
  lines.push(`当前待解决问题: ${pending}`);
  if (detailed) {
    const exactLines = collectCarryoverExactLines(historyMessages, currentInputText, configLines);
    if (exactLines.length > 0) {
      lines.push('必须精确保留的原文:');
      for (const item of exactLines) lines.push(item);
    }
  }

  let text = lines.join('\n');
  if (text.length > CONTEXT_REPLAY_SUMMARY_MAX_CHARS) {
    text = `${text.slice(0, CONTEXT_REPLAY_SUMMARY_MAX_CHARS - 12).trimEnd()}\n[摘要已截断]`;
  }
  return {
    text,
    detailed,
    configLines,
  };
}

function formatCurrentInputForCarryover(text, attachments) {
  const blocks = [];
  const normalized = normalizeReplayText(text);
  if (normalized) blocks.push(normalized);
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length > 0) {
    const names = list
      .map((attachment) => String(attachment?.filename || attachment?.id || 'image').trim())
      .filter(Boolean)
      .slice(0, 4);
    blocks.push(`本次还附带图片: ${names.join(', ')}${list.length > names.length ? ` 等 ${list.length} 项` : ''}`);
  }
  if (blocks.length === 0) {
    blocks.push('请继续处理当前会话中的下一步任务。');
  }
  return blocks.join('\n');
}

function buildThreadCarryoverPayload(session, text, attachments, historyMessages, threadReset) {
  const history = Array.isArray(historyMessages) ? historyMessages.filter(Boolean) : [];
  if (history.length === 0) return null;
  const recentBlocks = collectRecentCarryoverMessages(history);
  if (recentBlocks.length === 0) return null;
  const summary = buildCarryoverSummary(session, history, text, attachments);
  let reasonText = '检测到配置已经变化，当前必须按最新配置重建底层线程。';
  if (threadReset?.reason === 'legacy_runtime') {
    reasonText = '检测到这是旧版线程，当前必须按最新配置重建底层线程。';
  } else if (threadReset?.reason === 'channel_changed') {
    reasonText = '检测到当前会话切换到了新的渠道或模型，当前会在该渠道下建立新线程。';
  }
  const prompt = [
    '[webcoding 自动上下文续接]',
    reasonText,
    '下面依次提供结构化上下文摘要、最近几轮原始消息，以及本次用户新输入。',
    '请先吸收这些内容，不要逐段复述，不要把它们当成需要原样回复给用户的正文；直接继续处理当前任务。',
    '',
    '[结构化上下文摘要]',
    summary.text,
    '',
    '[最近对话原文]',
    recentBlocks.join('\n\n'),
    '',
    '[本次用户新输入]',
    formatCurrentInputForCarryover(text, attachments),
  ].join('\n');
  return {
    prompt,
    summaryDetailed: summary.detailed,
    recentCount: recentBlocks.length,
    historyCount: history.length,
  };
}

function buildThreadCarryoverNotice(carryover) {
  if (!carryover) {
    return '已新开线程；历史较少，本次仅发送当前输入。';
  }
  return carryover.summaryDetailed
    ? `已新开线程，并补充摘要和最近 ${carryover.recentCount} 条消息。`
    : `已新开线程，并补充轻量摘要和最近 ${carryover.recentCount} 条消息。`;
}

function sendHistoryChunks(ws, sessionId, chunks, index = 0) {
  if (!ws || ws.readyState !== 1 || index >= chunks.length) return;
  wsSend(ws, {
    type: 'session_history_chunk',
    sessionId,
    messages: chunks[index],
    remaining: Math.max(0, chunks.length - index - 1),
  });
  if (index >= chunks.length - 1) return;
  const scheduleNext = () => sendHistoryChunks(ws, sessionId, chunks, index + 1);
  if (ws.bufferedAmount > HISTORY_CHUNK_BUFFER_LIMIT) {
    setTimeout(scheduleNext, HISTORY_CHUNK_RETRY_MS);
  } else {
    setImmediate(scheduleNext);
  }
}

const IS_WIN = process.platform === 'win32';

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid, force = false) {
  const nPid = Number(pid);
  // Never signal pid <= 1 (init/system) even if a corrupt pid file is present.
  if (!Number.isFinite(nPid) || nPid <= 1 || !Number.isInteger(nPid)) return;
  try {
    if (IS_WIN) {
      // /T = kill child tree (Codex may spawn helpers)
      const args = ['/T', '/PID', String(nPid)];
      if (force) args.unshift('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      return;
    }
    const sig = force ? 'SIGKILL' : 'SIGTERM';
    // CLI processes are spawned detached → own process group. Kill the group first.
    try {
      process.kill(-nPid, sig);
      return;
    } catch {
      // Fall through to single-pid kill (group may not exist / EPERM).
    }
    process.kill(nPid, sig);
  } catch {}
}

function writeRunMeta(sessionId, meta) {
  try {
    const dir = runDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      pid: meta?.pid ?? null,
      permissionMode: meta?.permissionMode || 'yolo',
      agent: meta?.agent || 'claude',
      detached: meta?.detached !== false && !IS_WIN,
      startedAt: meta?.startedAt || new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify(payload, null, 2));
  } catch (err) {
    plog('WARN', 'run_meta_write_failed', { sessionId: String(sessionId || '').slice(0, 8), error: err.message });
  }
}

function readRunMeta(sessionId) {
  try {
    const p = path.join(runDir(sessionId), 'run-meta.json');
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readBridgeState() {
  try {
    if (!fs.existsSync(BRIDGE_STATE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(BRIDGE_STATE_PATH, 'utf8'));
    if (!parsed || typeof parsed.port !== 'number' || parsed.port <= 0) return null;
    return {
      ...parsed,
      scriptFingerprint: String(parsed.scriptFingerprint || '').trim(),
    };
  } catch {
    return null;
  }
}

function clearTunnelState() {
  try { fs.unlinkSync(TUNNEL_STATE_PATH); } catch {}
}

function normalizeTunnelState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pid = Number.parseInt(String(raw.pid ?? ''), 10);
  const managerPid = Number.parseInt(String(raw.managerPid ?? ''), 10);
  const port = Number.parseInt(String(raw.port ?? ''), 10);
  const url = String(raw.url || '').trim();
  const startedAt = String(raw.startedAt || '').trim();
  const error = String(raw.error || '').trim();
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    managerPid: Number.isInteger(managerPid) && managerPid > 0 ? managerPid : null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    url: url || null,
    startedAt: startedAt || null,
    error: error || '',
  };
}

function readTunnelState() {
  try {
    if (!fs.existsSync(TUNNEL_STATE_PATH)) return null;
    return normalizeTunnelState(JSON.parse(fs.readFileSync(TUNNEL_STATE_PATH, 'utf8')));
  } catch {
    clearTunnelState();
    return null;
  }
}

function isTunnelStateLive(state) {
  return !!(
    state?.managerPid
    && state?.pid
    && state?.port
    && isProcessRunning(state.managerPid)
    && isProcessRunning(state.pid)
  );
}

// Returns the path where we store the downloaded cloudflared binary
function getCloudflaredLocalPath() {
  const ext = IS_WIN ? '.exe' : '';
  return path.join(CONFIG_DIR, `cloudflared${ext}`);
}

// Check if cloudflared is available (local copy or system PATH)
function getCloudflaredBin() {
  const local = getCloudflaredLocalPath();
  if (fs.existsSync(local)) return local;
  const fromEnv = process.env.CLOUDFLARED_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  // Check system PATH via a quick execFileSync
  try {
    const { execFileSync } = require('child_process');
    execFileSync(IS_WIN ? 'where' : 'which', ['cloudflared'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    return null;
  }
}

function getTunnelStatus() {
  const bin = getCloudflaredBin();
  const installed = !!bin;
  const state = readTunnelState();
  if (!state || !isTunnelStateLive(state)) {
    if (state) clearTunnelState();
    return { running: false, url: null, installed };
  }
  return { running: true, url: state.url || null, installed };
}

// Download cloudflared binary from GitHub releases
function installCloudflared(ws) {
  const platform = process.platform; // darwin / linux / win32
  const arch = process.arch;         // x64 / arm64 / arm

  let assetName;
  if (platform === 'darwin') {
    assetName = arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  } else if (platform === 'linux') {
    if (arch === 'arm64') assetName = 'cloudflared-linux-arm64';
    else if (arch === 'arm') assetName = 'cloudflared-linux-arm';
    else assetName = 'cloudflared-linux-amd64';
  } else if (platform === 'win32') {
    assetName = arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
  } else {
    wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `不支持的平台: ${platform}` });
    return;
  }

  function sendProgress(msg) {
    wsSend(ws, { type: 'tunnel_install_progress', message: msg });
  }

  sendProgress('正在查询最新版本...');

  const apiReq = https.request({
    hostname: 'api.github.com',
    path: '/repos/cloudflare/cloudflared/releases/latest',
    headers: { 'User-Agent': 'webcoding-cloudflared-installer' },
    timeout: 10000,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let releaseData;
      try { releaseData = JSON.parse(body); } catch {
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '解析 GitHub API 响应失败' });
        return;
      }
      const asset = (releaseData.assets || []).find((a) => a.name === assetName);
      if (!asset) {
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `未找到资产: ${assetName}` });
        return;
      }
      sendProgress(`下载 ${assetName} (${Math.round(asset.size / 1024 / 1024 * 10) / 10} MB)...`);
      downloadCloudflaredAsset(ws, asset.browser_download_url, assetName);
    });
  });
  apiReq.on('error', (e) => {
    wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '网络错误: ' + e.message });
  });
  apiReq.on('timeout', () => { apiReq.destroy(); wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '请求超时' }); });
  apiReq.end();
}

function downloadCloudflaredAsset(ws, downloadUrl, assetName) {
  const destPath = getCloudflaredLocalPath();
  const tmpPath = destPath + '.tmp';
  const isTgz = assetName.endsWith('.tgz');

  function doDownload(url, redirects) {
    if (redirects > 5) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '重定向过多' });
      return;
    }
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'webcoding-cloudflared-installer' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        doDownload(res.headers.location, redirects + 1);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `下载失败 HTTP ${res.statusCode}` });
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct = 0;
      const fileStream = fs.createWriteStream(tmpPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor(received / total * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            wsSend(ws, { type: 'tunnel_install_progress', message: `下载中 ${pct}%...` });
          }
        }
      });
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => {
          if (isTgz) {
            extractCloudflaredFromTgz(ws, tmpPath, destPath);
          } else {
            try {
              fs.renameSync(tmpPath, destPath);
              if (!IS_WIN) fs.chmodSync(destPath, 0o755);
              wsSend(ws, { type: 'tunnel_install_progress', done: true, message: '安装完成！' });
              wsSend(ws, { type: 'tunnel_status', ...getTunnelStatus() });
            } catch (e) {
              wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '保存失败: ' + e.message });
            }
          }
        });
      });
      fileStream.on('error', (e) => {
        wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '写入失败: ' + e.message });
      });
    }).on('error', (e) => {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '下载失败: ' + e.message });
    });
  }

  doDownload(downloadUrl, 0);
}

function extractCloudflaredFromTgz(ws, tgzPath, destPath) {
  wsSend(ws, { type: 'tunnel_install_progress', message: '解压中...' });
  // Use tar command (available on macOS/Linux)
  const tmpDir = tgzPath + '_extract';
  fs.mkdirSync(tmpDir, { recursive: true });
  const tar = spawn('tar', ['-xzf', tgzPath, '-C', tmpDir], { stdio: 'ignore' });
  tar.on('close', (code) => {
    try { fs.unlinkSync(tgzPath); } catch {}
    if (code !== 0) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: `解压失败 (exit ${code})` });
      return;
    }
    // Find the cloudflared binary inside extracted dir
    let binSrc = null;
    try {
      const files = fs.readdirSync(tmpDir);
      const found = files.find((f) => f === 'cloudflared' || f.startsWith('cloudflared'));
      if (found) binSrc = path.join(tmpDir, found);
    } catch {}
    if (!binSrc) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '解压后未找到 cloudflared 二进制' });
      return;
    }
    try {
      fs.copyFileSync(binSrc, destPath);
      fs.chmodSync(destPath, 0o755);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      wsSend(ws, { type: 'tunnel_install_progress', done: true, message: '安装完成！' });
      wsSend(ws, { type: 'tunnel_status', ...getTunnelStatus() });
    } catch (e) {
      wsSend(ws, { type: 'tunnel_install_progress', done: true, error: '安装失败: ' + e.message });
    }
  });
  tar.on('error', (e) => {
    wsSend(ws, { type: 'tunnel_install_progress', done: true, error: 'tar 命令失败: ' + e.message });
  });
}

function startTunnel() {
  const bin = getCloudflaredBin();
  if (!bin) return { running: false, url: null, installed: false, error: 'cloudflared 未安装' };

  const existing = readTunnelState();
  if (existing) {
    if (isTunnelStateLive(existing)) return getTunnelStatus();
    clearTunnelState();
  }

  const child = spawn(process.execPath, [TUNNEL_SCRIPT_PATH], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CF_TUNNEL_STATE_PATH: TUNNEL_STATE_PATH,
      CF_TUNNEL_PORT: String(PORT),
      CF_TUNNEL_BIN: bin,
    },
  });
  child.unref();

  const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readTunnelState();
    if (isTunnelStateLive(state) && state.url) return getTunnelStatus();
    sleepSync(200);
  }
  return getTunnelStatus();
}

function stopTunnel() {
  const state = readTunnelState();
  const live = isTunnelStateLive(state);
  if (live && state.managerPid) {
    killProcess(state.managerPid, true);
  }
  if (live && state.pid && state.pid !== state.managerPid) {
    killProcess(state.pid, true);
  }
  clearTunnelState();
  return { running: false, url: null, installed: !!getCloudflaredBin() };
}

function normalizeBridgeRuntimeUpstream(upstream) {
  if (!upstream || typeof upstream !== 'object') return null;
  const apiKey = String(upstream.apiKey || '');
  const apiBase = String(upstream.apiBase || '').trim();
  if (!apiKey || !apiBase) return null;
  return {
    name: String(upstream.name || '').trim() || 'AI Provider',
    apiKey,
    apiBase,
    kind: upstream.kind === 'anthropic' ? 'anthropic' : 'openai',
    defaultModel: String(upstream.defaultModel || '').trim(),
  };
}

function normalizeBridgeRuntimeStore(raw) {
  const runtimes = {};
  const addEntry = (tokenValue, upstreamValue, updatedAtValue = null) => {
    const token = String(tokenValue || '').trim();
    const upstream = normalizeBridgeRuntimeUpstream(upstreamValue);
    if (!token || !upstream) return;
    runtimes[token] = {
      token,
      upstream,
      updatedAt: updatedAtValue ? String(updatedAtValue).trim() : null,
    };
  };

  if (raw && typeof raw === 'object' && raw.runtimes && typeof raw.runtimes === 'object' && !Array.isArray(raw.runtimes)) {
    for (const [token, value] of Object.entries(raw.runtimes)) {
      if (value && typeof value === 'object' && value.upstream) {
        addEntry(value.token || token, value.upstream, value.updatedAt || raw.updatedAt || null);
      } else {
        addEntry(token, value, raw.updatedAt || null);
      }
    }
  }
  if (!Object.keys(runtimes).length) {
    addEntry(raw?.token, raw?.upstream, raw?.updatedAt || null);
  }

  const preferredToken = String(raw?.token || '').trim();
  const token = preferredToken && runtimes[preferredToken]
    ? preferredToken
    : (Object.keys(runtimes)[0] || '');
  const current = token ? runtimes[token] : null;

  return {
    version: 2,
    token,
    upstream: current ? cloneJson(current.upstream) : null,
    updatedAt: current?.updatedAt || null,
    runtimes,
  };
}

function loadBridgeRuntimeStore() {
  return normalizeBridgeRuntimeStore(readCachedJsonConfig(BRIDGE_RUNTIME_PATH));
}

function saveBridgeRuntimeStore(store) {
  const normalized = normalizeBridgeRuntimeStore(store);
  writeCachedJsonConfig(BRIDGE_RUNTIME_PATH, {
    version: normalized.version,
    token: normalized.token || '',
    upstream: normalized.upstream ? cloneJson(normalized.upstream) : null,
    updatedAt: normalized.updatedAt || null,
    runtimes: normalized.runtimes,
  });
}

function loadBridgeRuntime(token = '') {
  const store = loadBridgeRuntimeStore();
  const requestedToken = String(token || store.token || '').trim();
  const entry = (requestedToken && store.runtimes[requestedToken])
    || (store.token && store.runtimes[store.token])
    || Object.values(store.runtimes)[0]
    || null;
  if (!entry) return null;
  return {
    token: entry.token,
    upstream: cloneJson(entry.upstream),
    updatedAt: entry.updatedAt || null,
  };
}

function listBridgeRuntimeTokens() {
  return Object.keys(loadBridgeRuntimeStore().runtimes);
}

function getBridgeScriptFingerprint() {
  try {
    const stat = fs.statSync(BRIDGE_SCRIPT_PATH);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return '';
  }
}

function canReuseBridgeState(state) {
  if (!state?.pid || !state.port || !isProcessRunning(state.pid)) return false;
  const currentFingerprint = getBridgeScriptFingerprint();
  if (!currentFingerprint) return true;
  return !!state.scriptFingerprint && state.scriptFingerprint === currentFingerprint;
}

function buildLocalBridgeBaseUrl(port, kind) {
  return `http://127.0.0.1:${port}/${kind}`;
}

function getActiveUnifiedTemplate() {
  const tpl = getClaudeSelectedTemplate(loadModelConfig());
  if (!tpl || !tpl.apiKey || !tpl.apiBase) return null;
  return tpl;
}

function isBridgePortReachable(port) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function ensureLocalBridgeRunning() {
  const existing = readBridgeState();
  if (canReuseBridgeState(existing)) {
    return existing;
  }
  if (existing?.pid && isProcessRunning(existing.pid)) {
    killProcess(existing.pid, true);
    sleepSync(100);
  }

  const child = spawn(process.execPath, [BRIDGE_SCRIPT_PATH], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CC_WEB_BRIDGE_RUNTIME_PATH: BRIDGE_RUNTIME_PATH,
      CC_WEB_BRIDGE_STATE_PATH: BRIDGE_STATE_PATH,
    },
  });
  child.unref();

  const start = Date.now();
  while (Date.now() - start < BRIDGE_START_TIMEOUT_MS) {
    const state = readBridgeState();
    if (state?.pid && isProcessRunning(state.pid) && state.port) return state;
    sleepSync(50);
  }
  throw new Error('本地 API 桥接服务启动超时');
}

function ensureBridgeRuntimeForTemplate(tpl) {
  const defaultModel = String(tpl.defaultModel || '').trim();
  const upstreamType = tpl.upstreamType === 'anthropic' ? 'anthropic' : 'openai';
  const store = loadBridgeRuntimeStore();
  const existing = Object.values(store.runtimes).find((entry) => entry?.upstream?.name === String(tpl.name || '').trim()) || null;
  const token = existing?.token || crypto.randomBytes(24).toString('hex');
  const updatedAt = new Date().toISOString();
  store.runtimes[token] = {
    token,
    upstream: {
      name: String(tpl.name || '').trim() || 'AI Provider',
      apiKey: String(tpl.apiKey || ''),
      apiBase: String(tpl.apiBase || '').trim(),
      kind: upstreamType,
      defaultModel,
    },
    updatedAt,
  };
  store.token = token;
  store.upstream = cloneJson(store.runtimes[token].upstream);
  store.updatedAt = updatedAt;
  saveBridgeRuntimeStore(store);
  const state = ensureLocalBridgeRunning();
  return {
    token,
    defaultModel,
    anthropicBaseUrl: buildLocalBridgeBaseUrl(state.port, 'anthropic'),
    openaiBaseUrl: buildLocalBridgeBaseUrl(state.port, 'openai'),
  };
}

function cleanRunDir(sessionId) {
  const dir = runDir(sessionId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch {}
}

function piSessionDir(sessionId) {
  return path.join(SESSIONS_DIR, '_pi-sessions', sanitizeId(sessionId));
}

function deletePiLocalSession(sessionId) {
  const dir = piSessionDir(sessionId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch {}
}

function collectSessionListSnapshot() {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    try {
      const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
      const preferredClaudeRuntimeId = getSessionAgent(s) === 'claude'
        ? getPreferredRuntimeSessionId(s, 'claude')
        : null;
      const localMeta = getSessionAgent(s) === 'claude' && preferredClaudeRuntimeId && (!s.cwd || !s.importedFrom)
        ? resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId)
        : null;
      sessions.push({
        id: s.id,
        title: s.title || 'Untitled',
        updated: s.updated,
        hasUnread: !!s.hasUnread,
        agent: getSessionAgent(s),
        isRunning: activeProcesses.has(s.id),
        projectId: s.projectId || null,
        cwd: s.cwd || localMeta?.cwd || null,
        importedFrom: s.importedFrom || localMeta?.projectDir || null,
      });
    } catch {}
  }
  sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  return sessions;
}

function getSessionListSnapshot(options = {}) {
  const now = Date.now();
  const forceRefresh = !!options.forceRefresh;
  if (!forceRefresh && sessionListCache.expiresAt > now) {
    return sessionListCache.sessions;
  }
  const sessions = collectSessionListSnapshot();
  sessionListCache.sessions = sessions;
  sessionListCache.expiresAt = now + SESSION_LIST_CACHE_TTL_MS;
  return sessions;
}

function sendSessionList(ws, options = {}) {
  try {
    const sessions = Array.isArray(options.sessions)
      ? options.sessions
      : getSessionListSnapshot(options);
    wsSend(ws, { type: 'session_list', sessions });
  } catch {
    wsSend(ws, { type: 'session_list', sessions: [] });
  }
}

// === File Tailer ===
// Tails a file and calls onLine for each new complete line.
class FileTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
    this.interval = null;
    this.stopped = false;
    this.readTimer = null;
  }

  start() {
    this.readNew();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.scheduleRead();
      });
      this.watcher.on('error', () => {});
    } catch {}
    // Backup poll every 500ms (fs.watch not always reliable on all systems)
    this.interval = setInterval(() => {
      this.scheduleRead();
    }, 500);
  }

  scheduleRead() {
    if (this.stopped || this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      if (!this.stopped) this.readNew();
    }, FILE_TAIL_DEBOUNCE_MS);
  }

  readNew() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) return;

      const remaining = stat.size - this.offset;
      const readLen = Math.min(remaining, FILE_TAIL_MAX_READ_BYTES);
      const buf = Buffer.alloc(readLen);
      const fd = fs.openSync(this.filePath, 'r');
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buf, 0, buf.length, this.offset);
      } finally {
        fs.closeSync(fd);
      }

      if (bytesRead <= 0) return;

      this.offset += bytesRead;
      this.buffer += buf.toString('utf8', 0, bytesRead);
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.onLine(line);
      }
    } catch (error) {
      plog('WARN', 'tailer_read_error', {
        file: this.filePath,
        offset: this.offset,
        error: error?.message || String(error),
      });
    }
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
  }
}

// === Process Lifecycle ===

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function condenseRuntimeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const usageIndex = lines.findIndex((line) => /^Usage:/i.test(line));
  if (usageIndex >= 0) return lines.slice(0, usageIndex).join(' ');
  return lines.slice(0, 3).join(' ');
}

function formatRuntimeError(agent, raw, context = {}) {
  const condensed = condenseRuntimeError(raw);
  const exitInfo = typeof context.exitCode === 'number' ? `（退出码 ${context.exitCode}）` : '';
  const label = agentDisplayName(agent);
  if (!condensed) {
    return `${label} 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`;
  }

  if (agent === 'codex') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 Codex CLI。请检查 Codex 设置里的 CLI 路径，或确认系统 PATH 中可直接运行 `codex`。';
    }
    if (/unexpected argument|unexpected option|Usage:\s*codex/i.test(raw || '')) {
      return `Codex CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 webcoding 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Codex CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential/i.test(condensed)) {
      return 'Codex 鉴权失败。请确认本机 Codex CLI 已完成登录，且当前凭据仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'Codex 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Codex 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/sandbox|approval|read-only|bypass-approvals/i.test(condensed)) {
      return `Codex 当前的审批或沙箱设置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `Codex 任务失败${exitInfo}：${condensed}`;
  }

  if (agent === 'pi') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 Pi CLI。请检查 `PI_PATH` 环境变量，或确认系统 PATH 中可直接运行 `pi`（npm i -g @earendil-works/pi-coding-agent）。';
    }
    if (/unexpected argument|unexpected option|Usage:\s*pi/i.test(raw || '')) {
      return `Pi CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 Pi 版本与 webcoding 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Pi CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential|no api key|missing.*key/i.test(condensed)) {
      return 'Pi 鉴权失败。请确认 `~/.pi/agent` 中已配置模型 Provider，或已设置对应 API Key 环境变量。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'Pi 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Pi 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    return `Pi 任务失败${exitInfo}：${condensed}`;
  }

  if (/ENOENT|not found|No such file/i.test(condensed)) {
    return `找不到 Claude CLI（当前配置路径：${CLAUDE_PATH}）。请确认本机可执行 \`claude\`，或在 .env 中设置正确的 CLAUDE_PATH（例如 ${path.join(process.env.HOME || '~', '.local', 'bin', 'claude')}）。`;
  }
  if (/authentication|unauthorized|forbidden|not logged in|\/login|login|api key|credential/i.test(condensed)) {
    return 'Claude 本地认证不可用。请检查本机 Claude CLI 当前是账号登录态还是本地自定义 API 配置，并确认对应凭据仍然有效。';
  }
  return `Claude 任务失败${exitInfo}：${condensed}`;
}

function compactStartMessage(agent) {
  const label = agentDisplayName(agent);
  if (agent === 'codex') return '正在执行 Codex /compact 压缩上下文，请稍候…';
  if (agent === 'pi') return '正在执行 Pi 会话压缩，请稍候…';
  return `正在执行 ${label} 原生 /compact 压缩上下文，请稍候…`;
}

function compactDoneMessage(agent) {
  if (agent === 'codex') {
    return '上下文压缩完成。已执行 Codex /compact，下次继续在同一会话发送即可。';
  }
  if (agent === 'pi') {
    return PI_TRANSPORT === 'rpc'
      ? '上下文压缩完成。已通过 Pi RPC 压缩当前会话，下次继续发送即可。'
      : '上下文压缩完成。已向 Pi 会话发送 /compact（若 CLI 支持），下次继续在同一会话发送即可。';
  }
  return '上下文压缩完成。已按 Claude Code 原生策略执行 /compact，下次继续在同一会话发送即可。';
}

function compactAutoStartMessage(agent) {
  if (agent === 'codex') {
    return '检测到上下文达到上限，正在按 Codex /compact 自动压缩，然后继续当前任务…';
  }
  if (agent === 'pi') {
    return '检测到上下文达到上限，正在按 Pi /compact 自动压缩，然后继续当前任务…';
  }
  return '检测到上下文达到上限，正在按 Claude Code 原版策略自动执行 /compact，然后继续当前任务…';
}

function compactAutoResumeMessage(agent) {
  if (agent === 'codex') {
    return '检测到上一条请求因上下文过大失败，现已按 Codex 压缩计划继续执行。';
  }
  if (agent === 'pi') {
    return '检测到上一条请求因上下文过大失败，现已按 Pi 压缩计划继续执行。';
  }
  return '检测到上一条请求因上下文过大失败，现已自动按压缩计划继续执行。';
}

function isContextLimitError(agent, raw) {
  const text = String(raw || '');
  if (!text) return false;
  if (agent === 'claude') {
    return /Request too large \(max 20MB\)/i.test(text);
  }
  return /context\s+(window|length)|maximum context length|context limit|token limit|too many tokens|input.*too long|prompt.*too long|request too large|please use\s*\/compact|use\s*\/compact|reduce (the )?(input|prompt|message)|exceed(?:ed|s).*(token|context)/i.test(text);
}

function readProcessStderrSnippet(sessionId) {
  try {
    const errPath = path.join(runDir(sessionId), 'error.log');
    const content = fs.readFileSync(errPath, 'utf8').trim();
    if (content) return content.slice(-500);
  } catch {}
  return '';
}

function resolveProcessCompletionState(sessionId, entry, exitCode, signal) {
  const completeTime = new Date().toISOString();
  const wsConnected = !!entry.ws;
  const disconnectGap = entry.wsDisconnectTime
    ? ((new Date(completeTime) - new Date(entry.wsDisconnectTime)) / 1000).toFixed(1) + 's'
    : null;
  const pendingRetry = pendingCompactRetries.get(sessionId) || null;
  const stderrSnippet = readProcessStderrSnippet(sessionId);
  const hasNonZeroExit = typeof exitCode === 'number' && exitCode !== 0;
  const hasUnexpectedSignal = !!signal && signal !== 'SIGTERM';
  const rawCompletionError = entry.lastError || (
    (hasNonZeroExit || hasUnexpectedSignal)
      ? (stderrSnippet || null)
      : null
  );
  const loggedCompletionError = rawCompletionError || (
    hasNonZeroExit
      ? `process exited with non-zero status ${exitCode} but returned no stderr`
      : null
  );
  const contextLimitExceeded = isContextLimitError(entry.agent || 'claude', `${entry.fullText || ''}\n${stderrSnippet || ''}\n${rawCompletionError || ''}`);
  const completionError = rawCompletionError
    ? formatRuntimeError(entry.agent || 'claude', rawCompletionError, { exitCode, signal })
    : hasNonZeroExit
      ? formatRuntimeError(entry.agent || 'claude', '', { exitCode, signal })
      : null;
  if (!entry.lastError && rawCompletionError) entry.lastError = rawCompletionError;

  plog(exitCode === 0 || exitCode === null ? 'INFO' : 'WARN', 'process_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    agent: entry.agent || 'claude',
    exitCode,
    signal,
    wsConnected,
    wsDisconnectTime: entry.wsDisconnectTime || null,
    disconnectToDeathGap: disconnectGap,
    responseLen: (entry.fullText || '').length,
    toolCallCount: (entry.toolCalls || []).length,
    cost: entry.lastCost,
    usage: entry.lastUsage || null,
    error: loggedCompletionError,
    stderr: stderrSnippet || null,
    requestTooLarge: contextLimitExceeded,
  });

  return { pendingRetry, contextLimitExceeded, completionError };
}

function hasPersistableSegments(entry) {
  if (!Array.isArray(entry?.segments) || entry.segments.length === 0) return false;
  return entry.segments.some((segment) => {
    if (!segment) return false;
    if (segment.type === 'tool_call') return true;
    if (segment.type === 'text' && String(segment.text || '').trim()) return true;
    return false;
  });
}

function persistProcessCompletionSession(sessionId, entry, pendingSlash) {
  const session = loadSession(sessionId);
  // Persist when we have final text, tool calls, OR thinking-only segments
  // (extended thinking intentionally stays out of fullText).
  if (session && (entry.fullText || (entry.toolCalls && entry.toolCalls.length > 0) || hasPersistableSegments(entry))) {
    const modelId = String(entry.resolvedModel || entry.effectiveModel || resolveEffectiveModelId(session) || '').trim() || null;
    session.messages.push({
      role: 'assistant',
      content: entry.fullText || '',
      toolCalls: entry.toolCalls || [],
      segments: entry.segments || [],
      model: modelId,
      timestamp: new Date().toISOString(),
    });
    session.updated = new Date().toISOString();
    if (!entry.ws) session.hasUnread = true;
    saveSession(session);
  }

  if (pendingSlash?.kind === 'compact' && session) {
    if (entry.lastCost) {
      session.totalCost = Math.max(0, (session.totalCost || 0) - entry.lastCost);
    }
    session.updated = new Date().toISOString();
    saveSession(session);
  }
  return session;
}

function handleConnectedProcessCompletion(sessionId, entry, session, pendingSlash, pendingRetry, contextLimitExceeded, completionError) {
  let shouldReturnForFollowup = false;
  let shouldAutoCompact = false;
  const aborted = !!entry.abortRequested;

  if (aborted) {
    // User abort terminates the whole workflow — no compact/retry follow-up.
    pendingCompactRetries.delete(sessionId);
    pendingSlashCommands.delete(sessionId);
    wsSend(entry.ws, {
      type: 'system_message',
      sessionId,
      message: '已中断当前任务。',
    });
    wsSend(entry.ws, {
      type: 'done',
      sessionId,
      costUsd: entry.lastCost ?? null,
      interrupted: true,
    });
    sendSessionList(entry.ws);
    return { shouldReturnForFollowup: false, shouldAutoCompact: false };
  }

  if (pendingSlash?.kind === 'compact') {
    const retry = pendingCompactRetries.get(sessionId);
    const autoRetryRequested = !!(retry?.text && retry?.reason === 'auto');
    if (autoRetryRequested) {
      if (contextLimitExceeded) {
        pendingCompactRetries.delete(sessionId);
        wsSend(entry.ws, { type: 'system_message', sessionId, message: '已尝试执行 /compact，但仍未成功解除上下文超限。请手动缩小输入范围后重试。' });
      } else {
        wsSend(entry.ws, { type: 'system_message', sessionId, message: compactDoneMessage(entry.agent || 'claude') });
        wsSend(entry.ws, { type: 'system_message', sessionId, message: compactAutoResumeMessage(entry.agent || 'claude') });
        shouldReturnForFollowup = true;
      }
    } else {
      wsSend(entry.ws, { type: 'system_message', sessionId, message: compactDoneMessage(entry.agent || 'claude') });
    }
  }

  if (contextLimitExceeded && !pendingSlash && session && getRuntimeSessionId(session)) {
    const nextRetryCount = Number(pendingRetry?.autoRetryCount || 0) + 1;
    if (nextRetryCount > MAX_AUTO_COMPACT_RETRIES) {
      pendingCompactRetries.delete(sessionId);
      wsSend(entry.ws, { type: 'system_message', sessionId, message: '自动 /compact 重试已达到上限，请手动缩短输入内容后再试。' });
    } else {
      pendingCompactRetries.set(sessionId, {
        text: pendingRetry?.text || '',
        mode: pendingRetry?.mode || entry.permissionMode || session.permissionMode || 'yolo',
        reason: 'auto',
        autoRetryCount: nextRetryCount,
      });
      wsSend(entry.ws, { type: 'system_message', sessionId, message: compactAutoStartMessage(entry.agent || 'claude') });
      shouldAutoCompact = true;
    }
  }

  if (completionError && !entry.errorSent && !shouldAutoCompact) {
    entry.errorSent = true;
    wsSend(entry.ws, { type: 'error', sessionId, message: completionError });
  }

  wsSend(entry.ws, {
    type: 'done',
    sessionId,
    costUsd: entry.lastCost ?? null,
    interrupted: false,
  });
  sendSessionList(entry.ws);
  return { shouldReturnForFollowup, shouldAutoCompact };
}

function handleDisconnectedProcessCompletion(sessionId, entry) {
  const session = loadSession(sessionId);
  const title = session?.title || 'Untitled';
  const sessions = getSessionListSnapshot();
  const interrupted = !!entry.abortRequested;
  if (interrupted) {
    pendingCompactRetries.delete(sessionId);
    pendingSlashCommands.delete(sessionId);
  }
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.isAuthenticated !== true) continue;
    sendSessionList(client, { sessions });
    if (wsSessionMap.get(client) !== sessionId) continue;
    wsSend(client, {
      type: 'background_done',
      sessionId,
      title,
      costUsd: entry.lastCost ?? null,
      responseLen: (entry.fullText || '').length,
      interrupted,
    });
  }
  const cost = entry.lastCost !== null && entry.lastCost !== undefined ? `$${entry.lastCost.toFixed(4)}` : '';
  const respLen = (entry.fullText || '').length;
  sendNotification(
    interrupted ? 'webcoding 任务已中断' : 'webcoding 任务完成',
    `会话: ${title}\n字数: ${respLen}\n费用: ${cost}${interrupted ? '\n状态: 已中断' : ''}`
  );
}

function runProcessCompletionFollowup(sessionId, entry, session, pendingSlash, pendingRetry, contextLimitExceeded, shouldReturnForFollowup, shouldAutoCompact) {
  if (entry?.abortRequested) {
    pendingCompactRetries.delete(sessionId);
    pendingSlashCommands.delete(sessionId);
    return;
  }
  if (!shouldReturnForFollowup && !shouldAutoCompact && !contextLimitExceeded && pendingRetry && pendingRetry.text === (entry.fullText || '').trim()) {
    pendingCompactRetries.delete(sessionId);
  }

  if (shouldReturnForFollowup && entry.ws && entry.ws.readyState === 1 && session && pendingSlash?.kind === 'compact') {
    const retry = pendingCompactRetries.get(sessionId);
    if (retry?.text) {
      pendingCompactRetries.delete(sessionId);
      handleMessage(entry.ws, { text: retry.text, sessionId, mode: retry.mode || session.permissionMode || 'yolo' });
    }
    return;
  }

  if (shouldAutoCompact && entry.ws && entry.ws.readyState === 1 && session) {
    pendingSlashCommands.set(sessionId, { kind: 'compact' });
    handleMessage(entry.ws, { text: '/compact', sessionId, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
  }
}

function handleProcessComplete(sessionId, exitCode, signal) {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  if (entry.tailer) {
    entry.tailer.readNew();
    entry.tailer.stop();
  }

  const pendingSlash = pendingSlashCommands.get(sessionId) || null;
  clearPendingSlashCommand(sessionId, pendingSlash);
  const { pendingRetry, contextLimitExceeded, completionError } = resolveProcessCompletionState(sessionId, entry, exitCode, signal);
  const session = persistProcessCompletionSession(sessionId, entry, pendingSlash);

  removeActiveProcess(sessionId);
  cleanRunDir(sessionId);

  const { shouldReturnForFollowup, shouldAutoCompact } = entry.ws
    ? handleConnectedProcessCompletion(sessionId, entry, session, pendingSlash, pendingRetry, contextLimitExceeded, completionError)
    : (handleDisconnectedProcessCompletion(sessionId, entry), { shouldReturnForFollowup: false, shouldAutoCompact: false });

  runProcessCompletionFollowup(
    sessionId,
    entry,
    session,
    pendingSlash,
    pendingRetry,
    contextLimitExceeded,
    shouldReturnForFollowup,
    shouldAutoCompact
  );
}

// Global PID monitor: detect process completion (especially after server restart)
setInterval(() => {
  for (const [sessionId, entry] of activeProcesses) {
    if (entry.transport === 'pi-rpc' || entry.transport === 'codex-app-server' || entry.transport === 'claude-stream-json') continue;
    if (entry.pendingProcessComplete) continue;
    if (entry.pid && !isProcessRunning(entry.pid)) {
      plog('INFO', 'pid_monitor_detected_exit', {
        sessionId: sessionId.slice(0, 8),
        pid: entry.pid,
        wsConnected: !!entry.ws,
      });
      handleProcessComplete(sessionId, null, 'unknown (detected by monitor)');
    }
  }
}, 2000);

setInterval(() => {
  const cutoff = Date.now() - PI_RPC_IDLE_TIMEOUT_MS;
  for (const runtime of piRpcRuntimes.values()) {
    if (!activeProcesses.has(runtime.sessionId) && runtime.lastUsedAt < cutoff) {
      disposePiRpcRuntime(runtime.sessionId, 'idle_timeout');
    }
  }
}, 60_000).unref?.();

setInterval(() => {
  const cutoff = Date.now() - CODEX_APP_IDLE_TIMEOUT_MS;
  for (const runtime of codexAppRuntimes.values()) {
    if (!activeProcesses.has(runtime.sessionId) && runtime.lastUsedAt < cutoff) {
      disposeCodexAppRuntime(runtime.sessionId, 'idle_timeout');
    }
  }
}, 60_000).unref?.();

setInterval(() => {
  const cutoff = Date.now() - CLAUDE_STREAM_IDLE_TIMEOUT_MS;
  for (const runtime of claudeStreamRuntimes.values()) {
    if (!activeProcesses.has(runtime.sessionId) && runtime.lastUsedAt < cutoff) {
      disposeClaudeStreamRuntime(runtime.sessionId, 'idle_timeout');
    }
  }
}, 60_000).unref?.();

cleanupExpiredAttachments();
setInterval(cleanupExpiredAttachments, 6 * 60 * 60 * 1000);
setInterval(() => cleanupExpiredTokens(), AUTH_TOKEN_CLEANUP_MS);
setInterval(() => cleanupAuthAttempts(), AUTH_TOKEN_CLEANUP_MS);

// Recover processes that were running before server restart
function recoverProcesses() {
  try {
    const runDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('-run'))
      .map((entry) => entry.name);
    if (runDirs.length === 0) return;
    plog('INFO', 'recovery_start', { runDirs: runDirs.length });
    for (const dirName of runDirs) {
      const sessionId = dirName.replace('-run', '');
      const dir = path.join(SESSIONS_DIR, dirName);
      const pidPath = path.join(dir, 'pid');
      const outputPath = path.join(dir, 'output.jsonl');
      const session = loadSession(sessionId);
      const agent = getSessionAgent(session);

      if (!fs.existsSync(pidPath)) {
        try { fs.rmSync(dir, { recursive: true }); } catch {}
        continue;
      }

      const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));

      if (isProcessRunning(pid)) {
        console.log(`[recovery] Re-attaching to session ${sessionId} (PID ${pid})`);
        const runMeta = readRunMeta(sessionId);
        const permissionMode = runMeta?.permissionMode || session?.permissionMode || 'yolo';
        plog('INFO', 'recovery_alive', { sessionId: sessionId.slice(0, 8), pid, agent, permissionMode });
        const entry = {
          runId: runMeta?.runId || `legacy-${sessionId}-${runMeta?.startedAt || pid}`,
          pid,
          ws: null,
          agent,
          permissionMode,
          abortRequested: false,
          fullText: '',
          toolCalls: [],
          segments: [],
          lastCost: null,
          lastUsage: null,
          lastError: null,
          errorSent: false,
          tailer: null,
        };
        setActiveProcess(sessionId, entry);

        if (fs.existsSync(outputPath)) {
          entry.tailer = new FileTailer(outputPath, (line) => {
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(entry, event, sessionId);
            } catch {}
          });
          entry.tailer.start();
        }
      } else {
        // Process finished while server was down — read all output and save
        console.log(`[recovery] Processing completed output for session ${sessionId}`);
        plog('INFO', 'recovery_dead', { sessionId: sessionId.slice(0, 8), pid, agent });
        if (fs.existsSync(outputPath)) {
          const runMeta = readRunMeta(sessionId);
          const tempEntry = {
            runId: runMeta?.runId || `legacy-${sessionId}-${runMeta?.startedAt || pid}`,
            pid: 0,
            ws: null,
            agent,
            fullText: '',
            toolCalls: [],
            segments: [],
            lastCost: null,
            lastUsage: null,
            lastError: null,
            errorSent: false,
            tailer: null,
          };
          const content = fs.readFileSync(outputPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(tempEntry, event, sessionId);
            } catch {}
          }
          if (session && (tempEntry.fullText || (tempEntry.toolCalls && tempEntry.toolCalls.length > 0))) {
            const modelId = String(tempEntry.resolvedModel || tempEntry.effectiveModel || resolveEffectiveModelId(session) || '').trim() || null;
            session.messages.push({
              role: 'assistant',
              content: tempEntry.fullText,
              toolCalls: tempEntry.toolCalls || [],
              segments: tempEntry.segments || [],
              model: modelId,
              timestamp: new Date().toISOString(),
            });
            session.updated = new Date().toISOString();
            saveSession(session);
          }
        }
        try { fs.rmSync(dir, { recursive: true }); } catch {}
      }
    }
  } catch (err) {
    console.error('[recovery] Error:', err.message);
  }
}

// === HTTP Static File Server ===
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let rawName = 'image';
    try {
      rawName = decodeURIComponent(String(req.headers['x-filename'] || 'image'));
    } catch {
      rawName = String(req.headers['x-filename'] || 'image');
    }
    const filename = safeFilename(rawName);
    if (!IMAGE_MIME_TYPES.has(mime)) {
      return jsonResponse(res, 400, { ok: false, message: '仅支持 PNG/JPG/WEBP/GIF 图片' });
    }

    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_ATTACHMENT_SIZE) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) {
        return jsonResponse(res, 413, { ok: false, message: '图片大小不能超过 10MB' });
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容为空' });
      }
      const actualMime = detectMimeFromMagic(buffer);
      if (!actualMime || actualMime !== mime) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容与声明类型不一致或文件已损坏' });
      }
      const id = crypto.randomUUID();
      const ext = extFromMime(mime) || path.extname(filename) || '';
      const dataPath = attachmentDataPath(id, ext);
      const now = new Date();
      const meta = {
        id,
        kind: 'image',
        filename,
        mime,
        size: buffer.length,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ATTACHMENT_TTL_MS).toISOString(),
        path: dataPath,
      };
      try {
        fs.writeFileSync(dataPath, buffer);
        saveAttachmentMeta(meta);
        return jsonResponse(res, 200, {
          ok: true,
          attachment: {
            id,
            kind: 'image',
            filename,
            mime,
            size: buffer.length,
            createdAt: meta.createdAt,
            expiresAt: meta.expiresAt,
            storageState: 'available',
          },
        });
      } catch (err) {
        try { if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath); } catch {}
        try { if (fs.existsSync(attachmentMetaPath(id))) fs.unlinkSync(attachmentMetaPath(id)); } catch {}
        return jsonResponse(res, 500, { ok: false, message: '保存附件失败，请稍后重试' });
      }
    });
    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, message: '上传过程中断' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/localfile') {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      writeHeadWithSecurity(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not authenticated');
    }
    let rawPath = url.searchParams.get('path') || '';
    try { rawPath = decodeURIComponent(rawPath); } catch {}
    rawPath = rawPath.trim();
    if (!rawPath || !path.isAbsolute(rawPath)) {
      writeHeadWithSecurity(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Invalid path');
    }
    const absPath = path.resolve(rawPath);
    fs.readFile(absPath, 'utf8', (err, data) => {
      if (err) {
        writeHeadWithSecurity(res, 404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>文件未找到</title><style>body{font-family:system-ui,sans-serif;padding:40px;color:#333}h2{color:#c00}</style></head><body><h2>文件未找到</h2><p>${absPath.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p></body></html>`);
      }
      const ext = path.extname(absPath).toLowerCase();
      if (ext === '.md' || ext === '.markdown') {
        const encodedMarkdown = JSON.stringify(data)
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
          .replace(/&/g, '\\u0026');
        const viewerVersion = getPublicAssetVersion('markdown-viewer.js');
        const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${path.basename(absPath).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</title>
<style>body{font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;max-width:860px;margin:0 auto;padding:32px 24px;color:#222}pre{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto}code{background:#f0f0f0;padding:1px 5px;border-radius:3px;font-size:0.9em}pre code{background:none;padding:0}img{max-width:100%}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px}th{background:#f5f5f5}blockquote{border-left:3px solid #ccc;margin:0;padding-left:14px;color:#666}a{color:#0066cc}hr{border:none;border-top:1px solid #ddd}</style>
</head><body><main id="content"></main>
<script type="application/json" id="markdown-source">${encodedMarkdown}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.1/marked.min.js"></script>
<script src="/markdown-viewer.js?v=${viewerVersion}"></script>
</body></html>`;
        writeHeadWithSecurity(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(htmlContent);
      }
      // Plain text / other text files
      const mime = MIME_TYPES[ext] || 'text/plain; charset=utf-8';
      writeHeadWithSecurity(res, 200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    const token = extractBearerToken(req);
    if (!token || !hasActiveToken(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const id = sanitizeId(url.pathname.split('/').pop() || '');
    if (!id) {
      return jsonResponse(res, 400, { ok: false, message: '缺少附件 ID' });
    }
    removeAttachmentById(id);
    return jsonResponse(res, 200, { ok: true });
  }

  let filePath = path.join(PUBLIC_ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  filePath = path.resolve(filePath);

  if (!isPathInside(filePath, PUBLIC_ROOT)) {
    writeHeadWithSecurity(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = renderIndexHtml();
      writeHeadWithSecurity(res, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(html);
    } catch {
      writeHeadWithSecurity(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Internal Server Error');
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      writeHeadWithSecurity(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    writeHeadWithSecurity(res, 200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// === WebSocket Server ===
function isAllowedWsOrigin(origin, req) {
  if (!origin) return true; // CLI / non-browser clients may not send Origin
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsedOrigin.protocol)) return false;

  const reqHost = String(req?.headers?.host || '').toLowerCase();
  const originHost = String(parsedOrigin.host || '').toLowerCase();
  if (reqHost && originHost === reqHost) return true;

  const allowedHosts = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
  ]);
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::') {
    allowedHosts.add(`${HOST}:${PORT}`);
  }
  return allowedHosts.has(originHost);
}

const wss = new WebSocketServer({
  server,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: (info) => isAllowedWsOrigin(info.origin || info.req?.headers?.origin || '', info.req),
});

wss.on('connection', (ws, req) => {
  ws.isAuthenticated = false;
  ws.authToken = null;
  const wsId = crypto.randomBytes(4).toString('hex'); // short id for log correlation
  const clientIp = getWsClientIp(req);
  plog('INFO', 'ws_connect', { wsId, ip: clientIp });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return wsSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (msg.type === 'auth') {
      if (!hasConfiguredPassword()) {
        plog('ERROR', 'auth_no_password_configured', { wsId, ip: clientIp });
        wsSend(ws, { type: 'auth_result', success: false, error: '服务器密码未配置' });
        return;
      }
      const tokenValid = hasActiveToken(msg.token);
      if (tokenValid) {
        clearAuthFailures(clientIp);
        const nextAuthToken = msg.token;
        rememberActiveToken(nextAuthToken);
        ws.isAuthenticated = true;
        ws.authToken = nextAuthToken;
        wsSend(ws, { type: 'auth_result', success: true, token: nextAuthToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
        return;
      }
      const lockState = getAuthLockState(clientIp);
      if (lockState.locked) {
        const waitSeconds = Math.ceil(lockState.remainingMs / 1000);
        wsSend(ws, { type: 'auth_result', success: false, error: `登录失败次数过多，请 ${waitSeconds} 秒后重试` });
        return;
      }
      const passwordValid = verifyConfiguredPassword(msg.password);
      if (passwordValid) {
        clearAuthFailures(clientIp);
        const nextAuthToken = crypto.randomBytes(32).toString('hex');
        rememberActiveToken(nextAuthToken);
        ws.isAuthenticated = true;
        ws.authToken = nextAuthToken;
        wsSend(ws, { type: 'auth_result', success: true, token: nextAuthToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
      } else {
        const authState = recordAuthFailure(clientIp);
        ws.isAuthenticated = false;
        ws.authToken = null;
        const error = authState.locked
          ? `登录失败次数过多，请 ${Math.ceil(authState.remainingMs / 1000)} 秒后重试`
          : '认证失败';
        wsSend(ws, { type: 'auth_result', success: false, error });
      }
      return;
    }

    if (!ws.isAuthenticated) {
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/')) {
          handleSlashCommand(
            ws,
            msg.text.trim(),
            msg.sessionId,
            msg.agent,
            msg.clientMessageId,
            msg.streamingBehavior,
          );
        } else {
          handleMessage(ws, msg);
        }
        break;
      case 'abort':
        handleAbort(ws);
        break;
      case 'interactive_response':
        handleInteractiveResponse(ws, msg);
        break;
      case 'new_session':
        handleNewSession(ws, msg);
        break;
      case 'load_session':
        handleLoadSession(ws, msg.sessionId);
        break;
      case 'delete_session':
        handleDeleteSession(ws, msg.sessionId);
        break;
      case 'rename_session':
        handleRenameSession(ws, msg.sessionId, msg.title);
        break;
      case 'set_mode':
        handleSetMode(ws, msg.sessionId, msg.mode);
        break;
      case 'list_sessions':
        sendSessionList(ws);
        break;
      case 'detach_view':
        handleDetachView(ws);
        break;
      case 'get_notify_config':
        wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
        break;
      case 'save_notify_config':
        handleSaveNotifyConfig(ws, msg.config);
        break;
      case 'test_notify':
        handleTestNotify(ws);
        break;
      case 'get_tunnel_status':
        wsSend(ws, { type: 'tunnel_status', ...getTunnelStatus() });
        break;
      case 'tunnel_start': {
        const status = startTunnel();
        wsSend(ws, { type: 'tunnel_status', ...status });
        break;
      }
      case 'tunnel_stop': {
        const status = stopTunnel();
        wsSend(ws, { type: 'tunnel_status', ...status });
        break;
      }
      case 'install_cloudflared':
        installCloudflared(ws);
        break;
      case 'change_password':
        handleChangePassword(ws, msg);
        break;
      case 'get_model_config':
        wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
        break;
      case 'save_model_config':
        handleSaveModelConfig(ws, msg.config);
        break;
      case 'get_codex_config':
        wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
        break;
      case 'get_pi_config':
        wsSend(ws, { type: 'pi_config', config: getPiConfigMasked() });
        break;
      case 'save_pi_config':
        handleSavePiConfig(ws, msg.config);
        break;
      case 'get_slash_commands': {
        const slashAgent = normalizeAgent(msg.agent || 'claude');
        const sendSlashList = () => {
          wsSend(ws, {
            type: 'slash_commands_list',
            agent: slashAgent,
            commands: buildSlashCommandList(slashAgent),
            capabilities: getRuntimeCapabilities(slashAgent),
          });
        };
        if (slashAgent === 'claude') {
          // Claude: capture init metadata without sending a model turn.
          const viewedSession = loadSession(wsSessionMap.get(ws));
          discoverClaudeSlashCommands({ cwd: viewedSession?.cwd || null })
            .then(sendSlashList)
            .catch(sendSlashList);
        } else if (slashAgent === 'pi') {
          const viewedSession = loadSession(wsSessionMap.get(ws));
          if (PI_TRANSPORT === 'rpc' && viewedSession && getSessionAgent(viewedSession) === 'pi') {
            const spawnSpec = buildPiSpawnSpec(viewedSession, { transport: 'rpc' });
            ensurePiRpcRuntime(viewedSession, spawnSpec)
              .then((runtime) => refreshPiRpcDiscovery(runtime))
              .then(sendSlashList)
              .catch(sendSlashList);
          } else {
            sendSlashList();
          }
        } else {
          // Codex: scan filesystem for skills/plugins (real-time discovery)
          discoverCodexSlashCommands();
          sendSlashList();
        }
        break;
      }
      case 'save_codex_config':
        handleSaveCodexConfig(ws, msg.config);
        break;
      case 'fetch_models':
        handleFetchModels(ws, msg);
        break;
      case 'get_model_list':
        wsSend(ws, { type: 'model_list', models: MODEL_MAP });
        break;
      case 'check_update':
        handleCheckUpdate(ws);
        break;
      case 'list_native_sessions':
        handleListNativeSessions(ws);
        break;
      case 'import_native_session':
        handleImportNativeSession(ws, msg);
        break;
      case 'list_codex_sessions':
        handleListCodexSessions(ws);
        break;
      case 'import_codex_session':
        handleImportCodexSession(ws, msg);
        break;
      case 'list_pi_sessions':
        handleListPiSessions(ws);
        break;
      case 'import_pi_session':
        handleImportPiSession(ws, msg);
        break;
      case 'fork_pi_session':
        handlePiForkSelection(ws, msg).catch((error) => {
          wsSend(ws, {
            type: 'error',
            sessionId: sanitizeId(msg?.sessionId || '') || null,
            message: `Pi Fork 失败：${error.message}`,
          });
        });
        break;
      case 'list_cwd_suggestions':
        handleListCwdSuggestions(ws);
        break;
      case 'browse_directory':
        handleBrowseDirectory(ws, msg);
        break;
      case 'get_projects':
        wsSend(ws, { type: 'projects_config', projects: loadProjectsConfig().projects });
        break;
      case 'save_project':
        handleSaveProject(ws, msg);
        break;
      case 'delete_project':
        handleDeleteProject(ws, msg);
        break;
      case 'rename_project':
        handleRenameProject(ws, msg);
        break;
      case 'git_command':
        handleGitCommand(ws, msg);
        break;
      default:
        wsSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => handleDisconnect(ws, wsId));
  ws.on('error', (err) => {
    plog('WARN', 'ws_error', { wsId, error: err.message });
    handleDisconnect(ws, wsId);
  });
});

// === Notify Config Handlers ===
function handleSaveNotifyConfig(ws, newConfig) {
  if (!newConfig || !newConfig.provider) {
    return wsSend(ws, { type: 'error', message: '无效的通知配置' });
  }
  if (newConfig.provider === 'feishu') {
    const candidateWebhook = String(newConfig.feishu?.webhook || '').trim();
    if (candidateWebhook && !candidateWebhook.includes('****')) {
      const validation = validateFeishuWebhook(candidateWebhook);
      if (!validation.ok) {
        return wsSend(ws, { type: 'error', message: validation.error });
      }
    }
  }
  const current = loadNotifyConfig();
  // Merge: only update fields that are not masked (contain ****)
  const merged = { provider: newConfig.provider };
  merged.pushplus = { token: mergeSecretField(newConfig.pushplus?.token, current.pushplus?.token) };
  merged.telegram = {
    botToken: mergeSecretField(newConfig.telegram?.botToken, current.telegram?.botToken),
    chatId: newConfig.telegram?.chatId !== undefined ? newConfig.telegram.chatId : current.telegram?.chatId || '',
  };
  merged.serverchan = { sendKey: mergeSecretField(newConfig.serverchan?.sendKey, current.serverchan?.sendKey) };
  merged.feishu = { webhook: mergeSecretField(newConfig.feishu?.webhook, current.feishu?.webhook) };
  merged.qqbot = { qmsgKey: mergeSecretField(newConfig.qqbot?.qmsgKey, current.qqbot?.qmsgKey) };

  saveNotifyConfig(merged);
  plog('INFO', 'notify_config_saved', { provider: merged.provider });
  wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '通知配置已保存' });
}

function handleTestNotify(ws) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') {
    return wsSend(ws, { type: 'notify_test_result', success: false, message: '通知已关闭，无法测试' });
  }
  sendNotification('webcoding 测试通知', '这是一条测试消息，如果你收到了说明通知配置正确！').then((result) => {
    wsSend(ws, { type: 'notify_test_result', success: result.ok, message: result.ok ? '测试消息已发送，请检查是否收到' : `发送失败: ${result.error || result.body || '未知错误'}` });
  });
}

function handleChangePassword(ws, msg) {
  const currentPassword = String(msg?.currentPassword || '');
  const newPassword = String(msg?.newPassword || '');

  // For regular password changes, verify current password. For first-run mustChange flow,
  // the user has just authenticated with the initial password so we can skip re-check.
  if (!authConfig?.mustChange) {
    if (!currentPassword) {
      return wsSend(ws, { type: 'password_changed', success: false, message: '请输入当前密码' });
    }
    if (!verifyConfiguredPassword(currentPassword)) {
      return wsSend(ws, { type: 'password_changed', success: false, message: '当前密码错误' });
    }
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return wsSend(ws, { type: 'password_changed', success: false, message: strength.message });
  }

  // Save new password
  authConfig = { passwordHash: hashPassword(newPassword), mustChange: false };
  saveAuthConfig(authConfig);
  PASSWORD_HASH = authConfig.passwordHash;
  plog('INFO', 'password_changed', {});

  // Clear all tokens so every existing login must re-authenticate.
  activeTokens.clear();

  // Generate new token for current connection
  const newToken = crypto.randomBytes(32).toString('hex');
  rememberActiveToken(newToken);
  ws.authToken = newToken;
  ws.isAuthenticated = true;

  for (const client of wss.clients) {
    if (client === ws) continue;
    if (client.isAuthenticated !== true) continue;
    forceLogoutClient(client, '密码已修改，当前登录状态已失效，请重新登录。');
  }

  wsSend(ws, { type: 'password_changed', success: true, token: newToken, message: '密码修改成功' });
}

// === Model Config Handler ===
function handleSaveModelConfig(ws, newConfig) {
  if (!newConfig || !['local', 'custom'].includes(newConfig.mode)) {
    return wsSend(ws, { type: 'error', message: '无效的模型配置' });
  }
  const current = loadModelConfig();
  const previousTemplate = current.mode === 'custom' && current.activeTemplate
    ? (Array.isArray(current.templates) ? current.templates.find((item) => item.name === current.activeTemplate) : null)
    : null;
  const merged = {
    mode: newConfig.mode,
    activeTemplate: newConfig.activeTemplate || '',
    templates: [],
  };

  // Merge templates: keep existing secrets if masked
  const newTemplates = Array.isArray(newConfig.templates) ? newConfig.templates : [];
  const oldTemplates = Array.isArray(current.templates) ? current.templates : [];
  for (const nt of newTemplates) {
    if (!nt.name || !nt.name.trim()) continue;
    const originalName = String(nt.originalName || nt.name).trim();
    const old = oldTemplates.find(t => t.name === originalName);
    merged.templates.push({
      name: nt.name.trim(),
      apiKey: mergeSecretField(nt.apiKey, old?.apiKey),
      apiBase: nt.apiBase || '',
      upstreamType: nt.upstreamType === 'anthropic' ? 'anthropic' : 'openai',
      defaultModel: nt.defaultModel || '',
      opusModel: nt.opusModel || '',
      sonnetModel: nt.sonnetModel || '',
      haikuModel: nt.haikuModel || '',
    });
  }
  if (merged.mode === 'custom' && !selectTemplateByName(merged.templates, merged.activeTemplate)) {
    merged.activeTemplate = merged.templates[0]?.name || '';
  }
  if (merged.mode === 'local') {
    merged.activeTemplate = '';
  }

  saveModelConfig(merged);

  // Re-apply at runtime
  MODEL_MAP = { ...DEFAULT_CLAUDE_MODEL_MAP };
  applyModelConfig();
  // Custom mode uses an isolated settings file passed with --settings.
  if (merged.mode === 'custom' && merged.activeTemplate) {
    restoreManagedClaudeSettings(previousTemplate, { onlyIfBackupExists: true });
    const tpl = merged.templates.find(t => t.name === merged.activeTemplate);
    if (tpl) applyCustomTemplateToSettings(tpl);
  } else {
    restoreManagedClaudeSettings(previousTemplate, { onlyIfBackupExists: true });
    clearClaudeRuntimeSettings();
  }
  refreshCodexGeneratedRuntimeSnapshot('codex_runtime_refresh_after_model_save');
  plog('INFO', 'model_config_saved', { mode: merged.mode, activeTemplate: merged.activeTemplate });
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '模型配置已保存' });
}

function handleSavePiConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Pi 配置' });
  }
  const mode = normalizePiMode(newConfig.mode);
  const sharedTemplate = String(newConfig.sharedTemplate || '').trim();
  if (mode === 'unified') {
    const modelConfig = loadModelConfig();
    const templates = Array.isArray(modelConfig.templates) ? modelConfig.templates : [];
    if (!templates.length) {
      return wsSend(ws, { type: 'error', message: 'Pi 使用 AI 提供商时，请先创建至少一个提供商配置' });
    }
    if (sharedTemplate && !templates.find((t) => t.name === sharedTemplate)) {
      return wsSend(ws, { type: 'error', message: `Pi 选中的提供商「${sharedTemplate}」不存在` });
    }
  }
  savePiConfig({
    mode,
    sharedTemplate: mode === 'unified' ? sharedTemplate : '',
  });
  // Eagerly materialize runtime home so misconfig surfaces at save time.
  const prepared = preparePiCustomRuntime(loadPiConfig());
  if (prepared?.error) {
    return wsSend(ws, { type: 'error', message: prepared.error });
  }
  plog('INFO', 'pi_config_saved', {
    mode,
    sharedTemplate: mode === 'unified' ? sharedTemplate : '',
  });
  wsSend(ws, { type: 'pi_config', config: getPiConfigMasked() });
  wsSend(ws, {
    type: 'system_message',
    message: mode === 'unified'
      ? 'Pi 配置已保存。当前将使用选中的 AI 提供商（写入隔离运行时，不影响 ~/.pi/agent）。'
      : 'Pi 配置已保存。当前读取本机 ~/.pi/agent 配置。',
  });
}

function handleSaveCodexConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Codex 配置' });
  }
  const current = loadCodexConfig();
  const incomingMode = normalizeCodexMode(newConfig.mode);
  const incomingLegacyMode = resolveCodexLegacyMode(newConfig.legacyMode || newConfig.mode);
  const profilesProvided = Array.isArray(newConfig.profiles);
  const newProfiles = profilesProvided ? newConfig.profiles : (Array.isArray(current.profiles) ? current.profiles : []);
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const profile of newProfiles) {
    const name = String(profile?.name || '').trim();
    if (!name) continue;
    const originalName = String(profile?.originalName || name).trim();
    const old = oldProfiles.find((item) => item.name === originalName);
    const rawApiKey = String(profile?.apiKey || '');
    mergedProfiles.push({
      name,
      apiKey: mergeSecretField(rawApiKey, old?.apiKey),
      apiBase: String(profile?.apiBase || '').trim(),
      defaultModel: String(profile?.defaultModel || '').trim(),
    });
  }
  const requestedSearch = !!newConfig.enableSearch;
  const merged = {
    mode: incomingMode,
    legacyMode: incomingLegacyMode,
    activeProfile: String(profilesProvided ? (newConfig.activeProfile || '') : (current.activeProfile || '')).trim(),
    sharedTemplate: String(newConfig.sharedTemplate !== undefined ? newConfig.sharedTemplate : (current.sharedTemplate || '')).trim(),
    profiles: mergedProfiles,
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: requestedSearch,
  };
  if (merged.legacyMode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }
  if (merged.mode === 'unified' && !merged.sharedTemplate) {
    const modelConfig = loadModelConfig();
    const templates = Array.isArray(modelConfig.templates) ? modelConfig.templates : [];
    merged.sharedTemplate = modelConfig.activeTemplate || templates[0]?.name || '';
  }
  if (merged.mode === 'unified') {
    const modelConfig = loadModelConfig();
    const template = getCodexSelectedTemplate(merged, modelConfig);
    merged.sharedTemplate = template?.name || '';
  } else {
    merged.sharedTemplate = '';
  }
  saveCodexConfig(merged);
  refreshCodexGeneratedRuntimeSnapshot('codex_runtime_refresh_after_codex_save');
  plog('INFO', 'codex_config_saved', {
    mode: merged.mode,
    legacyMode: merged.legacyMode || null,
    activeProfile: merged.activeProfile || null,
    sharedTemplate: merged.sharedTemplate || null,
    profileCount: merged.profiles.length,
    enableSearchRequested: requestedSearch,
    enableSearchEffective: false,
  });
  wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
  wsSend(ws, {
    type: 'system_message',
    message: requestedSearch
      ? 'Codex 配置已保存。当前 webcoding 的 Codex exec 路径暂未接入 Web Search，已自动忽略该开关。'
      : 'Codex 配置已保存',
  });
}

// === Fetch Upstream Models ===
function handleFetchModels(ws, msg) {
  const { apiBase, apiKey } = msg;
  if (!apiBase || !apiKey) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '需要填写 API Base 和 API Key' });
  }
  const agent = msg.agent === 'codex' ? 'codex' : 'claude';
  const upstreamType = msg.upstreamType === 'anthropic' ? 'anthropic' : 'openai';
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  let fullUrl = '';
  try {
    const spec = buildModelsRequestSpec(base, apiKey, upstreamType);
    fullUrl = spec.fullUrl;
  } catch (error) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: error.message || '无效的 API Base URL' });
  }

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '无效的 URL: ' + fullUrl });
  }

  // Resolve real apiKey (if masked, look up saved config by template name or apiBase)
  let realKey = apiKey;
  if (apiKey.includes('****')) {
    if (msg.templateName) {
      const config = loadModelConfig();
      const saved = Array.isArray(config.templates) ? config.templates : [];
      const template = saved.find((item) => item.name === msg.templateName)
        || saved.find((item) => item.apiBase && item.apiBase.replace(/\/+$/, '') === base)
        || null;
      if (template && template.apiKey && !template.apiKey.includes('****')) {
        realKey = template.apiKey;
      } else {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
      }
    } else if (agent === 'codex') {
      const config = loadCodexConfig();
      const saved = Array.isArray(config.profiles) ? config.profiles : [];
      const profile = (msg.profileName && saved.find((item) => item.name === msg.profileName))
        || saved.find((item) => item.apiBase && item.apiBase.replace(/\/+$/, '') === base)
        || null;
      if (profile && profile.apiKey && !profile.apiKey.includes('****')) {
        realKey = profile.apiKey;
      } else {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
      }
    } else {
      const config = loadModelConfig();
      const saved = config.templates || [];
      const tpl = (msg.templateName && saved.find((item) => item.name === msg.templateName))
        || saved.find((item) => item.apiBase && item.apiBase.replace(/\/+$/, '') === base)
        || null;
      if (tpl && tpl.apiKey && !tpl.apiKey.includes('****')) {
        realKey = tpl.apiKey;
      } else {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
      }
    }
  }

  const mod = parsed.protocol === 'https:' ? require('https') : require('http');
  const reqOptions = {
    method: 'GET',
    headers: buildModelsRequestSpec(base, realKey, upstreamType).headers,
    timeout: 15000,
  };

  const req = mod.request(parsed, reqOptions, (res) => {
    let body = '';
    let bodyBytes = 0;
    res.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > HTTP_BODY_MAX_BYTES) {
        req.destroy(new Error('response too large'));
        return;
      }
      body += chunk;
    });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
      }
      try {
        const json = JSON.parse(body);
        const models = agent === 'codex'
          ? normalizeCodexModelEntries(json.data || json.models || []).map((entry) => entry.value)
          : (json.data || json.models || []).map((item) => typeof item === 'string' ? item : item.id || item.name || '').filter(Boolean).sort();
        wsSend(ws, { type: 'fetch_models_result', success: true, models });
      } catch (e) {
        wsSend(ws, { type: 'fetch_models_result', success: false, message: '解析响应失败: ' + e.message });
      }
    });
  });

  req.on('error', (e) => {
    if (agent === 'claude' && upstreamType === 'anthropic' && isTlsHandshakeFailure(e)) {
      const fallbackModels = getClaudeFallbackModels();
      if (fallbackModels.length) {
        return wsSend(ws, {
          type: 'fetch_models_result',
          success: true,
          models: fallbackModels,
          fallback: true,
          message: `上游拒绝了当前直连探测，已改用内置 Claude 模型列表（${fallbackModels.length} 个）。这类只面向官方 Claude Code CLI 的服务常会这样；你也可以直接手填模型 ID。`,
        });
      }
    }
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求超时 (15s)' });
  });
  req.end();
}

// === Client message idempotency (short-lived) ===
const acceptedClientMessages = new Map(); // key -> { timestamp, ack }
const ACCEPTED_CLIENT_MESSAGE_TTL_MS = 10 * 60 * 1000;

function rememberAcceptedClientMessage(sessionId, clientMessageId, ack = null) {
  if (!sessionId || !clientMessageId) return;
  const key = `${sessionId}:${clientMessageId}`;
  acceptedClientMessages.set(key, {
    timestamp: Date.now(),
    ack: ack && typeof ack === 'object' ? { ...ack } : null,
  });
  // Opportunistic cleanup
  if (acceptedClientMessages.size > 2000) {
    const cutoff = Date.now() - ACCEPTED_CLIENT_MESSAGE_TTL_MS;
    for (const [k, record] of acceptedClientMessages) {
      const timestamp = typeof record === 'number' ? record : record?.timestamp;
      if (!timestamp || timestamp < cutoff) acceptedClientMessages.delete(k);
    }
  }
}

function wasClientMessageAccepted(sessionId, clientMessageId) {
  if (!sessionId || !clientMessageId) return false;
  const key = `${sessionId}:${clientMessageId}`;
  const record = acceptedClientMessages.get(key);
  const timestamp = typeof record === 'number' ? record : record?.timestamp;
  if (!timestamp) return false;
  if (Date.now() - timestamp > ACCEPTED_CLIENT_MESSAGE_TTL_MS) {
    acceptedClientMessages.delete(key);
    return false;
  }
  return true;
}

function getAcceptedClientMessageAck(sessionId, clientMessageId) {
  if (!wasClientMessageAccepted(sessionId, clientMessageId)) return {};
  const record = acceptedClientMessages.get(`${sessionId}:${clientMessageId}`);
  return record && typeof record === 'object' && record.ack
    ? { ...record.ack }
    : {};
}

function normalizeClientMessageId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return value.slice(0, 120);
}

function sendMessageAccepted(ws, sessionId, clientMessageId, extra = {}) {
  if (!clientMessageId) return;
  wsSend(ws, {
    type: 'message_accepted',
    sessionId: sessionId || null,
    clientMessageId,
    ...extra,
  });
}

async function performCodexFork(ws, session) {
  if (!session || CODEX_TRANSPORT !== 'app-server') {
    throw new Error('当前 Codex 运行方式不支持原生 Fork。');
  }
  const spawnSpec = buildCodexSpawnSpec(session, { transport: 'app-server' });
  if (spawnSpec?.error) throw new Error(spawnSpec.error);
  const threadId = spawnSpec.runtimeId || getRuntimeSessionId(session, {
    agent: 'codex',
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  });
  if (!threadId) throw new Error('当前会话尚未建立 Codex 原生线程，无法 Fork。');
  const runtime = await ensureCodexAppRuntime(session, spawnSpec);
  const result = await runtime.client.request('thread/fork', {
    threadId,
    cwd: spawnSpec.cwd,
    model: session.model || null,
    approvalPolicy: spawnSpec.approvalPolicy,
    sandbox: spawnSpec.threadSandbox,
  }, { timeoutMs: 30_000 });
  const forkedThreadId = result?.thread?.id;
  if (!forkedThreadId) throw new Error('Codex App Server 未返回 Fork 后的 threadId。');

  const now = new Date().toISOString();
  const runtimeContexts = cloneJson(session.runtimeContexts || { claude: {}, codex: {}, pi: {} });
  runtimeContexts.codex = {};
  const forked = {
    ...cloneJson(session),
    id: crypto.randomUUID(),
    title: `${session.title || 'Codex 会话'}（分支）`.slice(0, 100),
    created: now,
    updated: now,
    hasUnread: false,
    messages: cloneJson(session.messages || []),
    codexThreadId: null,
    codexRuntimeFingerprint: spawnSpec.runtimeFingerprint || null,
    importedRolloutPath: null,
    runtimeContexts,
  };
  setRuntimeSessionState(forked, {
    runtimeId: forkedThreadId,
    runtimeFingerprint: spawnSpec.runtimeFingerprint || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  }, {
    agent: 'codex',
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  });
  saveSession(forked);
  wsSessionMap.set(ws, forked.id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: forked.id,
    messages: forked.messages,
    title: forked.title,
    mode: forked.permissionMode || 'yolo',
    model: sessionModelLabel(forked),
    agent: 'codex',
    cwd: forked.cwd || null,
    totalCost: forked.totalCost || 0,
    totalUsage: forked.totalUsage || null,
    updated: forked.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    ...buildSessionRuntimeMeta(forked),
  });
  sendSessionList(ws);
  wsSend(ws, {
    type: 'system_message',
    sessionId: forked.id,
    message: '已通过 Codex App Server Fork 当前线程，原会话保持不变。',
  });
}

async function handleCodexFork(ws, session) {
  if (!session?.id) throw new Error('当前没有可 Fork 的 Codex 会话。');
  if (codexForkOperations.has(session.id)) {
    throw new Error('当前 Codex 会话正在创建分支，请稍候。');
  }
  codexForkOperations.add(session.id);
  try {
    return await performCodexFork(ws, session);
  } finally {
    codexForkOperations.delete(session.id);
  }
}

function normalizePiForkOptions(messages) {
  const options = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const entryId = String(message?.entryId || '').trim();
    const text = String(message?.text || '').trim();
    if (!entryId || !text || seen.has(entryId)) continue;
    seen.add(entryId);
    options.push({ entryId, text: text.slice(0, 4000) });
  }
  const total = options.length;
  const visible = options.slice(-1000);
  return { options: visible, total, truncated: visible.length < total };
}

async function getPiForkOptions(session) {
  if (!session || PI_TRANSPORT !== 'rpc') {
    throw new Error('当前 Pi 运行方式不支持原生 Fork。');
  }
  const spawnSpec = buildPiSpawnSpec(session, { transport: 'rpc' });
  if (spawnSpec?.error) throw new Error(spawnSpec.error);
  const sourceRuntimeId = spawnSpec.runtimeId || getRuntimeSessionId(session, {
    agent: 'pi',
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  });
  if (!sourceRuntimeId) throw new Error('当前会话尚未建立 Pi 原生线程，无法 Fork。');
  const runtime = await ensurePiRpcRuntime(session, spawnSpec);
  const response = await runtime.client.request({ type: 'get_fork_messages' }, { timeoutMs: 15_000 });
  return normalizePiForkOptions(response.data?.messages);
}

async function sendPiForkOptions(ws, session) {
  const result = await getPiForkOptions(session);
  if (result.options.length === 0) {
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: '当前 Pi 会话还没有可作为分支起点的用户消息。',
    });
    return;
  }
  wsSend(ws, {
    type: 'pi_fork_options',
    sessionId: session.id,
    options: result.options,
    total: result.total,
    truncated: result.truncated,
  });
}

function materializePiForkSessionFile(session, forkState, originalFile) {
  const sessionFile = path.resolve(String(forkState?.sessionFile || ''));
  const expectedDir = path.resolve(piSessionDir(session.id));
  if (!forkState?.sessionId || !sessionFile || !isPathInside(sessionFile, expectedDir)) {
    throw new Error('Pi RPC 返回了无效的 Fork 会话路径。');
  }
  if (!fs.existsSync(sessionFile)) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: String(forkState.sessionId),
      timestamp: new Date().toISOString(),
      cwd: session.cwd || process.cwd(),
      parentSession: originalFile,
    })}\n`, { flag: 'wx' });
  }
  const summary = summarizePiSessionFile(sessionFile);
  if (summary?.sessionId !== String(forkState.sessionId)) {
    throw new Error('Pi RPC 返回的 Fork 会话文件与会话编号不匹配。');
  }
  return sessionFile;
}

function cleanupPiForkSessionFile(session, candidatePath, originalFile) {
  const rawCandidate = String(candidatePath || '').trim();
  if (!rawCandidate) return;
  const candidate = path.resolve(rawCandidate);
  const original = path.resolve(String(originalFile || ''));
  if (candidate === original || !isPathInside(candidate, path.resolve(piSessionDir(session.id)))) return;
  try {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  } catch (error) {
    plog('WARN', 'pi_rpc_fork_temp_cleanup_failed', {
      sessionId: session.id.slice(0, 8),
      error: error.message,
    });
  }
}

async function performPiFork(ws, session, entryId = null) {
  if (!session || PI_TRANSPORT !== 'rpc') {
    throw new Error('当前 Pi 运行方式不支持原生 Fork。');
  }
  const spawnSpec = buildPiSpawnSpec(session, { transport: 'rpc' });
  if (spawnSpec?.error) throw new Error(spawnSpec.error);
  const sourceRuntimeId = spawnSpec.runtimeId || getRuntimeSessionId(session, {
    agent: 'pi',
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  });
  if (!sourceRuntimeId) throw new Error('当前会话尚未建立 Pi 原生线程，无法 Fork。');

  const runtime = await ensurePiRpcRuntime(session, spawnSpec);
  const originalStateResponse = await runtime.client.request({ type: 'get_state' }, { timeoutMs: 15_000 });
  const originalState = originalStateResponse.data || runtime.state || null;
  const originalFile = String(originalState?.sessionFile || '').trim();
  if (!originalFile || !fs.existsSync(originalFile)) {
    throw new Error('Pi RPC 未返回可分支的原生会话文件。');
  }

  let forkState = null;
  let forkSessionFile = null;
  let selectedText = '';
  let restored = false;
  let forkOperationError = null;
  try {
    const forkResponse = await runtime.client.request(
      entryId
        ? { type: 'fork', entryId: String(entryId) }
        : { type: 'clone' },
      { timeoutMs: 30_000 },
    );
    if (forkResponse.data?.cancelled) throw new Error('Pi 扩展取消了本次 Fork。');
    selectedText = entryId ? String(forkResponse.data?.text || '') : '';
    const forkStateResponse = await runtime.client.request({ type: 'get_state' }, { timeoutMs: 15_000 });
    forkState = forkStateResponse.data || null;
    if (!forkState?.sessionId || !forkState?.sessionFile) {
      throw new Error('Pi RPC 未返回 Fork 后的会话信息。');
    }
    if (String(forkState.sessionId) === String(sourceRuntimeId)) {
      throw new Error('Pi RPC Fork 后仍返回原会话编号。');
    }
    forkSessionFile = materializePiForkSessionFile(session, forkState, originalFile);
  } catch (error) {
    forkOperationError = error;
  } finally {
    try {
      const restoreResponse = await runtime.client.request({
        type: 'switch_session',
        sessionPath: originalFile,
      }, { timeoutMs: 30_000 });
      if (restoreResponse.data?.cancelled) throw new Error('Pi 扩展取消恢复原会话');
      const restoredStateResponse = await runtime.client.request({ type: 'get_state' }, { timeoutMs: 15_000 });
      runtime.state = restoredStateResponse.data || originalState;
      persistPiRpcState(runtime, runtime.state);
      restored = String(runtime.state?.sessionId || '') === String(sourceRuntimeId);
    } catch (error) {
      plog('WARN', 'pi_rpc_fork_restore_failed', {
        sessionId: session.id.slice(0, 8),
        error: error.message,
      });
    }
    if (!restored) disposePiRpcRuntime(session.id, 'fork_restore_failed');
  }

  if (forkOperationError) {
    cleanupPiForkSessionFile(session, forkSessionFile || forkState?.sessionFile, originalFile);
    throw forkOperationError;
  }

  let forkedId = null;
  let forkSaved = false;
  try {
    if (!forkState) throw new Error('Pi RPC 未完成 Fork。');
    const parsedFork = entryId && forkSessionFile ? parsePiSessionFile(forkSessionFile) : null;
    if (entryId && !parsedFork) throw new Error('无法解析 Pi Fork 后的会话文件。');
    const now = new Date().toISOString();
    forkedId = crypto.randomUUID();
    const runtimeContexts = cloneJson(session.runtimeContexts || { claude: {}, codex: {}, pi: {} });
    runtimeContexts.pi = {};
    const forked = normalizeSession({
      ...cloneJson(session),
      id: forkedId,
      title: `${session.title || 'Pi 会话'}（分支）`.slice(0, 100),
      created: now,
      updated: now,
      hasUnread: false,
      messages: parsedFork ? parsedFork.messages : cloneJson(session.messages || []),
      claudeSessionId: null,
      codexThreadId: null,
      piSessionId: null,
      runtimeContexts,
      importedFrom: 'pi-fork',
      importedPiSourcePath: null,
      totalCost: parsedFork ? parsedFork.totalCost : (session.totalCost || 0),
      totalUsage: parsedFork ? parsedFork.totalUsage : (session.totalUsage || null),
    });
    forked.importedPiSessionPath = copyPiSessionIntoWebStorage(
      forkSessionFile,
      forked.id,
      String(forkState.sessionId),
    );
    cleanupPiForkSessionFile(session, forkSessionFile, originalFile);
    setRuntimeSessionState(forked, {
      runtimeId: String(forkState.sessionId),
      runtimeFingerprint: spawnSpec.runtimeFingerprint || null,
      channelDescriptor: spawnSpec.channelDescriptor || null,
    }, {
      agent: 'pi',
      channelKey: spawnSpec.channelKey || null,
      channelDescriptor: spawnSpec.channelDescriptor || null,
    });
    saveSession(forked);
    forkSaved = true;
    wsSessionMap.set(ws, forked.id);
    wsSend(ws, {
      type: 'session_info',
      sessionId: forked.id,
      messages: forked.messages,
      title: forked.title,
      mode: forked.permissionMode || 'yolo',
      model: sessionModelLabel(forked),
      agent: 'pi',
      cwd: forked.cwd || null,
      projectId: forked.projectId || null,
      totalCost: forked.totalCost || 0,
      totalUsage: forked.totalUsage || null,
      updated: forked.updated,
      hasUnread: false,
      historyPending: false,
      isRunning: false,
      forked: true,
      draftText: selectedText,
      ...buildSessionRuntimeMeta(forked),
    });
    sendSessionList(ws);
    wsSend(ws, {
      type: 'system_message',
      sessionId: forked.id,
      message: entryId
        ? '已从选中的 Pi 历史消息前创建分支；原提示已放回输入框，可修改后发送。'
        : '已通过 Pi RPC Clone 当前活动分支，原会话保持不变。',
    });
  } catch (error) {
    if (forkedId && !forkSaved) deletePiLocalSession(forkedId);
    throw error;
  } finally {
    cleanupPiForkSessionFile(session, forkSessionFile || forkState?.sessionFile, originalFile);
  }
}

async function withPiForkLock(sessionId, operation) {
  if (piForkOperations.has(sessionId)) {
    throw new Error('当前 Pi 会话正在创建分支，请稍候。');
  }
  piForkOperations.add(sessionId);
  try {
    return await operation();
  } finally {
    piForkOperations.delete(sessionId);
  }
}

async function handlePiFork(ws, session, entryId = null) {
  if (!session?.id) throw new Error('当前没有可 Fork 的 Pi 会话。');
  return withPiForkLock(session.id, () => performPiFork(ws, session, entryId));
}

async function handlePiForkSelection(ws, msg) {
  const sessionId = sanitizeId(msg?.sessionId || '');
  const entryId = String(msg?.entryId || '').trim();
  if (!sessionId || wsSessionMap.get(ws) !== sessionId) {
    throw new Error('当前页面不属于该 Pi 会话。');
  }
  const session = loadSession(sessionId);
  if (!session || getSessionAgent(session) !== 'pi') throw new Error('未找到对应的 Pi 会话。');
  return withPiForkLock(session.id, async () => {
    if (activeProcesses.has(session.id)) throw new Error('当前 Pi 仍在运行，请结束本轮后再 Fork。');
    if (!entryId) throw new Error('请选择一条历史用户消息作为分支起点。');
    const available = await getPiForkOptions(session);
    if (!available.options.some((option) => option.entryId === entryId)) {
      throw new Error('所选 Pi 历史消息已失效，请重新执行 /fork。');
    }
    if (activeProcesses.has(session.id)) throw new Error('当前 Pi 仍在运行，请结束本轮后再 Fork。');
    return performPiFork(ws, session, entryId);
  });
}

async function getCodexPlatformRuntime(session) {
  if (!session || getSessionAgent(session) !== 'codex' || CODEX_TRANSPORT !== 'app-server') {
    throw new Error('当前会话不支持 Codex App Server 平台命令。');
  }
  const spawnSpec = buildCodexSpawnSpec(session, { transport: 'app-server' });
  if (spawnSpec?.error) throw new Error(spawnSpec.error);
  const runtime = await ensureCodexAppRuntime(session, spawnSpec);
  const threadId = spawnSpec.runtimeId || getRuntimeSessionId(session, {
    agent: 'codex',
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  }) || runtime.threadId || null;
  return { runtime, threadId };
}

async function handleCodexSkillsCommand(ws, session) {
  const { runtime } = await getCodexPlatformRuntime(session);
  const result = await runtime.client.request('skills/list', {
    cwds: session.cwd ? [session.cwd] : [],
    forceReload: true,
  }, { timeoutMs: 20_000 });
  const seen = new Set();
  const skills = [];
  for (const group of Array.isArray(result?.data) ? result.data : []) {
    for (const skill of Array.isArray(group?.skills) ? group.skills : []) {
      const name = String(skill?.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      skills.push(skill);
    }
  }
  const lines = [`Codex Skills（${skills.length}）`];
  if (skills.length === 0) {
    lines.push('当前目录没有可用 Skill。');
  } else {
    for (const skill of skills.slice(0, 100)) {
      const scope = skill.scope ? ` · ${skill.scope}` : '';
      const disabled = skill.enabled === false ? ' · 已停用' : '';
      const description = String(
        skill.interface?.shortDescription || skill.shortDescription || skill.description || '',
      ).trim().replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`- $${skill.name}${scope}${disabled}${description ? ` — ${description}` : ''}`);
    }
    if (skills.length > 100) lines.push(`另有 ${skills.length - 100} 个 Skill 未展开。`);
    lines.push('', '使用方式：在消息中输入 $SkillName。');
  }
  wsSend(ws, { type: 'system_message', sessionId: session.id, message: lines.join('\n') });
}

function codexMcpAuthLabel(status) {
  if (status === 'oAuth') return 'OAuth 已登录';
  if (status === 'bearerToken') return 'Token 已配置';
  if (status === 'notLoggedIn') return '未登录';
  return '无需登录';
}

async function handleCodexMcpCommand(ws, session) {
  const { runtime, threadId } = await getCodexPlatformRuntime(session);
  const servers = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await runtime.client.request('mcpServerStatus/list', {
      cursor,
      limit: 100,
      detail: 'toolsAndAuthOnly',
      threadId,
    }, { timeoutMs: 20_000 });
    servers.push(...(Array.isArray(result?.data) ? result.data : []));
    cursor = result?.nextCursor || null;
    if (!cursor) break;
  }
  const lines = [`Codex MCP 服务（${servers.length}）`];
  if (servers.length === 0) {
    lines.push('当前没有已配置的 MCP 服务。');
  } else {
    for (const server of servers) {
      const tools = Object.keys(server?.tools && typeof server.tools === 'object' ? server.tools : {});
      lines.push(`- ${server.name || '未命名'} · ${codexMcpAuthLabel(server.authStatus)} · ${tools.length} 个工具`);
      if (tools.length > 0) {
        lines.push(`  ${tools.slice(0, 12).join(', ')}${tools.length > 12 ? ` 等 ${tools.length} 个` : ''}`);
      }
    }
  }
  wsSend(ws, { type: 'system_message', sessionId: session.id, message: lines.join('\n') });
}

function formatCodexGoal(goal) {
  if (!goal) return '当前 Codex 线程没有活动目标。';
  const budget = Number.isFinite(goal.tokenBudget) ? ` / ${goal.tokenBudget}` : '';
  return [
    `目标：${goal.objective || '未命名'}`,
    `状态：${goal.status || 'active'}`,
    `Token：${Number(goal.tokensUsed) || 0}${budget}`,
    `耗时：${Number(goal.timeUsedSeconds) || 0} 秒`,
  ].join('\n');
}

async function handleCodexGoalCommand(ws, session, args) {
  const { runtime, threadId } = await getCodexPlatformRuntime(session);
  if (!threadId) {
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: '当前会话尚未建立 Codex 原生线程，请先发送一条普通消息后再设置目标。',
    });
    return;
  }
  const input = String(args || '').trim();
  const action = input.toLowerCase();
  if (!input) {
    const result = await runtime.client.request('thread/goal/get', { threadId }, { timeoutMs: 15_000 });
    wsSend(ws, { type: 'system_message', sessionId: session.id, message: formatCodexGoal(result?.goal) });
    return;
  }
  if (action === 'clear') {
    const result = await runtime.client.request('thread/goal/clear', { threadId }, { timeoutMs: 15_000 });
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: result?.cleared === false ? '当前 Codex 线程没有可清除的目标。' : 'Codex 线程目标已清除。',
    });
    return;
  }
  const statusByAction = {
    pause: 'paused',
    resume: 'active',
    complete: 'complete',
  };
  const params = statusByAction[action]
    ? { threadId, objective: null, status: statusByAction[action], tokenBudget: null }
    : { threadId, objective: input, status: 'active', tokenBudget: null };
  const result = await runtime.client.request('thread/goal/set', params, { timeoutMs: 15_000 });
  wsSend(ws, {
    type: 'system_message',
    sessionId: session.id,
    message: `Codex 线程目标已更新。\n${formatCodexGoal(result?.goal)}`,
  });
}

async function handleCodexPersonalityCommand(ws, session, args) {
  const input = String(args || '').trim().toLowerCase();
  if (!input) {
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: [
        `当前 Codex 沟通风格：${session.codexPersonality || '默认'}`,
        '可选：none、friendly、pragmatic；使用 default 清除覆盖。',
      ].join('\n'),
    });
    return;
  }
  const personality = input === 'default' ? null : input;
  if (personality !== null && !['none', 'friendly', 'pragmatic'].includes(personality)) {
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: '无效沟通风格。可选：default、none、friendly、pragmatic。',
    });
    return;
  }
  const { runtime, threadId } = await getCodexPlatformRuntime(session);
  if (!threadId) {
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: '当前会话尚未建立 Codex 原生线程，请先发送一条普通消息后再设置沟通风格。',
    });
    return;
  }
  await runtime.client.request('thread/settings/update', {
    threadId,
    personality,
  }, { timeoutMs: 15_000 });
  session.codexPersonality = personality;
  session.updated = new Date().toISOString();
  saveSession(session);
  wsSend(ws, {
    type: 'system_message',
    sessionId: session.id,
    message: personality
      ? `Codex 沟通风格已切换为：${personality}`
      : 'Codex 沟通风格已恢复为线程默认值。',
  });
}

function formatCodexRateLimitWindow(label, window) {
  if (!window || window.usedPercent == null || !Number.isFinite(Number(window.usedPercent))) return null;
  const reset = window.resetsAt != null && Number.isFinite(Number(window.resetsAt))
    ? ` · 重置 ${new Date(Number(window.resetsAt) * 1000).toLocaleString('zh-CN', { hour12: false })}`
    : '';
  const duration = window.windowDurationMins != null && Number.isFinite(Number(window.windowDurationMins))
    ? ` · ${Number(window.windowDurationMins)} 分钟窗口`
    : '';
  return `${label}: 已用 ${Number(window.usedPercent)}%${duration}${reset}`;
}

async function handleCodexUsageCommand(ws, session) {
  const { runtime } = await getCodexPlatformRuntime(session);
  const [usageResult, rateLimitResult] = await Promise.allSettled([
    runtime.client.request('account/usage/read', null, { timeoutMs: 15_000 }),
    runtime.client.request('account/rateLimits/read', null, { timeoutMs: 15_000 }),
  ]);
  if (usageResult.status === 'rejected' && rateLimitResult.status === 'rejected') {
    throw new Error(`账户用量不可用：${usageResult.reason?.message || rateLimitResult.reason?.message || '未知错误'}`);
  }
  const lines = ['Codex 账户用量'];
  if (usageResult.status === 'fulfilled') {
    const summary = usageResult.value?.summary || {};
    if (summary.lifetimeTokens != null && Number.isFinite(Number(summary.lifetimeTokens))) lines.push(`累计 Token: ${Number(summary.lifetimeTokens)}`);
    if (summary.peakDailyTokens != null && Number.isFinite(Number(summary.peakDailyTokens))) lines.push(`单日峰值: ${Number(summary.peakDailyTokens)}`);
    if (summary.currentStreakDays != null && Number.isFinite(Number(summary.currentStreakDays))) lines.push(`连续使用: ${Number(summary.currentStreakDays)} 天`);
  }
  if (rateLimitResult.status === 'fulfilled') {
    const snapshot = rateLimitResult.value?.rateLimits || null;
    const primary = formatCodexRateLimitWindow('主要限额', snapshot?.primary);
    const secondary = formatCodexRateLimitWindow('次要限额', snapshot?.secondary);
    if (primary) lines.push(primary);
    if (secondary) lines.push(secondary);
    if (snapshot?.credits?.unlimited === true) lines.push('Credits: 不限量');
    else if (snapshot?.credits?.balance != null) lines.push(`Credits: ${snapshot.credits.balance}`);
    const resetCredits = Number(rateLimitResult.value?.rateLimitResetCredits?.availableCount);
    if (Number.isFinite(resetCredits) && resetCredits > 0) lines.push(`可用限额重置次数: ${resetCredits}`);
  }
  if (lines.length === 1) lines.push('当前账户没有返回可显示的用量数据。');
  wsSend(ws, { type: 'system_message', sessionId: session.id, message: lines.join('\n') });
}

async function listCodexBackgroundTerminals(runtime, threadId) {
  const terminals = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await runtime.client.request('thread/backgroundTerminals/list', {
      threadId,
      cursor,
      limit: 100,
    }, { timeoutMs: 15_000 });
    terminals.push(...(Array.isArray(result?.data) ? result.data : []));
    cursor = result?.nextCursor || null;
    if (!cursor) break;
  }
  return terminals;
}

async function handleCodexBackgroundTerminalsCommand(ws, session, stopAll = false) {
  const { runtime, threadId } = await getCodexPlatformRuntime(session);
  if (!threadId) {
    wsSend(ws, {
      type: 'system_message',
      sessionId: session.id,
      message: '当前会话尚未建立 Codex 原生线程。',
    });
    return;
  }
  const terminals = await listCodexBackgroundTerminals(runtime, threadId);
  if (!stopAll) {
    const lines = [`Codex 后台终端（${terminals.length}）`];
    if (terminals.length === 0) lines.push('当前线程没有后台终端。');
    for (const terminal of terminals) {
      const rss = terminal.rssKb != null && Number.isFinite(Number(terminal.rssKb)) ? ` · ${Math.round(Number(terminal.rssKb) / 1024)} MB` : '';
      const cpu = terminal.cpuPercent != null && Number.isFinite(Number(terminal.cpuPercent)) ? ` · CPU ${Number(terminal.cpuPercent).toFixed(1)}%` : '';
      lines.push(`- ${terminal.command || terminal.processId}${cpu}${rss}`);
      if (terminal.cwd) lines.push(`  ${terminal.cwd}`);
    }
    wsSend(ws, { type: 'system_message', sessionId: session.id, message: lines.join('\n') });
    return;
  }
  if (terminals.length === 0) {
    wsSend(ws, { type: 'system_message', sessionId: session.id, message: '当前线程没有需要停止的后台终端。' });
    return;
  }
  const results = await Promise.allSettled(terminals.map((terminal) => runtime.client.request(
    'thread/backgroundTerminals/terminate',
    { threadId, processId: terminal.processId },
    { timeoutMs: 15_000 },
  )));
  const stopped = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results.length - stopped;
  wsSend(ws, {
    type: 'system_message',
    sessionId: session.id,
    message: `已停止 ${stopped} 个 Codex 后台终端${failed ? `，${failed} 个停止失败` : ''}。`,
  });
}

// === Slash Command Handler ===
// Slash *menu* is discovery-only (no hard-coded 6-command subset).
// Execution: pass almost everything to the CLI. Only a few platform controls stay
// local because they mutate Webcoding session state (model/mode) or orchestrate compact.
//
// Local handlers ACK with execution:'local' so the client does NOT startGenerating.
// They intentionally do NOT emit `done` (avoids racing a subsequent real CLI turn).
async function applyEffortSelection(ws, session, agent, rawValue) {
  if (!session) throw new Error('请先进入一个会话再切换推理强度。');
  const normalizedAgent = normalizeAgent(agent);
  const value = String(rawValue || '').trim().toLowerCase();
  const targetValue = value === 'default' ? null : value;
  let appliedValue = targetValue;
  if (!value) {
    wsSend(ws, await getEffortMenuPayload(session, normalizedAgent));
    return;
  }
  if (normalizedAgent === 'claude' && !CLAUDE_EFFORT_ENTRIES.some((entry) => entry.value === value)) {
    throw new Error(`Claude 不支持推理强度 ${value}。`);
  }
  if (normalizedAgent === 'pi' && !PI_THINKING_ENTRIES.some((entry) => entry.value === value)) {
    throw new Error(`Pi 不支持思考级别 ${value}。`);
  }
  if (normalizedAgent === 'codex' && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error('Codex 推理强度格式无效。请从列表中选择。');
  }

  const running = activeProcesses.has(session.id);
  if (normalizedAgent === 'pi') session.thinking = targetValue;
  else session.effort = targetValue;
  session.updated = new Date().toISOString();
  saveSession(session);

  if (!running && normalizedAgent === 'codex' && CODEX_TRANSPORT === 'app-server') {
    const spawnSpec = buildCodexSpawnSpec(session, { transport: 'app-server' });
    if (spawnSpec?.error) throw new Error(spawnSpec.error);
    const threadId = spawnSpec.runtimeId || getRuntimeSessionId(session, {
      agent: 'codex',
      channelKey: spawnSpec.channelKey || null,
      channelDescriptor: spawnSpec.channelDescriptor || null,
    });
    if (threadId) {
      const runtime = await ensureCodexAppRuntime(session, spawnSpec);
      await runtime.client.request('thread/settings/update', {
        threadId,
        effort: targetValue,
      }, { timeoutMs: 15_000 });
    }
  }

  if (!running && normalizedAgent === 'pi' && PI_TRANSPORT === 'rpc') {
    if (!targetValue) {
      // Pi has no "restore configured default" RPC command; restart the idle
      // runtime without --thinking so its own settings become authoritative.
      disposePiRpcRuntime(session.id, 'thinking_reset');
    } else {
      const spawnSpec = buildPiSpawnSpec(session, { transport: 'rpc' });
      if (spawnSpec?.error) throw new Error(spawnSpec.error);
      let runtime = piRpcRuntimes.get(session.id);
      if (!runtime?.client?.isAlive) runtime = await ensurePiRpcRuntime(session, spawnSpec);
      await runtime.client.request({ type: 'set_thinking_level', level: targetValue }, { timeoutMs: 15_000 });
      const state = (await runtime.client.request({ type: 'get_state' }, { timeoutMs: 15_000 })).data;
      appliedValue = String(state?.thinkingLevel || targetValue);
      session.thinking = appliedValue;
      session.updated = new Date().toISOString();
      saveSession(session);
      const appliedSpawnSpec = buildPiSpawnSpec(session, { transport: 'rpc' });
      runtime.spawnSpec = appliedSpawnSpec?.error ? spawnSpec : appliedSpawnSpec;
      runtime.key = piRpcRuntimeKey(runtime.spawnSpec);
      persistPiRpcState(runtime, state);
    }
  }

  const label = normalizedAgent === 'pi' ? 'Pi 思考级别' : `${agentDisplayName(normalizedAgent)} 推理强度`;
  const adjustment = targetValue && appliedValue && appliedValue !== targetValue
    ? `（当前模型实际使用 ${appliedValue}）`
    : '';
  wsSend(ws, {
    type: 'system_message',
    sessionId: session.id,
    message: `${label}已切换为：${targetValue || '默认'}${adjustment}${running ? '（当前轮次不变，下一轮生效）' : ''}`,
  });
}

function handleSlashCommand(ws, text, sessionId, fallbackAgent, clientMessageIdRaw = null, streamingBehavior = null) {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;
  const agent = session ? getSessionAgent(session) : normalizeAgent(fallbackAgent);
  const clientMessageId = normalizeClientMessageId(clientMessageIdRaw);
  const targetSessionId = session?.id || sessionId || null;
  const label = agentDisplayName(agent);

  function ackLocal() {
    // Idempotent replay of a completed local slash.
    if (!clientMessageId) return false;
    if (targetSessionId && wasClientMessageAccepted(targetSessionId, clientMessageId)) {
      sendMessageAccepted(ws, targetSessionId, clientMessageId, { execution: 'local' });
      return true;
    }
    return false;
  }

  function markLocalAccepted() {
    if (!clientMessageId) return;
    if (targetSessionId) rememberAcceptedClientMessage(targetSessionId, clientMessageId);
    sendMessageAccepted(ws, targetSessionId, clientMessageId, { execution: 'local' });
  }

  // --- Platform controls (Webcoding session state) ---
  if (cmd === '/model') {
    if (ackLocal()) return;
    markLocalAccepted();
    const modelInput = parts.slice(1).join(' ').trim();
    if (agent === 'codex') {
      if (!modelInput) {
        getCodexModelMenuPayload(session).then((payload) => {
          wsSend(ws, payload);
        }).catch((error) => {
          plog('WARN', 'codex_model_menu_failed', { error: error.message });
          wsSend(ws, {
            type: 'model_list',
            agent: 'codex',
            entries: [{
              value: 'default',
              label: '默认模型（Codex）',
              desc: '使用当前 Codex 默认模型',
            }],
            current: session?.model || 'default',
            currentFull: session?.model || '',
            source: null,
          });
        });
      } else {
        const normalizedInput = modelInput.toLowerCase();
        if (session) {
          session.model = normalizedInput === 'default' ? null : modelInput;
          session.updated = new Date().toISOString();
          saveSession(session);
        }
        wsSend(ws, {
          type: 'model_changed',
          model: normalizedInput === 'default' ? '' : modelInput,
          ...(session ? buildSessionRuntimeMeta(session) : {}),
        });
        wsSend(ws, {
          type: 'system_message',
          sessionId: targetSessionId,
          message: normalizedInput === 'default'
            ? 'Codex 模型已切换为: 默认模型（Codex，跟随当前配置）'
            : `Codex 模型已切换为: ${modelInput}`,
        });
      }
      return;
    }
    if (agent === 'pi') {
      if (!modelInput) {
        getPiModelMenuPayload(session).then((payload) => {
          wsSend(ws, payload);
        }).catch((error) => {
          plog('WARN', 'pi_model_menu_failed', { error: error.message });
          wsSend(ws, {
            type: 'model_list',
            agent: 'pi',
            entries: piModelMenuEntries([]),
            current: session?.model || 'default',
            currentFull: session?.model || '',
            source: PI_TRANSPORT === 'rpc' ? null : 'pi-headless',
          });
        });
      } else {
        const normalizedInput = modelInput.toLowerCase();
        if (session) {
          session.model = normalizedInput === 'default' ? null : modelInput;
          session.updated = new Date().toISOString();
          saveSession(session);
        }
        wsSend(ws, {
          type: 'model_changed',
          model: normalizedInput === 'default' ? '' : modelInput,
          ...(session ? buildSessionRuntimeMeta(session) : {}),
        });
        wsSend(ws, {
          type: 'system_message',
          sessionId: targetSessionId,
          message: normalizedInput === 'default'
            ? 'Pi 模型已切换为: 默认模型（跟随 ~/.pi/agent 配置）'
            : `Pi 模型已切换为: ${modelInput}`,
        });
      }
      return;
    }
    if (!modelInput) {
      const currentAlias = session?.model ? modelShortName(session.model) || session.model : 'default';
      const currentFull = session?.model || '';
      wsSend(ws, {
        type: 'model_list',
        agent: 'claude',
        models: MODEL_MAP,
        entries: getClaudeModelMenuEntries(),
        current: currentAlias,
        currentFull,
        source: 'claude-cli',
      });
      return;
    }
    const resolved = resolveClaudeModelInput(modelInput);
    if (!resolved) {
      wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: '模型名称不能为空' });
      return;
    }
    const { resolvedModel, resolvedAlias } = resolved;
    if (!resolvedModel) {
      if (session) {
        session.model = null;
        session.updated = new Date().toISOString();
        saveSession(session);
      }
      wsSend(ws, {
        type: 'model_changed',
        model: '',
        ...(session ? buildSessionRuntimeMeta(session) : {}),
      });
      wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: '模型已切换为: 默认（使用 CLI 默认模型）' });
      return;
    }
    if (session) {
      session.model = resolvedModel;
      session.updated = new Date().toISOString();
      saveSession(session);
    }
    const displayName = getClaudeModelMenuLabel(resolvedModel) || getClaudeModelMenuLabel(resolvedAlias) || modelShortName(resolvedModel) || resolvedModel;
    wsSend(ws, {
      type: 'model_changed',
      model: resolvedAlias,
      ...(session ? buildSessionRuntimeMeta(session) : {}),
    });
    wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: `模型已切换为: ${displayName} (${resolvedModel})` });
    return;
  }

  if (cmd === '/effort' || (cmd === '/thinking' && agent === 'pi' && PI_TRANSPORT === 'rpc')) {
    if (ackLocal()) return;
    markLocalAccepted();
    applyEffortSelection(ws, session, agent, parts[1] || '').catch((error) => {
      wsSend(ws, {
        type: 'error',
        sessionId: targetSessionId,
        message: `${cmd} 执行失败：${error.message}`,
      });
    });
    return;
  }

  if (cmd === '/mode') {
    if (ackLocal()) return;
    markLocalAccepted();
    const modeInput = parts[1];
    const VALID_MODES = ['default', 'plan', 'yolo'];
    if (!modeInput) {
      const cur = session?.permissionMode || 'yolo';
      const lines = [
        `当前模式: ${formatPermissionModeHelp(agent, cur)}`,
        '',
        '可选:',
        ...VALID_MODES.map((m) => formatPermissionModeHelp(agent, m)),
        '',
        agent === 'codex' && CODEX_TRANSPORT === 'app-server'
          ? '说明: Codex 默认模式支持网页审批；运行中切换将在下一轮生效。'
          : agent === 'claude' && CLAUDE_TRANSPORT === 'stream-json'
            ? '说明: Claude 默认模式支持网页审批与用户问题；运行中切换将在下一轮生效。'
            : '说明: 模式映射为真实 CLI 参数；运行中切换将在下一轮生效。',
      ];
      wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: lines.join('\n') });
    } else if (VALID_MODES.includes(modeInput.toLowerCase())) {
      const mode = modeInput.toLowerCase();
      const running = !!(targetSessionId && activeProcesses.has(targetSessionId));
      if (session) {
        session.permissionMode = mode;
        // Do not clear runtime session id — mode only affects next spawn flags.
        session.updated = new Date().toISOString();
        saveSession(session);
      }
      const timing = running ? '（当前轮次仍按原模式运行，下一轮生效）' : '';
      wsSend(ws, {
        type: 'system_message',
        sessionId: targetSessionId,
        message: `权限模式已切换为:\n${formatPermissionModeHelp(agent, mode)}${timing ? `\n${timing}` : ''}`,
      });
      wsSend(ws, { type: 'mode_changed', mode, sessionId: targetSessionId, appliesNextTurn: running });
    } else {
      wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: `无效模式: ${modeInput}\n可选: default, plan, yolo` });
    }
    return;
  }

  if (cmd === '/web-help' || cmd === '/webhelp') {
    if (ackLocal()) return;
    markLocalAccepted();
    wsSend(ws, {
      type: 'system_message',
      sessionId: targetSessionId,
      message: formatSlashHelpMessage(agent),
    });
    return;
  }

  if (agent === 'codex' && CODEX_TRANSPORT === 'app-server' && CODEX_APP_PLATFORM_COMMANDS.has(cmd.slice(1))) {
    if (ackLocal()) return;
    markLocalAccepted();
    if (cmd === '/fork') {
      if (!session || activeProcesses.has(session.id)) {
        wsSend(ws, {
          type: 'system_message',
          sessionId: targetSessionId,
          message: activeProcesses.has(session?.id) ? '当前 Codex 仍在运行，请结束本轮后再 Fork。' : '当前没有可 Fork 的 Codex 会话。',
        });
        return;
      }
      handleCodexFork(ws, session).catch((error) => {
        wsSend(ws, { type: 'error', sessionId: targetSessionId, message: `Codex Fork 失败：${error.message}` });
      });
      return;
    }
    if (cmd === '/new') {
      handleNewSession(ws, {
        agent: 'codex',
        cwd: session?.cwd || null,
        mode: session?.permissionMode || 'yolo',
        projectId: session?.projectId || null,
      });
      return;
    }
    if (cmd === '/rename') {
      const nextTitle = parts.slice(1).join(' ').trim();
      if (!session || !nextTitle) {
        wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: '用法：/rename 新标题' });
      } else {
        handleRenameSession(ws, session.id, nextTitle);
      }
      return;
    }
    if (cmd === '/status') {
      const runtimeId = session ? getRuntimeSessionId(session) : null;
      const usage = session?.totalUsage || null;
      wsSend(ws, {
        type: 'system_message',
        sessionId: targetSessionId,
        message: [
          'Codex App Server 状态',
          `模型: ${session?.model || '默认'}`,
          `权限: ${formatPermissionModeHelp('codex', session?.permissionMode || 'yolo')}`,
          `目录: ${session?.cwd || '未设置'}`,
          `线程: ${runtimeId || '尚未建立'}`,
          usage
            ? `累计 Token: 输入 ${Number(usage.inputTokens) || 0} · 缓存 ${Number(usage.cachedInputTokens) || 0} · 输出 ${Number(usage.outputTokens) || 0}`
            : '累计 Token: 暂无统计',
        ].join('\n'),
      });
      return;
    }
    if (cmd === '/permissions') {
      wsSend(ws, {
        type: 'system_message',
        sessionId: targetSessionId,
        message: [
          `当前权限模式:\n${formatPermissionModeHelp('codex', session?.permissionMode || 'yolo')}`,
          '',
          '使用 /mode default 启用网页审批，/mode plan 切换只读规划，/mode yolo 跳过审批与沙箱。',
        ].join('\n'),
      });
      return;
    }
    let platformTask = null;
    if (cmd === '/skills') platformTask = handleCodexSkillsCommand(ws, session);
    else if (cmd === '/mcp') platformTask = handleCodexMcpCommand(ws, session);
    else if (cmd === '/personality') platformTask = handleCodexPersonalityCommand(ws, session, parts.slice(1).join(' '));
    else if (cmd === '/usage') platformTask = handleCodexUsageCommand(ws, session);
    else if (cmd === '/ps') platformTask = handleCodexBackgroundTerminalsCommand(ws, session, false);
    else if (cmd === '/stop') platformTask = handleCodexBackgroundTerminalsCommand(ws, session, true);
    else if (cmd === '/goal') platformTask = handleCodexGoalCommand(ws, session, parts.slice(1).join(' '));
    if (platformTask) {
      platformTask.catch((error) => {
        wsSend(ws, {
          type: 'error',
          sessionId: targetSessionId,
          message: `${cmd} 执行失败：${error.message}`,
        });
      });
      return;
    }
  }

  if (agent === 'pi' && PI_TRANSPORT === 'rpc' && PI_RPC_PLATFORM_COMMANDS.has(cmd.slice(1))) {
    if (ackLocal()) return;
    markLocalAccepted();
    if (!session || activeProcesses.has(session.id)) {
      wsSend(ws, {
        type: 'system_message',
        sessionId: targetSessionId,
        message: activeProcesses.has(session?.id) ? '当前 Pi 仍在运行，请结束本轮后再 Fork。' : '当前没有可 Fork 的 Pi 会话。',
      });
      return;
    }
    const entryId = cmd === '/fork' ? (parts[1] || null) : null;
    const operation = cmd === '/fork' && !entryId
      ? sendPiForkOptions(ws, session)
      : handlePiFork(ws, session, entryId);
    operation.catch((error) => {
      wsSend(ws, { type: 'error', sessionId: targetSessionId, message: `Pi Fork 失败：${error.message}` });
    });
    return;
  }

  if (cmd === '/compact') {
    if (ackLocal()) return;
    if (!targetSessionId || !session) {
      markLocalAccepted();
      wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: '当前没有可压缩的会话。请先进入一个已进行过对话的会话后再执行 /compact。' });
      return;
    }
    if (activeProcesses.has(targetSessionId)) {
      markLocalAccepted();
      wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: '当前会话正在处理中，请先等待完成或点击停止，再执行 /compact。' });
      return;
    }
    const runtimeId = getRuntimeSessionId(session);
    if (!runtimeId) {
      markLocalAccepted();
      wsSend(ws, {
        type: 'system_message',
        sessionId: targetSessionId,
        message: agent === 'codex'
          ? '当前会话尚未建立 Codex 上下文，暂时无需压缩。'
          : '当前会话尚未建立 Claude 上下文，暂时无需压缩。',
      });
      return;
    }
    // Compact starts a real CLI turn.
    if (clientMessageId) {
      if (targetSessionId) rememberAcceptedClientMessage(targetSessionId, clientMessageId);
      sendMessageAccepted(ws, targetSessionId, clientMessageId, { execution: 'turn' });
    }
    wsSend(ws, { type: 'system_message', sessionId: targetSessionId, message: compactStartMessage(agent) });
    pendingSlashCommands.set(session.id, { kind: 'compact' });
    handleMessage(ws, {
      text: '/compact',
      sessionId: session.id,
      mode: session.permissionMode || 'yolo',
      clientMessageId: null, // already accepted above
    }, { hideInHistory: true });
    return;
  }

  // --- Blocked commands: refuse before spawn (do not fake availability) ---
  // Classify directly so interception works even before discovery cache is warm.
  // Prefer discovered source (skills/prompts/plugins) so overlay status is accurate.
  const cmdName = normalizeSlashCommandName(cmd);
  const slashMeta = getSlashCommandMeta(agent, cmd);
  const classified = classifySlashCommand(agent, cmdName, slashMeta?.source || (
    cmdName.startsWith('prompts:') ? 'codex-prompts' : ''
  ));
  if (
    classified.availability === 'tui-only'
    || classified.availability === 'runtime-unavailable'
    || classified.execution === 'blocked'
  ) {
    if (ackLocal()) return;
    markLocalAccepted();
    const reason = classified.reason || slashMeta?.reason || '';
    const headline = classified.availability === 'runtime-unavailable'
      ? `${cmd} 当前在 managed Codex runtime 中不可用（overlay 未就绪）。`
      : `${cmd} 仅在 ${label} 交互式 TUI 中可用，当前 Web 接入没有等价界面。`;
    wsSend(ws, {
      type: 'system_message',
      sessionId: targetSessionId,
      message: [
        headline,
        reason,
        classified.availability === 'runtime-unavailable'
          ? '请切换到 Codex 本地模式，或检查 config/codex-runtime-home 下 skills/prompts 挂载。'
          : '请在终端原生 CLI 中使用该命令，或改用网页侧等价能力（如 /mode、/model、侧栏新建会话）。',
      ].filter(Boolean).join('\n'),
    });
    return;
  }

  if (agent === 'codex' && CODEX_TRANSPORT === 'app-server' && slashMeta?.source === 'codex-skills') {
    const skillText = `$${cmdName}${parts.length > 1 ? ` ${parts.slice(1).join(' ')}` : ''}`;
    handleMessage(ws, {
      text: skillText,
      sessionId: targetSessionId,
      mode: session?.permissionMode || 'yolo',
      agent,
      clientMessageId,
      streamingBehavior,
    }, { hideInHistory: false });
    wsSend(ws, {
      type: 'system_message',
      sessionId: targetSessionId,
      message: `正在以 Codex 原生 Skill 语法调用 $${cmdName}…`,
    });
    return;
  }

  // --- Everything else: CLI passthrough (for example /clear, /help and custom prompts) ---
  handleMessage(ws, {
    text,
    sessionId: targetSessionId,
    mode: session?.permissionMode || 'yolo',
    agent,
    clientMessageId,
    streamingBehavior,
  }, { hideInHistory: false });
  const resolvedSessionId = wsSessionMap.get(ws) || targetSessionId || null;
  wsSend(ws, {
    type: 'system_message',
    sessionId: resolvedSessionId,
    message: `正在将 ${cmd} 交给 ${label} CLI 执行…`,
  });
}

// === Session Handlers ===
function handleNewSession(ws, msg) {
  const cwd = (msg && msg.cwd) ? String(msg.cwd) : null;
  const agent = normalizeAgent(msg?.agent);
  const requestedMode = ['default', 'plan', 'yolo'].includes(msg?.mode) ? msg.mode : 'yolo';
  let projectId = msg?.projectId || null;
  let resolvedCwd = cwd;
  if (!resolvedCwd && projectId) {
    const proj = loadProjectsConfig().projects.find(p => p.id === projectId);
    if (proj) resolvedCwd = proj.path;
  }
  if (!resolvedCwd) {
    resolvedCwd = agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null;
  }
  if (resolvedCwd) {
    resolvedCwd = normalizeProjectPathKey(resolvedCwd);
  }
  let projectsChanged = false;
  if (!projectId && cwd && resolvedCwd) {
    const ensured = ensureProjectForPath(resolvedCwd);
    if (ensured.project?.id) {
      projectId = ensured.project.id;
      projectsChanged = !!ensured.created;
    }
  }
  const id = crypto.randomUUID();
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    codexRuntimeFingerprint: null,
    piSessionId: null,
    piRuntimeFingerprint: null,
    runtimeContexts: { claude: {}, codex: {}, pi: {} },
    model: null,
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [],
    cwd: resolvedCwd,
    projectId,
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  if (projectsChanged) {
    wsSend(ws, { type: 'projects_config', projects: loadProjectsConfig().projects });
  }
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: [],
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent,
    cwd: session.cwd,
    projectId: session.projectId,
    totalCost: 0,
    totalUsage: session.totalUsage,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    ...buildSessionRuntimeMeta(session),
  });
  sendSessionList(ws);
}

function handleLoadSession(ws, sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    return wsSend(ws, { type: 'error', message: 'Session not found' });
  }
  const preferredClaudeRuntimeId = getSessionAgent(session) === 'claude'
    ? getPreferredRuntimeSessionId(session, 'claude')
    : null;
  if (getSessionAgent(session) === 'claude' && !session.cwd && preferredClaudeRuntimeId) {
    const localMeta = resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId);
    if (localMeta?.cwd) {
      session.cwd = localMeta.cwd;
      if (!session.importedFrom && localMeta.projectDir) session.importedFrom = localMeta.projectDir;
      saveSession(session);
    }
  }
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) {
      session.projectId = ensured.project.id;
      saveSession(session);
      if (ensured.created) {
        wsSend(ws, { type: 'projects_config', projects: loadProjectsConfig().projects });
      }
    }
  }
  const { recentMessages, olderChunks } = splitHistoryMessages(session.messages);
  const effectiveCwd = session.cwd || activeProcesses.get(sessionId)?.cwd || null;

  // Detach ws from any previous session's process
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }

  wsSessionMap.set(ws, sessionId);

  // Read and clear unread flag
  const hadUnread = !!session.hasUnread;
  if (session.hasUnread) {
    session.hasUnread = false;
    saveSession(session);
  }

  wsSend(ws, {
    type: 'session_info',
    sessionId: session.id,
    messages: recentMessages,
    title: session.title,
    mode: session.permissionMode || 'yolo',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    hasUnread: hadUnread,
    cwd: effectiveCwd,
    projectId: session.projectId || null,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    historyTotal: session.messages.length,
    historyBuffered: recentMessages.length,
    historyPending: olderChunks.length > 0,
    updated: session.updated,
    isRunning: activeProcesses.has(sessionId),
    ...buildSessionRuntimeMeta(session),
  });

  if (olderChunks.length > 0) {
    sendHistoryChunks(ws, session.id, olderChunks);
  }

  // Resume streaming if process is still active
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    entry.ws = ws;
    entry.wsDisconnectTime = null; // clear disconnect marker
    plog('INFO', 'ws_resume_attach', {
      sessionId: sessionId.slice(0, 8),
      pid: entry.pid,
      responseLen: (entry.fullText || '').length,
    });
    wsSend(ws, {
      type: 'resume_generating',
      sessionId,
      text: entry.fullText || '',
      toolCalls: entry.toolCalls || [],
      segments: entry.segments || [],
      permissionMode: entry.permissionMode || session?.permissionMode || 'yolo',
    });
    if (entry.transport === 'pi-rpc') {
      resendPiRpcInteractiveRequests(entry);
      sendPiRpcQueueState(entry);
    } else if (entry.transport === 'codex-app-server') {
      resendCodexAppInteractiveRequests(entry);
    } else if (entry.transport === 'claude-stream-json') {
      resendClaudeStreamInteractiveRequests(entry);
    }
  } else if (getSessionAgent(session) === 'pi') {
    const runtime = piRpcRuntimes.get(sessionId);
    if (runtime?.client?.isAlive) sendPiRpcExtensionUiState(ws, runtime);
  }
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function deleteClaudeLocalSession(claudeSessionId) {
  const safeId = sanitizeId(claudeSessionId);
  if (!safeId) return;
  const projectsDir = CLAUDE_PROJECTS_DIR;
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const target = path.join(projectsDir, proj, `${safeId}.jsonl`);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  } catch {}
}

async function deleteCodexLocalSession(threadId, importedRolloutPath = null) {
  if (!threadId || !/^[a-zA-Z0-9\-]+$/.test(String(threadId))) {
    return { removedFiles: 0, removedDbRows: false };
  }

  const rolloutPaths = new Set();
  if (importedRolloutPath) rolloutPaths.add(path.resolve(importedRolloutPath));
  try {
    for (const filePath of getCodexRolloutFiles()) {
      if (filePath.includes(threadId)) rolloutPaths.add(path.resolve(filePath));
    }
  } catch {}

  let removedFiles = 0;
  for (const filePath of rolloutPaths) {
    try {
      if ((isPathInside(filePath, CODEX_SESSIONS_DIR) || isPathInside(filePath, CODEX_RUNTIME_SESSIONS_DIR)) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedFiles++;
      }
    } catch {}
  }

  let removedDbRows = false;
  try {
    const sqliteAvailable = await execFileQuiet('sqlite3', ['-version']);
    if (sqliteAvailable.ok) {
      const quotedThreadId = sqlQuote(threadId);
      for (const stateDbPath of [CODEX_STATE_DB_PATH, CODEX_RUNTIME_STATE_DB_PATH]) {
        if (!fs.existsSync(stateDbPath)) continue;
        const tablesResult = await execFileQuiet('sqlite3', [
          stateDbPath,
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('thread_dynamic_tools','stage1_outputs','logs','threads');",
        ]);
        if (!tablesResult.ok) continue;
        const tables = new Set(tablesResult.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
        const statements = ['PRAGMA foreign_keys = ON;'];
        if (tables.has('thread_dynamic_tools')) statements.push(`DELETE FROM thread_dynamic_tools WHERE thread_id = ${quotedThreadId};`);
        if (tables.has('stage1_outputs')) statements.push(`DELETE FROM stage1_outputs WHERE thread_id = ${quotedThreadId};`);
        if (tables.has('logs')) statements.push(`DELETE FROM logs WHERE thread_id = ${quotedThreadId};`);
        if (tables.has('threads')) statements.push(`DELETE FROM threads WHERE id = ${quotedThreadId};`);
        if (statements.length === 1) continue;
        const stateResult = await execFileQuiet('sqlite3', [stateDbPath, statements.join(' ')]);
        if (stateResult.ok && tables.has('threads')) removedDbRows = true;
      }

      for (const logDbPath of [CODEX_LOG_DB_PATH, CODEX_RUNTIME_LOG_DB_PATH]) {
        if (!fs.existsSync(logDbPath)) continue;
        await execFileQuiet('sqlite3', [logDbPath, `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`]);
      }
    }
  } catch {}

  return { removedFiles, removedDbRows };
}

function handleDeleteSession(ws, sessionId) {
  sessionId = sanitizeId(sessionId || '');
  if (!sessionId) {
    wsSend(ws, { type: 'error', message: 'Invalid session id' });
    return;
  }
  if (piForkOperations.has(sessionId) || codexForkOperations.has(sessionId)) {
    wsSend(ws, { type: 'error', sessionId, message: '当前会话正在创建分支，请稍候再删除。' });
    return;
  }
  pendingSlashCommands.delete(sessionId);
  pendingCompactRetries.delete(sessionId);
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    if (entry.tailer) entry.tailer.stop();
    removeActiveProcess(sessionId);
    if (entry.transport === 'pi-rpc') disposePiRpcRuntime(sessionId, 'session_deleted');
    else if (entry.transport === 'codex-app-server') disposeCodexAppRuntime(sessionId, 'session_deleted');
    else if (entry.transport === 'claude-stream-json') disposeClaudeStreamRuntime(sessionId, 'session_deleted');
    else try { killProcess(entry.pid); } catch {}
    if (entry.ws) wsSend(entry.ws, { type: 'done', sessionId });
  }
  disposePiRpcRuntime(sessionId, 'session_deleted');
  disposeCodexAppRuntime(sessionId, 'session_deleted');
  disposeClaudeStreamRuntime(sessionId, 'session_deleted');
  cleanRunDir(sessionId);
  try {
    const p = sessionPath(sessionId);
    const session = loadSession(sessionId);
    const sessionAgent = getSessionAgent(session);
    for (const attachmentId of collectSessionAttachmentIds(session)) {
      removeAttachmentById(attachmentId);
    }
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      invalidateImportedSessionIdsCache();
    }
    invalidateSessionListCache();
    if (sessionAgent === 'codex') {
      const codexThreadIds = getAllRuntimeSessionIds(session, 'codex');
      (async () => {
        const results = [];
        for (const threadId of codexThreadIds) {
          const result = await deleteCodexLocalSession(threadId, session?.importedRolloutPath || null);
          results.push({ threadId, result });
        }
        return results;
      })().then((results) => {
        for (const item of results) {
          plog('INFO', 'codex_local_session_deleted', {
            sessionId: sessionId.slice(0, 8),
            threadId: item.threadId,
            removedFiles: item.result.removedFiles,
            removedDbRows: item.result.removedDbRows,
          });
        }
      }).catch((error) => {
        plog('WARN', 'codex_local_session_delete_failed', {
          sessionId: sessionId.slice(0, 8),
          threadIds: codexThreadIds,
          error: error?.message || String(error),
        });
      });
    } else if (sessionAgent === 'pi') {
      deletePiLocalSession(sessionId);
    } else {
      for (const runtimeId of getAllRuntimeSessionIds(session, 'claude')) {
        deleteClaudeLocalSession(runtimeId);
      }
    }
    sendSessionList(ws);
  } catch {
    wsSend(ws, { type: 'error', message: 'Failed to delete session' });
  }
}

function handleRenameSession(ws, sessionId, title) {
  const safeSessionId = sanitizeId(sessionId);
  if (!safeSessionId || !title) return;
  const session = loadSession(safeSessionId);
  if (session) {
    session.title = String(title).slice(0, 100);
    session.updated = new Date().toISOString();
    saveSession(session);
    sendSessionList(ws);
    wsSend(ws, { type: 'session_renamed', sessionId: safeSessionId, title: session.title });
    if (getSessionAgent(session) === 'codex' && CODEX_TRANSPORT === 'app-server') {
      syncCodexThreadName(session, session.title).catch((error) => {
        plog('WARN', 'codex_thread_rename_failed', {
          sessionId: safeSessionId.slice(0, 8),
          error: error.message,
        });
        wsSend(ws, {
          type: 'system_message',
          sessionId: safeSessionId,
          message: `网页标题已更新，但 Codex 原生线程名称同步失败：${error.message}`,
        });
      });
    }
  }
}

async function syncCodexThreadName(session, title) {
  const spawnSpec = buildCodexSpawnSpec(session, { transport: 'app-server' });
  if (spawnSpec?.error) throw new Error(spawnSpec.error);
  const threadId = spawnSpec.runtimeId || getRuntimeSessionId(session, {
    agent: 'codex',
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  });
  if (!threadId) return false;
  const runtime = await ensureCodexAppRuntime(session, spawnSpec);
  await runtime.client.request('thread/name/set', {
    threadId,
    name: String(title).slice(0, 100),
  }, { timeoutMs: 15_000 });
  plog('INFO', 'codex_thread_renamed', {
    sessionId: session.id.slice(0, 8),
    threadId,
  });
  return true;
}

function handleSetMode(ws, sessionId, mode) {
  const VALID_MODES = ['default', 'plan', 'yolo'];
  if (!mode || !VALID_MODES.includes(mode)) return;
  const safeSessionId = sessionId ? sanitizeId(sessionId) : null;
  const running = !!(safeSessionId && activeProcesses.has(safeSessionId));
  if (safeSessionId) {
    const session = loadSession(safeSessionId);
    if (session) {
      session.permissionMode = mode;
      // Mode only affects next spawn flags; keep runtime id for resume continuity.
      session.updated = new Date().toISOString();
      saveSession(session);
      if (running) {
        wsSend(ws, {
          type: 'system_message',
          sessionId: safeSessionId,
          message: `权限模式将切换为 ${PERMISSION_MODE_META[mode]?.label || mode}（当前轮次仍按原模式运行，下一轮生效）\n${formatPermissionModeHelp(getSessionAgent(session), mode)}`,
        });
      }
    }
  }
  wsSend(ws, { type: 'mode_changed', mode, sessionId: safeSessionId, appliesNextTurn: running });
}

function handleDisconnect(ws, wsId) {
  const affectedSessions = [];
  for (const [sid, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
      affectedSessions.push({ sessionId: sid.slice(0, 8), pid: entry.pid });
    }
  }
  wsSessionMap.delete(ws);
  plog('INFO', 'ws_disconnect', { wsId, activeProcessesAffected: affectedSessions });
}

function handleDetachView(ws) {
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
    }
  }
  wsSessionMap.delete(ws);
}

function forceLogoutClient(ws, message) {
  if (!ws) return;
  handleDetachView(ws);
  ws.isAuthenticated = false;
  ws.authToken = null;
  if (ws.readyState === 1) {
    wsSend(ws, { type: 'force_logout', message: message || '登录状态已失效，请重新登录。' });
  }
}

function handleAbort(ws) {
  const sessionId = wsSessionMap.get(ws);
  if (!sessionId) return;
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  entry.abortRequested = true;
  plog('INFO', 'user_abort', { sessionId: sessionId.slice(0, 8), pid: entry.pid });
  wsSend(ws, {
    type: 'system_message',
    sessionId,
    message: '正在停止当前任务…',
  });
  if (entry.transport === 'pi-rpc') {
    const runtime = entry.rpcRuntime || piRpcRuntimes.get(sessionId);
    if (!runtime?.client?.isAlive) return;
    const discardedQueueCount = (entry.rpcQueuedMessages || []).filter((record) => !record.started).length;
    entry.rpcQueuedMessages = [];
    runtime.queueState = { steering: [], followUp: [] };
    runtime.dequeuedQueueItems = [];
    sendPiRpcQueueState(entry);
    if (discardedQueueCount > 0) {
      wsSend(ws, {
        type: 'system_message',
        sessionId,
        message: `已丢弃 ${discardedQueueCount} 条尚未执行的 Pi 排队消息。`,
      });
    }
    runtime.client.request({ type: 'abort' }, { timeoutMs: 10_000 }).then(async () => {
      if (discardedQueueCount > 0) {
        if (activeProcesses.get(sessionId) === entry) handleProcessComplete(sessionId, 0, null);
        disposePiRpcRuntime(sessionId, 'abort_discard_queue');
        return;
      }
      if (activeProcesses.get(sessionId) !== entry) return;
      try {
        const state = await runtime.client.request({ type: 'get_state' }, { timeoutMs: 5000 });
        persistPiRpcState(runtime, state.data);
        if (!state.data?.isStreaming && activeProcesses.get(sessionId) === entry) {
          handleProcessComplete(sessionId, 0, null);
        }
      } catch {}
    }).catch(() => {
      if (activeProcesses.get(sessionId) === entry) {
        disposePiRpcRuntime(sessionId, 'abort_failed');
      }
    });
    return;
  }
  if (entry.transport === 'codex-app-server') {
    const runtime = entry.appRuntime || codexAppRuntimes.get(sessionId);
    if (!runtime?.client?.isAlive || !runtime.threadId || !runtime.turnId) {
      handleProcessComplete(sessionId, 0, null);
      return;
    }
    runtime.client.request('turn/interrupt', {
      threadId: runtime.threadId,
      turnId: runtime.turnId,
    }, { timeoutMs: 10_000 }).catch((error) => {
      if (activeProcesses.get(sessionId) !== entry) return;
      entry.lastError = `Codex 中断失败：${error.message}`;
      disposeCodexAppRuntime(sessionId, 'interrupt_failed');
    });
    return;
  }
  if (entry.transport === 'claude-stream-json') {
    disposeClaudeStreamRuntime(sessionId, 'user_abort');
    return;
  }
  killProcess(entry.pid);
  setTimeout(() => {
    const activeEntry = activeProcesses.get(sessionId);
    if (activeEntry && activeEntry.pid === entry.pid) {
      activeEntry.abortRequested = true;
      killProcess(entry.pid, true);
    }
  }, 3000);
  // handleProcessComplete will be triggered by the PID monitor / process close
}

function createRuntimeEntry(session, ws, spawnSpec, resolvedAttachments, pid, transport = 'headless') {
  const entryAgent = getSessionAgent(session);
  const sharedRuntimeIdOpts = {
    agent: entryAgent,
    channelKey: spawnSpec.channelKey || null,
    channelDescriptor: spawnSpec.channelDescriptor || null,
  };
  const existingRuntimeId = getRuntimeSessionId(session, sharedRuntimeIdOpts) || null;
  return {
    pid: pid || null,
    ws,
    agent: entryAgent,
    transport,
    cwd: spawnSpec.cwd,
    // Snapshot mode for this turn — session.permissionMode may change mid-run for next turn.
    permissionMode: spawnSpec.mode || session.permissionMode || 'yolo',
    // Concrete model used for this turn (for message avatar label).
    effectiveModel: spawnSpec.effectiveModel || resolveEffectiveModelId(session) || null,
    resolvedModel: null,
    abortRequested: false,
    claudeRuntimeFingerprint: entryAgent === 'claude' ? (spawnSpec.runtimeFingerprint || null) : null,
    codexRuntimeFingerprint: entryAgent === 'codex' ? (spawnSpec.runtimeFingerprint || null) : null,
    piRuntimeFingerprint: entryAgent === 'pi' ? (spawnSpec.runtimeFingerprint || null) : null,
    runtimeChannelKey: spawnSpec.channelKey || null,
    runtimeChannelDescriptor: spawnSpec.channelDescriptor || null,
    claudeRuntimeSessionId: entryAgent === 'claude' ? existingRuntimeId : null,
    persistedClaudeSessionId: entryAgent === 'claude' ? existingRuntimeId : null,
    piRuntimeSessionId: entryAgent === 'pi' ? existingRuntimeId : null,
    persistedPiSessionId: entryAgent === 'pi' ? existingRuntimeId : null,
    claudePendingCostDelta: 0,
    claudeSessionTotalCost: session.totalCost || 0,
    piPendingCostDelta: 0,
    piSessionTotalCost: session.totalCost || 0,
    fullText: '',
    attachments: resolvedAttachments,
    toolCalls: [],
    segments: [],
    lastCost: null,
    lastUsage: null,
    lastError: null,
    errorSent: false,
    pendingProcessComplete: false,
    pendingExitCode: null,
    pendingSignal: null,
    tailer: null,
    rpcInitialUserPending: transport === 'pi-rpc',
    rpcQueuedMessages: [],
    rpcQueuedRequests: new Map(),
    rpcPersistedAssistantMessages: 0,
  };
}

function claudeStreamRuntimeKey(spawnSpec) {
  const stableArgs = [];
  for (let index = 0; index < (spawnSpec.args || []).length; index += 1) {
    if (spawnSpec.args[index] === '--resume') {
      index += 1;
      continue;
    }
    stableArgs.push(spawnSpec.args[index]);
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    command: spawnSpec.command,
    args: stableArgs,
    cwd: spawnSpec.cwd,
    mode: spawnSpec.mode,
    model: spawnSpec.effectiveModel || null,
    runtimeFingerprint: spawnSpec.runtimeFingerprint || null,
  })).digest('hex');
}

function disposeClaudeStreamRuntime(sessionId, reason = 'dispose') {
  const runtime = claudeStreamRuntimes.get(sessionId);
  if (!runtime) return;
  claudeStreamRuntimes.delete(sessionId);
  runtime.disposeReason = reason;
  runtime.pendingUi?.clear();
  runtime.client?.dispose();
}

function ensureClaudeStreamCapacity(sessionId) {
  if (claudeStreamRuntimes.size < MAX_CLAUDE_STREAM_RUNTIMES) return true;
  const candidate = [...claudeStreamRuntimes.values()]
    .filter((runtime) => runtime.sessionId !== sessionId && !activeProcesses.has(runtime.sessionId))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (!candidate) return false;
  disposeClaudeStreamRuntime(candidate.sessionId, 'capacity_eviction');
  return true;
}

function claudePermissionSuggestionLabel(suggestion, index) {
  const rules = Array.isArray(suggestion?.rules) ? suggestion.rules : [];
  const rule = String(rules[0]?.ruleContent || '').trim();
  const directories = Array.isArray(suggestion?.directories) ? suggestion.directories : [];
  if (rule) return `允许并记住：${rule.slice(0, 120)}`;
  if (directories.length > 0) return `允许并记住目录：${String(directories[0]).slice(0, 100)}`;
  return `允许并采用 CLI 建议 ${index + 1}`;
}

function sendClaudeStreamInteractiveRequest(runtime, request) {
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'claude-stream-json' || entry.streamRuntime !== runtime || !entry.ws) return;
  const params = request.params || {};
  const base = {
    type: 'interactive_request',
    sessionId: runtime.sessionId,
    agent: 'claude',
    protocol: 'claude-stream-json',
    requestId: request.requestId,
    eventType: `control_request.${request.kind}`,
  };
  if (request.kind === 'can_use_tool') {
    const askQuestions = params.tool_name === 'AskUserQuestion' && Array.isArray(params.input?.questions)
      ? params.input.questions
      : [];
    if (askQuestions.length > 0) {
      request.askUserQuestions = new Map();
      const questions = askQuestions.map((question, index) => {
        const id = `question-${index + 1}`;
        request.askUserQuestions.set(id, {
          text: String(question?.question || `问题 ${index + 1}`),
          multiple: question?.multiSelect === true,
        });
        return {
          id,
          header: question?.header || `问题 ${index + 1}`,
          question: question?.question || '',
          options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
            value: String(option?.label || ''),
            label: String(option?.label || ''),
            description: String(option?.description || ''),
          })).filter((option) => option.value),
          multiple: question?.multiSelect === true,
          required: true,
          isOther: true,
        };
      });
      wsSend(entry.ws, {
        ...base,
        respondable: true,
        interactiveKind: 'questions',
        title: params.title || 'Claude 需要补充信息',
        message: params.description || '请回答以下问题后继续。',
        questions,
      });
      return;
    }
    const options = [{ value: 'allow-once', label: '允许一次' }];
    request.permissionSuggestions = new Map();
    (Array.isArray(params.permission_suggestions) ? params.permission_suggestions : []).forEach((suggestion, index) => {
      const value = `allow-suggestion-${index}`;
      request.permissionSuggestions.set(value, cloneJson(suggestion));
      options.push({ value, label: claudePermissionSuggestionLabel(suggestion, index) });
    });
    options.push(
      { value: 'deny', label: '拒绝' },
      { value: 'cancel', label: '拒绝并停止' },
    );
    const safeInput = sanitizeToolInput(params.tool_name || '', params.input || {});
    let inputText = '';
    try { inputText = JSON.stringify(safeInput, null, 2).slice(0, 4000); } catch {}
    wsSend(entry.ws, {
      ...base,
      respondable: true,
      interactiveKind: 'select',
      title: params.title || params.display_name || `Claude 请求使用 ${params.tool_name || '工具'}`,
      message: [
        params.description || '',
        params.blocked_path ? `受限路径：${params.blocked_path}` : '',
        params.decision_reason || '',
        inputText,
      ].filter(Boolean).join('\n'),
      options,
    });
    return;
  }
  if (request.kind === 'elicitation') {
    const normalized = request.normalizedParams;
    if (normalized.mode === 'url') {
      wsSend(entry.ws, {
        ...base,
        respondable: true,
        interactiveKind: 'confirm',
        title: `${normalized.serverName || 'MCP'} 需要网页授权`,
        message: normalized.message || '请完成外部授权后确认。',
        url: normalizeExternalHttpUrl(normalized.url),
      });
    } else {
      wsSend(entry.ws, {
        ...base,
        respondable: true,
        interactiveKind: 'questions',
        title: `${normalized.serverName || 'MCP'} 需要输入`,
        message: normalized.message || '请填写以下信息。',
        questions: codexElicitationQuestions(normalized),
      });
    }
    return;
  }
  wsSend(entry.ws, {
    ...base,
    respondable: false,
    interactiveKind: 'dialog',
    title: `Claude 请求打开 ${params.dialog_kind || '原生对话框'}`,
    message: `当前 Web 界面尚未实现此开放式对话框：\n${JSON.stringify(params.payload || {}, null, 2).slice(0, 4000)}`,
  });
}

function handleClaudeStreamControlRequest(runtime, event) {
  const rawId = String(event?.request_id || '').trim();
  const params = event?.request && typeof event.request === 'object' ? event.request : {};
  const kind = String(params.subtype || '').trim();
  if (!rawId || !kind) return;
  const requestId = `claude-${rawId}`;
  const request = { requestId, controlRequestId: rawId, kind, params };
  if (kind === 'elicitation') {
    request.normalizedParams = {
      serverName: params.mcp_server_name || '',
      message: params.message || '',
      mode: params.mode || 'form',
      url: params.url || '',
      elicitationId: params.elicitation_id || '',
      requestedSchema: params.requested_schema || {},
    };
  }
  runtime.pendingUi.set(requestId, request);
  sendClaudeStreamInteractiveRequest(runtime, request);
}

function handleClaudeStreamControlCancel(runtime, event) {
  const requestId = `claude-${String(event?.request_id || '').trim()}`;
  const request = runtime.pendingUi.get(requestId);
  if (!request) return;
  runtime.pendingUi.delete(requestId);
  const entry = activeProcesses.get(runtime.sessionId);
  if (entry?.ws) {
    wsSend(entry.ws, {
      type: 'interactive_response_result',
      sessionId: runtime.sessionId,
      requestId,
      success: false,
      retryable: false,
      error: 'Claude 已取消该交互请求。',
    });
  }
}

function resendClaudeStreamInteractiveRequests(entry) {
  const runtime = entry?.streamRuntime;
  if (!runtime?.pendingUi) return;
  for (const request of runtime.pendingUi.values()) sendClaudeStreamInteractiveRequest(runtime, request);
}

function handleClaudeStreamEvent(runtime, event) {
  if (!runtime || runtime.disposeReason) return;
  runtime.lastUsedAt = Date.now();
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'claude-stream-json' || entry.streamRuntime !== runtime) {
    if (runtime.acceptEarlyEvents && event?.type === 'system') runtime.earlyEvents.push(event);
    return;
  }
  if (event?.type === 'control_request') {
    handleClaudeStreamControlRequest(runtime, event);
    return;
  }
  if (event?.type === 'control_cancel_request') {
    handleClaudeStreamControlCancel(runtime, event);
    return;
  }
  processRuntimeEvent(entry, event, runtime.sessionId);
  if (event?.type === 'result') {
    runtime.lastUsedAt = Date.now();
    runtime.entry = null;
    handleProcessComplete(runtime.sessionId, entry.lastError ? 1 : 0, null);
  }
}

function handleClaudeStreamExit(runtime, info) {
  if (!runtime) return;
  if (claudeStreamRuntimes.get(runtime.sessionId) === runtime) claudeStreamRuntimes.delete(runtime.sessionId);
  plog(info.expected ? 'INFO' : 'WARN', 'claude_stream_exit', {
    sessionId: runtime.sessionId.slice(0, 8),
    pid: runtime.client?.pid || null,
    exitCode: info.code,
    signal: info.signal,
    expected: info.expected,
    error: info.expected ? null : info.error?.message || null,
  });
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'claude-stream-json' || entry.streamRuntime !== runtime) return;
  if (!info.expected && runtime.client?.stderr?.trim()) entry.lastError = runtime.client.stderr.trim();
  handleProcessComplete(runtime.sessionId, info.expected ? 0 : (info.code ?? 1), info.signal || null);
}

async function ensureClaudeStreamRuntime(session, spawnSpec) {
  const sessionId = session.id;
  const key = claudeStreamRuntimeKey(spawnSpec);
  const existing = claudeStreamRuntimes.get(sessionId);
  if (existing?.key === key && existing.client?.isAlive) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) disposeClaudeStreamRuntime(sessionId, 'runtime_changed');
  if (!ensureClaudeStreamCapacity(sessionId)) {
    throw new Error(`Claude stream-json 会话已达到上限（${MAX_CLAUDE_STREAM_RUNTIMES}），请先停止或关闭其他 Claude 会话。`);
  }
  const runtime = {
    sessionId,
    key,
    client: null,
    entry: null,
    earlyEvents: [],
    acceptEarlyEvents: true,
    pendingUi: new Map(),
    lastUsedAt: Date.now(),
    disposeReason: null,
  };
  claudeStreamRuntimes.set(sessionId, runtime);
  try {
    runtime.client = await ClaudeStreamClient.start({
      command: spawnSpec.command,
      args: spawnSpec.args,
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      useShell: spawnSpec.useShell,
      onEvent: (event) => handleClaudeStreamEvent(runtime, event),
      onProtocolError: (error) => plog('WARN', 'claude_stream_protocol_error', {
        sessionId: sessionId.slice(0, 8),
        error: error.message,
      }),
      onExit: (info) => handleClaudeStreamExit(runtime, info),
    });
    plog('INFO', 'process_spawn', {
      sessionId: sessionId.slice(0, 8),
      pid: runtime.client.pid,
      agent: 'claude',
      transport: 'stream-json',
      mode: spawnSpec.mode,
      model: session.model || 'default',
      resume: spawnSpec.resume,
      args: spawnSpec.args.join(' '),
    });
    if (claudeStreamRuntimes.get(sessionId) !== runtime || runtime.disposeReason) {
      runtime.client.dispose();
      throw new Error('Claude stream runtime changed during startup');
    }
    return runtime;
  } catch (error) {
    if (claudeStreamRuntimes.get(sessionId) === runtime) claudeStreamRuntimes.delete(sessionId);
    runtime.disposeReason = 'startup_failed';
    runtime.client?.dispose();
    throw error;
  }
}

function claudeStreamContent(text, attachments) {
  const content = [];
  if (String(text || '').trim()) content.push({ type: 'text', text: String(text) });
  for (const attachment of attachments || []) {
    if (!attachment?.path) continue;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mime,
        data: fs.readFileSync(attachment.path).toString('base64'),
      },
    });
  }
  return content;
}

async function startClaudeStreamTurn(ws, session, spawnSpec, resolvedAttachments, runtimeInputText) {
  const sessionId = session.id;
  let runtime;
  let entry;
  try {
    runtime = await ensureClaudeStreamRuntime(session, spawnSpec);
    entry = createRuntimeEntry(session, ws, spawnSpec, resolvedAttachments, runtime.client.pid, 'claude-stream-json');
    entry.streamRuntime = runtime;
    entry.runId = crypto.randomUUID();
    runtime.entry = entry;
    setActiveProcess(sessionId, entry);
    runtime.acceptEarlyEvents = false;
    for (const event of runtime.earlyEvents.splice(0)) processRuntimeEvent(entry, event, sessionId);
    sendSessionList(ws);
    plog('INFO', 'claude_stream_turn_start', {
      sessionId: sessionId.slice(0, 8),
      pid: runtime.client.pid,
      agent: 'claude',
      transport: 'stream-json',
      mode: spawnSpec.mode,
      model: session.model || 'default',
      resume: spawnSpec.resume,
      runId: entry.runId,
    });
    await runtime.client.sendUserMessage(claudeStreamContent(runtimeInputText, resolvedAttachments));
  } catch (error) {
    if (entry && activeProcesses.get(sessionId) === entry) {
      entry.lastError = error.message || String(error);
      handleProcessComplete(sessionId, 1, null);
    } else {
      wsSend(ws, {
        type: 'error',
        sessionId,
        message: formatRuntimeError('claude', error.message || String(error), { exitCode: null, signal: null }),
      });
      wsSend(ws, { type: 'done', sessionId, costUsd: null });
      sendSessionList(ws);
    }
  }
}

function codexAppRuntimeKey(spawnSpec) {
  return crypto.createHash('sha256').update(JSON.stringify({
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd: spawnSpec.cwd,
    runtimeFingerprint: spawnSpec.runtimeFingerprint || null,
  })).digest('hex');
}

function disposeCodexAppRuntime(sessionId, reason = 'dispose') {
  const runtime = codexAppRuntimes.get(sessionId);
  if (!runtime) return;
  codexAppRuntimes.delete(sessionId);
  runtime.disposeReason = reason;
  for (const request of runtime.pendingUi.values()) {
    if (request.timeout) clearTimeout(request.timeout);
  }
  runtime.pendingUi.clear();
  runtime.client?.dispose();
}

function ensureCodexAppCapacity(sessionId) {
  if (codexAppRuntimes.size < MAX_CODEX_APP_RUNTIMES) return true;
  const candidate = [...codexAppRuntimes.values()]
    .filter((runtime) => runtime.sessionId !== sessionId && !activeProcesses.has(runtime.sessionId))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (!candidate) return false;
  disposeCodexAppRuntime(candidate.sessionId, 'capacity_eviction');
  return true;
}

function codexAppInput(text, attachments = []) {
  const input = [];
  if (String(text || '').trim()) input.push({ type: 'text', text: String(text) });
  for (const attachment of attachments) {
    if (attachment?.path) input.push({ type: 'localImage', path: attachment.path });
  }
  return input;
}

async function getCodexAppCollaborationModes(runtime) {
  if (Array.isArray(runtime?.collaborationModes)) return runtime.collaborationModes;
  if (runtime?.collaborationModesPromise) return runtime.collaborationModesPromise;
  if (!runtime?.client?.isAlive) return [];
  runtime.collaborationModesPromise = runtime.client.request('collaborationMode/list', {}, { timeoutMs: 15_000 })
    .then((result) => {
      const modes = Array.isArray(result?.data) ? result.data : [];
      runtime.collaborationModes = modes;
      return modes;
    })
    .catch((error) => {
      runtime.collaborationModes = [];
      plog('WARN', 'codex_collaboration_modes_failed', {
        sessionId: String(runtime.sessionId || '').slice(0, 8),
        error: error.message,
      });
      return [];
    })
    .finally(() => {
      runtime.collaborationModesPromise = null;
    });
  return runtime.collaborationModesPromise;
}

async function buildCodexAppCollaborationMode(runtime, permissionMode, fallbackModel, effort = null) {
  const mode = permissionMode === 'plan' ? 'plan' : 'default';
  const modes = await getCodexAppCollaborationModes(runtime);
  const preset = modes.find((entry) => entry?.mode === mode) || null;
  const model = String(preset?.model || fallbackModel || '').trim();
  if (!model) return null;
  return {
    mode,
    settings: {
      model,
      reasoning_effort: effort || preset?.reasoning_effort || null,
      developer_instructions: null,
    },
  };
}

function codexAppUsageFromRuntime(runtime) {
  const usage = runtime.latestTokenUsage?.last || runtime.latestTokenUsage || null;
  if (!usage) return null;
  return {
    input_tokens: usage.inputTokens || 0,
    cached_input_tokens: usage.cachedInputTokens || 0,
    output_tokens: usage.outputTokens || 0,
  };
}

function handleCodexAppNotification(runtime, method, params) {
  if (!runtime || runtime.disposeReason) return;
  runtime.lastUsedAt = Date.now();
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'codex-app-server' || entry.appRuntime !== runtime) return;
  if (params?.threadId && runtime.threadId && params.threadId !== runtime.threadId) return;

  switch (method) {
    case 'thread/started': {
      const threadId = params.thread?.id || params.threadId;
      if (threadId) {
        runtime.threadId = threadId;
        processRuntimeEvent(entry, { type: 'thread.started', thread_id: threadId }, runtime.sessionId);
      }
      break;
    }
    case 'turn/started': {
      runtime.turnId = params.turn?.id || params.turnId || runtime.turnId;
      processRuntimeEvent(entry, { type: 'turn.started', turn_id: runtime.turnId }, runtime.sessionId);
      break;
    }
    case 'item/started':
      processRuntimeEvent(entry, { type: 'item.started', item: params.item }, runtime.sessionId);
      break;
    case 'item/completed':
      processRuntimeEvent(entry, { type: 'item.completed', item: params.item }, runtime.sessionId);
      break;
    case 'item/agentMessage/delta':
      processRuntimeEvent(entry, {
        type: 'item.delta',
        item: { id: params.itemId, type: 'agent_message', delta: params.delta },
      }, runtime.sessionId);
      break;
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
    case 'item/plan/delta':
    // Kept for older App Server builds that used the pre-schema method name.
    case 'turn/plan/delta':
      processRuntimeEvent(entry, {
        type: 'item.reasoning.delta',
        delta: params.delta || '',
      }, runtime.sessionId);
      break;
    case 'turn/plan/updated': {
      const statusLabels = {
        pending: '[ ]',
        inProgress: '[>]',
        completed: '[x]',
      };
      const lines = ['Codex 计划更新'];
      if (params.explanation) lines.push(String(params.explanation));
      for (const step of Array.isArray(params.plan) ? params.plan : []) {
        const text = String(step?.step || '').trim();
        if (!text) continue;
        lines.push(`${statusLabels[step.status] || '[ ]'} ${text}`);
      }
      if (entry.ws) {
        wsSend(entry.ws, {
          type: 'goal_update',
          sessionId: runtime.sessionId,
          summary: lines.join('\n'),
          plan: Array.isArray(params.plan) ? params.plan : [],
        });
      }
      break;
    }
    case 'thread/tokenUsage/updated':
      runtime.latestTokenUsage = params.tokenUsage || null;
      break;
    case 'thread/goal/updated':
      processRuntimeEvent(entry, {
        type: 'thread_goal_updated',
        goal: params.goal || params,
      }, runtime.sessionId);
      break;
    case 'thread/goal/cleared':
      processRuntimeEvent(entry, {
        type: 'thread_goal_cleared',
      }, runtime.sessionId);
      break;
    case 'serverRequest/resolved': {
      const requestId = `codex-${params.requestId}`;
      const request = runtime.pendingUi.get(requestId);
      if (!request) break;
      if (request.timeout) clearTimeout(request.timeout);
      runtime.pendingUi.delete(requestId);
      if (entry.ws) {
        wsSend(entry.ws, {
          type: 'interactive_response_result',
          sessionId: runtime.sessionId,
          requestId,
          success: true,
        });
      }
      break;
    }
    case 'error': {
      const message = params.error?.message || params.message || 'Codex App Server 返回错误';
      if (params.willRetry) {
        if (entry.ws) wsSend(entry.ws, { type: 'system_message', sessionId: runtime.sessionId, message: `Codex 正在重试：${message}` });
      } else {
        entry.lastError = message;
      }
      break;
    }
    case 'thread/compacted':
      if (entry.ws) wsSend(entry.ws, { type: 'system_message', sessionId: runtime.sessionId, message: 'Codex 原生上下文压缩已完成。' });
      break;
    case 'turn/completed': {
      const turn = params.turn || {};
      if (runtime.turnId && turn.id && runtime.turnId !== turn.id) return;
      if (turn.status === 'failed') entry.lastError = turn.error?.message || 'Codex 任务失败';
      processRuntimeEvent(entry, {
        type: turn.status === 'failed' ? 'turn.failed' : 'turn.completed',
        ...(turn.status === 'failed'
          ? { error: turn.error || { message: entry.lastError } }
          : { usage: codexAppUsageFromRuntime(runtime) }),
      }, runtime.sessionId);
      runtime.turnId = null;
      runtime.latestTokenUsage = null;
      runtime.lastUsedAt = Date.now();
      handleProcessComplete(runtime.sessionId, turn.status === 'failed' ? 1 : 0, null);
      break;
    }
    default:
      break;
  }
}

function normalizeExternalHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function codexElicitationOptions(schema) {
  const multiple = schema?.type === 'array';
  const optionSchema = multiple ? (schema.items || {}) : (schema || {});
  if (Array.isArray(optionSchema.enum)) {
    return optionSchema.enum.map((value, index) => ({
      value: String(value),
      label: String(optionSchema.enumNames?.[index] || value),
    }));
  }
  const variants = Array.isArray(optionSchema.oneOf)
    ? optionSchema.oneOf
    : (Array.isArray(optionSchema.anyOf) ? optionSchema.anyOf : []);
  return variants
    .filter((option) => option && Object.prototype.hasOwnProperty.call(option, 'const'))
    .map((option) => ({ value: String(option.const), label: String(option.title || option.const) }));
}

function codexElicitationQuestions(params) {
  const properties = params?.requestedSchema?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const required = new Set(Array.isArray(params.requestedSchema.required) ? params.requestedSchema.required : []);
  return Object.entries(properties).map(([id, schema]) => {
    const multiple = schema?.type === 'array';
    let options = codexElicitationOptions(schema);
    if (!multiple && schema?.type === 'boolean' && options.length === 0) {
      options = [{ value: 'true', label: '是' }, { value: 'false', label: '否' }];
    }
    const format = String(schema?.format || '').toLowerCase();
    const inputType = schema?.type === 'number' || schema?.type === 'integer'
      ? 'number'
      : format === 'email'
        ? 'email'
        : format === 'uri'
          ? 'url'
          : format === 'date'
            ? 'date'
            : format === 'date-time'
              ? 'datetime-local'
              : 'text';
    return {
      id,
      header: schema?.title || id,
      question: schema?.description || schema?.title || id,
      options,
      multiple,
      required: required.has(id),
      inputType,
      isSecret: schema?.writeOnly === true || format === 'password',
      defaultValue: schema?.default ?? '',
      min: schema?.minimum ?? null,
      max: schema?.maximum ?? null,
      step: schema?.type === 'integer' ? 1 : null,
      minLength: schema?.minLength ?? null,
      maxLength: schema?.maxLength ?? null,
      minItems: schema?.minItems ?? null,
      maxItems: schema?.maxItems ?? null,
    };
  });
}

function codexApprovalDecisionLabel(decision) {
  if (decision === 'accept') return '允许一次';
  if (decision === 'acceptForSession') return '本会话允许';
  if (decision === 'decline') return '拒绝';
  if (decision === 'cancel') return '拒绝并停止';
  const execPolicy = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
  if (Array.isArray(execPolicy) && execPolicy.length > 0) return '允许并记住类似命令';
  const networkPolicy = decision?.applyNetworkPolicyAmendment?.network_policy_amendment;
  if (networkPolicy?.host) {
    return networkPolicy.action === 'deny'
      ? `拒绝并记住域名 ${networkPolicy.host}`
      : `允许并记住域名 ${networkPolicy.host}`;
  }
  return '';
}

function codexApprovalOptions(request, fallbackDecisions) {
  const supplied = Array.isArray(request.params?.availableDecisions) && request.params.availableDecisions.length > 0
    ? request.params.availableDecisions
    : fallbackDecisions;
  const decisions = new Map();
  const options = [];
  supplied.forEach((decision, index) => {
    const label = codexApprovalDecisionLabel(decision);
    if (!label) return;
    const value = typeof decision === 'string' ? decision : `structured-${index}`;
    decisions.set(value, cloneJson(decision));
    options.push({ value, label });
  });
  request.approvalDecisions = decisions;
  return options;
}

function sendCodexAppInteractiveRequest(runtime, request) {
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'codex-app-server' || !entry.ws) return;
  const params = request.params || {};
  const base = {
    type: 'interactive_request',
    sessionId: runtime.sessionId,
    agent: 'codex',
    protocol: 'codex-app-server',
    requestId: request.requestId,
    respondable: true,
  };
  if (request.kind === 'command-approval') {
    const options = codexApprovalOptions(request, ['accept', 'acceptForSession', 'decline', 'cancel']);
    wsSend(entry.ws, {
      ...base,
      interactiveKind: 'select',
      title: 'Codex 请求执行命令',
      message: [params.command, params.cwd ? `目录: ${params.cwd}` : '', params.reason || ''].filter(Boolean).join('\n'),
      options,
    });
  } else if (request.kind === 'file-approval') {
    const options = codexApprovalOptions(request, ['accept', 'acceptForSession', 'decline', 'cancel']);
    wsSend(entry.ws, {
      ...base,
      interactiveKind: 'select',
      title: 'Codex 请求修改文件',
      message: params.reason || params.grantRoot || '请确认是否允许本次文件修改。',
      options,
    });
  } else if (request.kind === 'permissions') {
    wsSend(entry.ws, {
      ...base,
      interactiveKind: 'select',
      title: 'Codex 请求额外权限',
      message: params.reason || `工作目录: ${params.cwd || entry.cwd || ''}`,
      options: [
        { value: 'grant-turn', label: '仅本轮允许' },
        { value: 'grant-session', label: '本会话允许' },
        { value: 'decline', label: '拒绝' },
      ],
    });
  } else if (request.kind === 'questions') {
    wsSend(entry.ws, {
      ...base,
      interactiveKind: 'questions',
      title: 'Codex 需要补充信息',
      message: '请回答以下问题后继续。',
      questions: params.questions || [],
      timeout: params.autoResolutionMs || null,
    });
  } else if (request.kind === 'elicitation') {
    const questions = codexElicitationQuestions(params);
    if (params.mode === 'url') {
      wsSend(entry.ws, {
        ...base,
        interactiveKind: 'confirm',
        title: `${params.serverName || 'MCP'} 需要网页授权`,
        message: params.message || '请完成外部授权后确认。',
        url: normalizeExternalHttpUrl(params.url),
      });
    } else {
      wsSend(entry.ws, {
        ...base,
        interactiveKind: 'questions',
        title: `${params.serverName || 'MCP'} 需要输入`,
        message: params.message || '请填写以下信息。',
        questions,
      });
    }
  }
}

function handleCodexAppRequest(runtime, method, params, rpcId) {
  if (!runtime || runtime.disposeReason) return Promise.reject(new Error('Codex runtime is no longer available'));
  if (method === 'currentTime/read') {
    return { currentTimeAt: Math.floor(Date.now() / 1000) };
  }
  if (method === 'item/tool/call' || method === 'item/dynamicTool/call') {
    return {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: `Webcoding 未注册动态工具：${String(params?.tool || 'unknown')}`,
      }],
    };
  }
  const kind = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval'
    ? 'command-approval'
    : method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval'
      ? 'file-approval'
      : method === 'item/tool/requestUserInput'
        ? 'questions'
        : method === 'mcpServer/elicitation/request'
          ? 'elicitation'
          : method === 'item/permissions/requestApproval'
            ? 'permissions'
            : null;
  if (!kind) {
    return Promise.reject(Object.assign(new Error(`Webcoding 暂不支持 Codex 客户端请求：${method}`), { code: -32601 }));
  }
  const requestId = `codex-${rpcId}`;
  const request = { requestId, rpcId, method, params, kind };
  runtime.pendingUi.set(requestId, request);
  if (kind === 'questions' && Number(params.autoResolutionMs) > 0) {
    request.timeout = setTimeout(() => {
      if (!runtime.pendingUi.has(requestId) || !runtime.client?.isAlive) return;
      runtime.pendingUi.delete(requestId);
      runtime.client.respond(rpcId, { answers: {} }).catch(() => {});
      const entry = activeProcesses.get(runtime.sessionId);
      if (entry?.ws) {
        wsSend(entry.ws, {
          type: 'interactive_response_result',
          sessionId: runtime.sessionId,
          requestId,
          success: false,
          retryable: false,
          error: 'Codex 问答请求已自动超时。',
        });
      }
    }, Number(params.autoResolutionMs));
    request.timeout.unref?.();
  }
  sendCodexAppInteractiveRequest(runtime, request);
  return undefined;
}

function resendCodexAppInteractiveRequests(entry) {
  const runtime = entry?.appRuntime;
  if (!runtime) return;
  for (const request of runtime.pendingUi.values()) sendCodexAppInteractiveRequest(runtime, request);
}

function handleCodexAppExit(runtime, info) {
  if (!runtime) return;
  if (codexAppRuntimes.get(runtime.sessionId) === runtime) codexAppRuntimes.delete(runtime.sessionId);
  plog(info.expected ? 'INFO' : 'WARN', 'codex_app_server_exit', {
    sessionId: runtime.sessionId.slice(0, 8),
    pid: runtime.client?.pid || null,
    exitCode: info.code,
    signal: info.signal,
    expected: info.expected,
    error: info.expected ? null : info.error?.message || null,
  });
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'codex-app-server' || entry.appRuntime !== runtime) return;
  if (!info.expected) entry.lastError = info.error?.message || 'Codex App Server 进程意外退出';
  handleProcessComplete(runtime.sessionId, info.expected ? 0 : (info.code ?? 1), info.signal || null);
}

async function ensureCodexAppRuntime(session, spawnSpec) {
  const sessionId = session.id;
  const key = codexAppRuntimeKey(spawnSpec);
  const existing = codexAppRuntimes.get(sessionId);
  if (existing?.key === key && existing.client?.isAlive) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) disposeCodexAppRuntime(sessionId, 'runtime_changed');
  if (!ensureCodexAppCapacity(sessionId)) {
    throw new Error(`Codex App Server 会话已达到上限（${MAX_CODEX_APP_RUNTIMES}），请先停止或关闭其他 Codex 会话。`);
  }
  const runtime = {
    sessionId,
    key,
    client: null,
    threadId: spawnSpec.runtimeId || null,
    turnId: null,
    collaborationModes: null,
    collaborationModesPromise: null,
    pendingUi: new Map(),
    latestTokenUsage: null,
    lastUsedAt: Date.now(),
    disposeReason: null,
  };
  codexAppRuntimes.set(sessionId, runtime);
  try {
    runtime.client = await CodexAppServerClient.start({
      command: spawnSpec.command,
      args: spawnSpec.args,
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      useShell: spawnSpec.useShell,
      clientVersion: PACKAGE_VERSION,
      onNotification: (method, params) => handleCodexAppNotification(runtime, method, params),
      onRequest: (method, params, id) => handleCodexAppRequest(runtime, method, params, id),
      onProtocolError: (error) => plog('WARN', 'codex_app_server_protocol_error', {
        sessionId: sessionId.slice(0, 8),
        error: error.message,
      }),
      onExit: (info) => handleCodexAppExit(runtime, info),
    });
    if (codexAppRuntimes.get(sessionId) !== runtime || runtime.disposeReason) {
      runtime.client.dispose();
      throw new Error('Codex App Server runtime changed during startup');
    }
    return runtime;
  } catch (error) {
    if (codexAppRuntimes.get(sessionId) === runtime) codexAppRuntimes.delete(sessionId);
    runtime.disposeReason = 'startup_failed';
    runtime.client?.dispose();
    throw error;
  }
}

async function startCodexAppTurn(ws, session, spawnSpec, resolvedAttachments, runtimeInputText) {
  const sessionId = session.id;
  let runtime;
  let entry;
  try {
    runtime = await ensureCodexAppRuntime(session, spawnSpec);
    entry = createRuntimeEntry(session, ws, spawnSpec, resolvedAttachments, runtime.client.pid, 'codex-app-server');
    entry.appRuntime = runtime;
    runtime.entry = entry;
    runtime.latestTokenUsage = null;
    setActiveProcess(sessionId, entry);
    sendSessionList(ws);

    let threadResult;
    const threadParams = {
      cwd: spawnSpec.cwd,
      model: session.model || null,
      approvalPolicy: spawnSpec.approvalPolicy,
      sandbox: spawnSpec.threadSandbox,
    };
    if (spawnSpec.runtimeId) {
      try {
        threadResult = await runtime.client.request('thread/resume', {
          ...threadParams,
          threadId: spawnSpec.runtimeId,
        }, { timeoutMs: 30_000 });
      } catch (error) {
        runtime.threadId = null;
        wsSend(ws, {
          type: 'system_message',
          sessionId,
          message: `Codex 原线程无法恢复，已新建线程并补充当前 Web 会话上下文：${error.message}`,
        });
        const history = Array.isArray(session.messages) ? session.messages.slice(0, -1) : [];
        const carryover = buildThreadCarryoverPayload(
          session,
          runtimeInputText,
          resolvedAttachments,
          history,
          { agent: 'codex', reason: 'resume_failed', previousRuntimeId: spawnSpec.runtimeId },
        );
        runtimeInputText = carryover.prompt;
        threadResult = await runtime.client.request('thread/start', threadParams, { timeoutMs: 30_000 });
      }
    } else {
      threadResult = await runtime.client.request('thread/start', threadParams, { timeoutMs: 30_000 });
    }

    const threadId = threadResult?.thread?.id || runtime.threadId;
    if (!threadId) throw new Error('Codex App Server 未返回 threadId');
    runtime.threadId = threadId;
    entry.resolvedModel = threadResult?.model || spawnSpec.effectiveModel || null;
    processRuntimeEvent(entry, { type: 'thread.started', thread_id: threadId }, sessionId);

    if (session.codexPersonality || spawnSpec.effort) {
      try {
        await runtime.client.request('thread/settings/update', {
          threadId,
          ...(session.codexPersonality ? { personality: session.codexPersonality } : {}),
          ...(spawnSpec.effort ? { effort: spawnSpec.effort } : {}),
        }, { timeoutMs: 15_000 });
      } catch (error) {
        plog('WARN', 'codex_thread_settings_restore_failed', { sessionId: sessionId.slice(0, 8), error: error.message });
        if (entry.ws) {
          wsSend(entry.ws, {
            type: 'system_message',
            sessionId,
            message: `Codex 线程设置恢复失败，本轮继续使用默认值：${error.message}`,
          });
        }
      }
    }

    const isCompactRequest = String(runtimeInputText || '').trim() === '/compact';
    const collaborationMode = !isCompactRequest && !spawnSpec.reviewRequest
      ? await buildCodexAppCollaborationMode(
          runtime,
          spawnSpec.mode,
          threadResult?.model || entry.resolvedModel,
          spawnSpec.effort,
        )
      : null;

    plog('INFO', 'codex_app_turn_start', {
      sessionId: sessionId.slice(0, 8),
      pid: runtime.client.pid,
      threadId,
      mode: spawnSpec.mode,
      collaborationMode: collaborationMode?.mode || null,
      model: entry.resolvedModel || 'default',
      effort: spawnSpec.effort || 'default',
      resume: spawnSpec.resume,
      review: !!spawnSpec.reviewRequest,
      operation: spawnSpec.resume ? 'thread/resume' : 'thread/start',
      transport: 'app-server',
      attachmentCount: resolvedAttachments.length,
      args: spawnSpec.args.join(' '),
    });

    if (isCompactRequest) {
      await runtime.client.request('thread/compact/start', { threadId }, { timeoutMs: 30_000 });
      return;
    }
    let turnResult;
    if (spawnSpec.reviewRequest) {
      const instructions = String(spawnSpec.reviewRequest.instructions || '').trim();
      turnResult = await runtime.client.request('review/start', {
        threadId,
        delivery: 'inline',
        target: instructions
          ? { type: 'custom', instructions }
          : { type: 'uncommittedChanges' },
      }, { timeoutMs: 30_000 });
    } else {
      const input = codexAppInput(runtimeInputText, resolvedAttachments);
      const turnParams = {
        threadId,
        input,
        cwd: spawnSpec.cwd,
        model: session.model || null,
        approvalPolicy: spawnSpec.approvalPolicy,
        sandboxPolicy: spawnSpec.sandboxPolicy,
        effort: spawnSpec.effort || null,
      };
      if (collaborationMode) turnParams.collaborationMode = collaborationMode;
      turnResult = await runtime.client.request('turn/start', turnParams, { timeoutMs: 30_000 });
    }
    runtime.turnId = turnResult?.turn?.id || runtime.turnId;
  } catch (error) {
    if (entry && activeProcesses.get(sessionId) === entry) {
      entry.lastError = error.message || String(error);
      handleProcessComplete(sessionId, 1, null);
    } else {
      const message = formatRuntimeError('codex', error.message || String(error), { exitCode: null, signal: null });
      wsSend(ws, { type: 'error', sessionId, message });
      wsSend(ws, { type: 'done', sessionId, costUsd: null });
      sendSessionList(ws);
    }
  }
}

function piRpcRuntimeKey(spawnSpec) {
  return crypto.createHash('sha256').update(JSON.stringify({
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd: spawnSpec.cwd,
    runtimeFingerprint: spawnSpec.runtimeFingerprint || null,
  })).digest('hex');
}

function disposePiRpcRuntime(sessionId, reason = 'dispose') {
  const runtime = piRpcRuntimes.get(sessionId);
  if (!runtime) return false;
  piRpcRuntimes.delete(sessionId);
  runtime.disposeReason = reason;
  runtime.client?.dispose();
  plog('INFO', 'pi_rpc_dispose', {
    sessionId: sessionId.slice(0, 8),
    pid: runtime.client?.pid || null,
    reason,
  });
  return true;
}

function evictIdlePiRpcRuntime() {
  if (piRpcRuntimes.size < MAX_PI_RPC_RUNTIMES) return true;
  const candidate = [...piRpcRuntimes.values()]
    .filter((runtime) => !activeProcesses.has(runtime.sessionId))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (!candidate) return false;
  disposePiRpcRuntime(candidate.sessionId, 'capacity');
  return true;
}

function persistPiRpcState(runtime, state) {
  if (!runtime || !state) return;
  runtime.state = state;
  runtime.lastUsedAt = Date.now();
  const session = loadSession(runtime.sessionId);
  if (!session || !state.sessionId) return;
  setRuntimeSessionState(session, {
    runtimeId: state.sessionId,
    runtimeFingerprint: runtime.spawnSpec.runtimeFingerprint || null,
    channelDescriptor: runtime.spawnSpec.channelDescriptor || null,
  }, {
    agent: 'pi',
    channelKey: runtime.spawnSpec.channelKey || null,
    channelDescriptor: runtime.spawnSpec.channelDescriptor || null,
  });
  saveSession(session);
}

function piModelMenuEntries(models) {
  const entries = [{
    value: 'default',
    label: '默认模型（Pi）',
    desc: '使用当前 Pi 配置中的默认模型',
  }];
  for (const model of Array.isArray(models) ? models : []) {
    const provider = String(model?.provider || '').trim();
    const id = String(model?.id || '').trim();
    if (!id) continue;
    const value = provider ? `${provider}/${id}` : id;
    const details = [];
    if (Number.isFinite(model?.contextWindow)) details.push(`${Math.round(model.contextWindow / 1000)}K 上下文`);
    if (model?.reasoning) details.push('支持 thinking');
    if (Array.isArray(model?.input) && model.input.includes('image')) details.push('支持图片');
    entries.push({
      value,
      label: String(model?.name || id),
      desc: details.join(' · ') || value,
    });
  }
  return entries;
}

async function refreshPiRpcDiscovery(runtime) {
  if (!runtime?.client?.isAlive) return;
  const [modelsResult, commandsResult] = await Promise.allSettled([
    runtime.client.request({ type: 'get_available_models' }, { timeoutMs: 30_000 }),
    runtime.client.request({ type: 'get_commands' }, { timeoutMs: 15_000 }),
  ]);
  if (modelsResult.status === 'fulfilled') {
    runtime.models = modelsResult.value.data?.models || [];
  }
  if (commandsResult.status === 'fulfilled') {
    runtime.commands = commandsResult.value.data?.commands || [];
    onSlashCommandsDiscovered('pi', runtime.commands.map((command) => ({
      name: command.name,
      desc: command.description || command.name,
      source: `pi-${command.source || 'cli'}`,
    })));
  }
}

function handlePiRpcExit(runtime, info) {
  if (!runtime) return;
  if (piRpcRuntimes.get(runtime.sessionId) === runtime) {
    piRpcRuntimes.delete(runtime.sessionId);
  }
  plog(info.expected ? 'INFO' : 'WARN', 'pi_rpc_exit', {
    sessionId: runtime.sessionId.slice(0, 8),
    pid: runtime.client?.pid || null,
    exitCode: info.code,
    signal: info.signal,
    expected: info.expected,
    error: info.expected ? null : info.error?.message || null,
  });
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'pi-rpc' || entry.rpcRuntime !== runtime) return;
  if (!info.expected) entry.lastError = info.error?.message || 'Pi RPC 进程意外退出';
  handleProcessComplete(runtime.sessionId, info.expected ? 0 : (info.code ?? 1), info.signal || null);
}

function sendPiRpcInteractiveRequest(runtime, event) {
  const entry = activeProcesses.get(runtime.sessionId);
  const method = String(event.method || 'interactive');
  const uiState = runtime.extensionUiState || (runtime.extensionUiState = {
    statuses: new Map(),
    widgets: new Map(),
    title: '',
  });
  if (method === 'setStatus') {
    const key = String(event.statusKey || 'status');
    const text = event.statusText == null ? null : String(event.statusText);
    if (text) uiState.statuses.set(key, text);
    else uiState.statuses.delete(key);
    if (entry?.ws) wsSend(entry.ws, {
      type: 'pi_extension_ui', sessionId: runtime.sessionId, method, key, text,
    });
    return;
  }
  if (method === 'setWidget') {
    const key = String(event.widgetKey || 'widget');
    const lines = Array.isArray(event.widgetLines) ? event.widgetLines.map(String) : null;
    if (lines?.length) uiState.widgets.set(key, { lines, placement: event.widgetPlacement || null });
    else uiState.widgets.delete(key);
    if (entry?.ws) wsSend(entry.ws, {
      type: 'pi_extension_ui', sessionId: runtime.sessionId, method, key, lines,
      placement: event.widgetPlacement || null,
    });
    return;
  }
  if (method === 'setTitle') {
    uiState.title = String(event.title || '');
    if (entry?.ws) wsSend(entry.ws, {
      type: 'pi_extension_ui', sessionId: runtime.sessionId, method, title: uiState.title,
    });
    return;
  }
  if (method === 'set_editor_text') {
    if (entry?.ws) wsSend(entry.ws, {
      type: 'pi_extension_ui', sessionId: runtime.sessionId, method, text: String(event.text || ''),
    });
    return;
  }
  if (!entry || entry.transport !== 'pi-rpc') return;
  const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
  if (!dialogMethods.has(method)) {
    if (method === 'notify' && entry.ws) {
      wsSend(entry.ws, {
        type: event.notifyType === 'error' ? 'error' : 'system_message',
        sessionId: runtime.sessionId,
        message: String(event.message || ''),
      });
    }
    return;
  }
  runtime.pendingUi.set(event.id, event);
  if (!entry.ws) return;
  wsSend(entry.ws, {
    type: 'interactive_request',
    sessionId: runtime.sessionId,
    agent: 'pi',
    protocol: 'pi-rpc',
    requestId: event.id,
    interactiveKind: method,
    respondable: true,
    title: event.title || 'Pi 需要输入',
    message: event.message || event.placeholder || event.prefill || '',
    options: Array.isArray(event.options) ? event.options : [],
    placeholder: event.placeholder || '',
    prefill: event.prefill || '',
    timeout: event.timeout || null,
  });
}

function resendPiRpcInteractiveRequests(entry) {
  const runtime = entry?.rpcRuntime;
  if (!runtime || !entry.ws) return;
  for (const event of runtime.pendingUi.values()) {
    sendPiRpcInteractiveRequest(runtime, event);
  }
  sendPiRpcExtensionUiState(entry.ws, runtime);
}

function sendPiRpcExtensionUiState(ws, runtime) {
  if (!ws || !runtime) return;
  const uiState = runtime.extensionUiState;
  for (const [key, text] of uiState?.statuses || []) {
    wsSend(ws, { type: 'pi_extension_ui', sessionId: runtime.sessionId, method: 'setStatus', key, text });
  }
  for (const [key, widget] of uiState?.widgets || []) {
    wsSend(ws, {
      type: 'pi_extension_ui',
      sessionId: runtime.sessionId,
      method: 'setWidget',
      key,
      lines: widget.lines,
      placement: widget.placement || null,
    });
  }
  if (uiState?.title) {
    wsSend(ws, { type: 'pi_extension_ui', sessionId: runtime.sessionId, method: 'setTitle', title: uiState.title });
  }
}

function piRpcMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function piRpcArrayDifference(left, right) {
  const remaining = Array.isArray(right) ? right.slice() : [];
  const difference = [];
  for (const value of Array.isArray(left) ? left : []) {
    const index = remaining.indexOf(value);
    if (index >= 0) remaining.splice(index, 1);
    else difference.push(value);
  }
  return difference;
}

function getPiRpcQueueItems(entry) {
  return (entry?.rpcQueuedMessages || [])
    .filter((record) => record.accepted && !record.started && !record.immediate)
    .map((record) => ({
      clientMessageId: record.clientMessageId || record.id,
      text: record.text,
      attachments: record.savedAttachments || [],
      streamingBehavior: record.streamingBehavior,
      status: 'queued',
    }));
}

function sendPiRpcQueueState(entry) {
  if (!entry?.ws || entry.ws.readyState !== 1 || entry.transport !== 'pi-rpc') return;
  const runtime = entry.rpcRuntime;
  const queueState = runtime?.queueState || { steering: [], followUp: [] };
  wsSend(entry.ws, {
    type: 'pi_queue_update',
    sessionId: runtime?.sessionId || null,
    steeringCount: Array.isArray(queueState.steering) ? queueState.steering.length : 0,
    followUpCount: Array.isArray(queueState.followUp) ? queueState.followUp.length : 0,
    items: getPiRpcQueueItems(entry),
  });
}

function persistPiRpcAssistantBuffer(runtime, entry) {
  if (!runtime || !entry) return false;
  if (!(entry.fullText || (entry.toolCalls && entry.toolCalls.length > 0) || hasPersistableSegments(entry))) {
    return false;
  }
  const session = loadSession(runtime.sessionId);
  if (!session) return false;
  const modelId = String(entry.resolvedModel || entry.effectiveModel || resolveEffectiveModelId(session) || '').trim() || null;
  session.messages.push({
    role: 'assistant',
    content: entry.fullText || '',
    toolCalls: entry.toolCalls || [],
    segments: entry.segments || [],
    model: modelId,
    timestamp: new Date().toISOString(),
  });
  session.updated = new Date().toISOString();
  if (!entry.ws) session.hasUnread = true;
  saveSession(session);
  entry.rpcPersistedAssistantMessages = (entry.rpcPersistedAssistantMessages || 0) + 1;
  entry.fullText = '';
  entry.toolCalls = [];
  entry.segments = [];
  return true;
}

function piRpcAssistantMessageNeedsTools(message) {
  const stopReason = String(message?.stopReason || message?.stop_reason || '').toLowerCase().replace(/[^a-z]/g, '');
  if (stopReason === 'tooluse' || stopReason === 'toolcalls') return true;
  return Array.isArray(message?.content) && message.content.some((part) => (
    part?.type === 'toolCall' || part?.type === 'tool_call' || part?.type === 'tool_use'
  ));
}

function handlePiRpcQueueUpdate(runtime, entry, event) {
  const previous = runtime.queueState || { steering: [], followUp: [] };
  const next = {
    steering: Array.isArray(event.steering) ? event.steering.slice() : [],
    followUp: Array.isArray(event.followUp) ? event.followUp.slice() : [],
  };
  for (const [queueKey, streamingBehavior] of [['steering', 'steer'], ['followUp', 'followUp']]) {
    const added = piRpcArrayDifference(next[queueKey], previous[queueKey]);
    for (const expandedText of added) {
      const record = (entry.rpcQueuedMessages || []).find((item) => (
        !item.observedQueued && !item.started && item.streamingBehavior === streamingBehavior
      ));
      if (!record) continue;
      record.observedQueued = true;
      record.expandedText = expandedText;
      record.status = 'queued';
    }
    const removed = piRpcArrayDifference(previous[queueKey], next[queueKey]);
    for (const expandedText of removed) {
      runtime.dequeuedQueueItems.push({ streamingBehavior, expandedText });
    }
  }
  runtime.queueState = next;
  sendPiRpcQueueState(entry);
}

function takePiRpcQueuedRecord(runtime, entry, messageText) {
  const dequeuedIndex = runtime.dequeuedQueueItems.findIndex((item) => item.expandedText === messageText);
  const fallbackDequeuedIndex = dequeuedIndex >= 0 ? dequeuedIndex : (runtime.dequeuedQueueItems.length > 0 ? 0 : -1);
  const dequeued = fallbackDequeuedIndex >= 0
    ? runtime.dequeuedQueueItems.splice(fallbackDequeuedIndex, 1)[0]
    : null;
  const records = entry.rpcQueuedMessages || [];
  let recordIndex = records.findIndex((item) => (
    !item.started && (item.expandedText === messageText || item.text === messageText)
  ));
  if (recordIndex < 0 && dequeued) {
    recordIndex = records.findIndex((item) => !item.started && item.streamingBehavior === dequeued.streamingBehavior);
  }
  if (recordIndex < 0) recordIndex = records.findIndex((item) => !item.started && item.accepted);
  if (recordIndex < 0) return null;
  const [record] = records.splice(recordIndex, 1);
  record.started = true;
  record.status = 'started';
  return record;
}

function handlePiRpcUserMessageStart(runtime, entry, event) {
  if (entry.rpcInitialUserPending) {
    entry.rpcInitialUserPending = false;
    return;
  }
  const messageText = piRpcMessageText(event.message);
  const record = takePiRpcQueuedRecord(runtime, entry, messageText);
  if (!record && !messageText) return;

  // A steering message can arrive after a tool-use assistant message. Persist that
  // completed portion before inserting the next user message so history stays ordered.
  persistPiRpcAssistantBuffer(runtime, entry);

  const session = loadSession(runtime.sessionId);
  if (session) {
    session.messages.push({
      role: 'user',
      content: record?.text ?? messageText,
      attachments: record?.savedAttachments || [],
      timestamp: new Date().toISOString(),
    });
    session.updated = new Date().toISOString();
    saveSession(session);
  }

  if (entry.ws) {
    wsSend(entry.ws, {
      type: 'pi_queued_turn_start',
      sessionId: runtime.sessionId,
      clientMessageId: record?.clientMessageId || record?.id || null,
      text: record?.text ?? messageText,
      attachments: record?.savedAttachments || [],
      streamingBehavior: record?.streamingBehavior || null,
    });
  }
  sendPiRpcQueueState(entry);
}

function handlePiRpcEvent(runtime, event) {
  if (!runtime || !event) return;
  runtime.lastUsedAt = Date.now();
  if (event.type === 'extension_ui_request') {
    sendPiRpcInteractiveRequest(runtime, event);
    return;
  }
  const entry = activeProcesses.get(runtime.sessionId);
  if (!entry || entry.transport !== 'pi-rpc' || entry.rpcRuntime !== runtime) return;
  if (event.type === 'queue_update') {
    handlePiRpcQueueUpdate(runtime, entry, event);
    return;
  }
  if (event.type === 'message_start' && event.message?.role === 'user') {
    handlePiRpcUserMessageStart(runtime, entry, event);
  }
  if (event.type === 'agent_start') entry.rpcAgentStarted = true;
  processRuntimeEvent(entry, event, runtime.sessionId);
  if (
    event.type === 'message_end'
    && event.message?.role === 'assistant'
    && !piRpcAssistantMessageNeedsTools(event.message)
  ) {
    persistPiRpcAssistantBuffer(runtime, entry);
  }
  if (event.type === 'agent_end' && event.willRetry !== true && !entry.rpcCompleted) {
    persistPiRpcAssistantBuffer(runtime, entry);
    entry.rpcCompleted = true;
    runtime.pendingUi.clear();
    handleProcessComplete(runtime.sessionId, 0, null);
  }
}

async function ensurePiRpcRuntime(session, spawnSpec) {
  const sessionId = session.id;
  const key = piRpcRuntimeKey(spawnSpec);
  const existing = piRpcRuntimes.get(sessionId);
  if (existing && existing.key === key) {
    await existing.startPromise;
    if (existing.client?.isAlive) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
  }
  if (existing) disposePiRpcRuntime(sessionId, 'configuration_changed');
  if (!evictIdlePiRpcRuntime()) {
    throw new Error(`Pi RPC 同时运行的会话已达到上限（${MAX_PI_RPC_RUNTIMES}）`);
  }

  const runtime = {
    sessionId,
    key,
    spawnSpec,
    client: null,
    state: null,
    models: [],
    commands: [],
    pendingUi: new Map(),
    extensionUiState: { statuses: new Map(), widgets: new Map(), title: '' },
    queueState: { steering: [], followUp: [] },
    dequeuedQueueItems: [],
    lastUsedAt: Date.now(),
    startPromise: null,
    disposeReason: null,
  };
  piRpcRuntimes.set(sessionId, runtime);
  const client = new PiRpcClient({
    command: spawnSpec.command,
    args: spawnSpec.args,
    env: spawnSpec.env,
    cwd: spawnSpec.cwd,
    useShell: spawnSpec.useShell,
    onEvent: (event) => handlePiRpcEvent(runtime, event),
    onProtocolError: (error) => {
      plog('WARN', 'pi_rpc_protocol_error', {
        sessionId: sessionId.slice(0, 8),
        error: error.message,
      });
    },
    onExit: (info) => handlePiRpcExit(runtime, info),
  });
  // Register before the handshake so delete/reconfigure can release a starting process.
  runtime.client = client;
  runtime.startPromise = client.start().then(() => {
    if (piRpcRuntimes.get(sessionId) !== runtime || runtime.disposeReason) {
      client.dispose();
      throw new Error(`Pi RPC runtime was disposed during startup (${runtime.disposeReason || 'replaced'})`);
    }
    persistPiRpcState(runtime, client.state);
    plog('INFO', 'pi_rpc_ready', {
      sessionId: sessionId.slice(0, 8),
      pid: client.pid,
      runtimeId: client.state?.sessionId || null,
      model: client.state?.model?.id || null,
    });
    refreshPiRpcDiscovery(runtime).catch((error) => {
      plog('WARN', 'pi_rpc_discovery_failed', { sessionId: sessionId.slice(0, 8), error: error.message });
    });
    return runtime;
  }).catch((error) => {
    if (piRpcRuntimes.get(sessionId) === runtime) piRpcRuntimes.delete(sessionId);
    throw error;
  });
  return runtime.startPromise;
}

function piRpcPromptImages(attachments) {
  const images = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    try {
      images.push({
        type: 'image',
        data: fs.readFileSync(attachment.path).toString('base64'),
        mimeType: attachment.mime,
      });
    } catch {}
  }
  return images;
}

async function startPiRpcTurn(ws, session, spawnSpec, resolvedAttachments, inputText) {
  const sessionId = session.id;
  const entry = createRuntimeEntry(session, ws, spawnSpec, resolvedAttachments, null, 'pi-rpc');
  entry.rpcAgentStarted = false;
  entry.rpcCompleted = false;
  setActiveProcess(sessionId, entry);
  sendSessionList(ws);
  try {
    const runtime = await ensurePiRpcRuntime(session, spawnSpec);
    if (activeProcesses.get(sessionId) !== entry) return;
    entry.pid = runtime.client.pid;
    entry.rpcRuntime = runtime;
    entry.resolvedModel = runtime.state?.model?.id || entry.resolvedModel;
    if (entry.abortRequested) {
      await runtime.client.request({ type: 'abort' }, { timeoutMs: 10_000 });
      if (activeProcesses.get(sessionId) === entry) handleProcessComplete(sessionId, 0, null);
      return;
    }

    plog('INFO', 'process_spawn', {
      sessionId: sessionId.slice(0, 8),
      pid: runtime.client.pid,
      agent: 'pi',
      transport: 'rpc',
      mode: spawnSpec.mode,
      model: session.model || runtime.state?.model?.id || 'default',
      resume: spawnSpec.resume,
      args: spawnSpec.args.join(' '),
    });

    const pendingSlash = pendingSlashCommands.get(sessionId) || null;
    if (pendingSlash?.kind === 'compact') {
      await runtime.client.request({ type: 'compact' }, { timeoutMs: 5 * 60_000 });
      if (activeProcesses.get(sessionId) === entry) handleProcessComplete(sessionId, 0, null);
      return;
    }

    const images = piRpcPromptImages(resolvedAttachments);
    await runtime.client.request({
      type: 'prompt',
      message: String(inputText || ''),
      ...(images.length > 0 ? { images } : {}),
    }, { timeoutMs: 60_000 });

    if (activeProcesses.get(sessionId) !== entry || entry.rpcAgentStarted) return;
    const stateResponse = await runtime.client.request({ type: 'get_state' }, { timeoutMs: 15_000 });
    persistPiRpcState(runtime, stateResponse.data);
    if (!stateResponse.data?.isStreaming && activeProcesses.get(sessionId) === entry) {
      entry.rpcCompleted = true;
      handleProcessComplete(sessionId, 0, null);
    }
  } catch (error) {
    if (activeProcesses.get(sessionId) !== entry) return;
    entry.lastError = error.message || String(error);
    handleProcessComplete(sessionId, 1, null);
  }
}

async function getPiModelMenuPayload(session) {
  if (PI_TRANSPORT !== 'rpc' || !session) {
    throw new Error('Pi RPC model discovery is unavailable');
  }
  const spawnSpec = buildPiSpawnSpec(session, { transport: 'rpc' });
  if (spawnSpec?.error) throw new Error(spawnSpec.error);
  const runtime = await ensurePiRpcRuntime(session, spawnSpec);
  if (!runtime.models.length) await refreshPiRpcDiscovery(runtime);
  const state = runtime.state || {};
  const stateModel = state.model?.provider && state.model?.id
    ? `${state.model.provider}/${state.model.id}`
    : state.model?.id || '';
  return {
    type: 'model_list',
    agent: 'pi',
    entries: piModelMenuEntries(runtime.models),
    current: session.model || stateModel || 'default',
    currentFull: session.model || stateModel || '',
    source: 'pi-rpc',
    thinkingLevel: state.thinkingLevel || null,
  };
}

function handlePiRpcInteractiveResponse(ws, msg) {
  const sessionId = sanitizeId(msg?.sessionId || '');
  const requestId = String(msg?.requestId || '').trim();
  const rejectResponse = (message, retryable = false) => {
    wsSend(ws, {
      type: 'interactive_response_result',
      sessionId,
      requestId,
      success: false,
      retryable,
      error: message,
    });
    wsSend(ws, { type: 'error', sessionId, message });
  };
  if (!sessionId || wsSessionMap.get(ws) !== sessionId) {
    return rejectResponse('当前页面不属于该 Pi 交互请求。');
  }
  const runtime = piRpcRuntimes.get(sessionId);
  const request = runtime?.pendingUi.get(requestId);
  if (!runtime?.client?.isAlive || !request) {
    return rejectResponse('该 Pi 交互请求已失效。');
  }
  const response = { id: requestId };
  if (msg.cancelled === true) {
    response.cancelled = true;
  } else if (request.method === 'confirm') {
    response.confirmed = msg.confirmed === true;
  } else {
    response.value = String(msg.value ?? '');
  }
  runtime.pendingUi.delete(requestId);
  runtime.client.sendExtensionResponse(response).then(() => {
    wsSend(ws, { type: 'interactive_response_result', sessionId, requestId, success: true });
  }).catch((error) => {
    runtime.pendingUi.set(requestId, request);
    wsSend(ws, {
      type: 'interactive_response_result',
      sessionId,
      requestId,
      success: false,
      retryable: true,
      error: error.message,
    });
    wsSend(ws, { type: 'error', sessionId, message: `Pi 交互响应失败：${error.message}` });
  });
}

function normalizeCodexQuestionAnswers(request, msg) {
  const answers = msg?.answers && typeof msg.answers === 'object' ? msg.answers : {};
  const allowedIds = new Set((Array.isArray(request?.params?.questions) ? request.params.questions : [])
    .map((question) => String(question?.id || ''))
    .filter(Boolean));
  const normalized = Object.create(null);
  for (const [key, value] of Object.entries(answers)) {
    if (!allowedIds.has(key)) continue;
    normalized[key] = {
      answers: Array.isArray(value) ? value.map(String) : [String(value ?? '')],
    };
  }
  return normalized;
}

function handleClaudeStreamInteractiveResponse(ws, msg) {
  const sessionId = sanitizeId(msg?.sessionId || '');
  const requestId = String(msg?.requestId || '').trim();
  const rejectResponse = (message, retryable = false) => {
    wsSend(ws, {
      type: 'interactive_response_result',
      sessionId,
      requestId,
      success: false,
      retryable,
      error: message,
    });
    wsSend(ws, { type: 'error', sessionId, message });
  };
  if (!sessionId || wsSessionMap.get(ws) !== sessionId) {
    return rejectResponse('当前页面不属于该 Claude 交互请求。');
  }
  const runtime = claudeStreamRuntimes.get(sessionId);
  const request = runtime?.pendingUi?.get(requestId);
  if (!runtime?.client?.isAlive || !request) {
    return rejectResponse('该 Claude 交互请求已失效。');
  }

  let response;
  try {
    if (request.kind === 'can_use_tool') {
      if (request.askUserQuestions instanceof Map) {
        if (msg.cancelled === true) {
          response = {
            behavior: 'deny',
            message: '用户取消了问题回答。',
            interrupt: false,
            ...(request.params.tool_use_id ? { toolUseID: request.params.tool_use_id } : {}),
            decisionClassification: 'user_reject',
          };
        } else {
          const submittedAnswers = msg.answers && typeof msg.answers === 'object' ? msg.answers : {};
          const answers = Object.create(null);
          for (const [questionId, question] of request.askUserQuestions) {
            if (!Object.prototype.hasOwnProperty.call(submittedAnswers, questionId)) {
              throw new Error(`请回答：${question.text}`);
            }
            const rawValue = submittedAnswers[questionId];
            const values = (Array.isArray(rawValue) ? rawValue : [rawValue])
              .map((value) => String(value ?? '').trim())
              .filter(Boolean);
            if (values.length === 0) throw new Error(`请回答：${question.text}`);
            answers[question.text] = question.multiple ? values.join(', ') : values[0];
          }
          response = {
            behavior: 'allow',
            updatedInput: {
              ...cloneJson(request.params.input || {}),
              answers,
            },
            ...(request.params.tool_use_id ? { toolUseID: request.params.tool_use_id } : {}),
            decisionClassification: 'user_temporary',
          };
        }
      } else {
        const value = msg.cancelled === true ? 'cancel' : String(msg.value || '');
        if (value === 'allow-once' || request.permissionSuggestions?.has(value)) {
          const suggestion = request.permissionSuggestions?.get(value) || null;
          response = {
            behavior: 'allow',
            updatedInput: cloneJson(request.params.input || {}),
            ...(suggestion ? { updatedPermissions: [cloneJson(suggestion)] } : {}),
            ...(request.params.tool_use_id ? { toolUseID: request.params.tool_use_id } : {}),
            decisionClassification: suggestion ? 'user_permanent' : 'user_temporary',
          };
        } else if (value === 'deny' || value === 'cancel') {
          response = {
            behavior: 'deny',
            message: value === 'cancel' ? '用户拒绝并停止本轮。' : '用户拒绝了本次工具调用。',
            interrupt: value === 'cancel',
            ...(request.params.tool_use_id ? { toolUseID: request.params.tool_use_id } : {}),
            decisionClassification: 'user_reject',
          };
        } else {
          return rejectResponse('请选择一个有效的 Claude 审批选项。', true);
        }
      }
    } else if (request.kind === 'elicitation') {
      const normalized = request.normalizedParams;
      if (msg.cancelled === true) response = { action: 'cancel' };
      else if (msg.confirmed === false) response = { action: 'decline' };
      else response = {
        action: 'accept',
        ...(normalized.mode === 'url'
          ? {}
          : { content: codexElicitationContent({ params: normalized }, msg) }),
      };
    } else {
      return rejectResponse('该 Claude 原生对话框暂时无法在网页中回应。');
    }
  } catch (error) {
    return rejectResponse(error.message || 'Claude 交互响应无效。', true);
  }

  runtime.client.writeLine({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: request.controlRequestId,
      response,
    },
  }).then(() => {
    runtime.pendingUi.delete(requestId);
    wsSend(ws, { type: 'interactive_response_result', sessionId, requestId, success: true });
  }).catch((error) => {
    wsSend(ws, {
      type: 'interactive_response_result',
      sessionId,
      requestId,
      success: false,
      retryable: true,
      error: error.message,
    });
    wsSend(ws, { type: 'error', sessionId, message: `Claude 交互响应失败：${error.message}` });
  });
}

function codexElicitationContent(request, msg) {
  const rawAnswers = msg?.answers && typeof msg.answers === 'object' ? msg.answers : {};
  const properties = request.params?.requestedSchema?.properties || {};
  const required = new Set(Array.isArray(request.params?.requestedSchema?.required)
    ? request.params.requestedSchema.required
    : []);
  const content = Object.create(null);
  for (const [key, schema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(rawAnswers, key)) {
      if (required.has(key)) throw new Error(`MCP 表单缺少必填项：${schema?.title || key}`);
      continue;
    }
    const rawValue = rawAnswers[key];
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map((value) => String(value ?? ''));
    if (schema?.type === 'array') {
      const selected = values.filter((value) => value !== '');
      if (required.has(key) && selected.length === 0) throw new Error(`MCP 表单缺少必填项：${schema?.title || key}`);
      if (Number.isFinite(schema?.minItems) && selected.length < schema.minItems) throw new Error(`${schema?.title || key} 至少选择 ${schema.minItems} 项`);
      if (Number.isFinite(schema?.maxItems) && selected.length > schema.maxItems) throw new Error(`${schema?.title || key} 最多选择 ${schema.maxItems} 项`);
      if (selected.length > 0 || required.has(key)) content[key] = selected;
      continue;
    }
    const first = values[0] || '';
    if (!first && !required.has(key)) continue;
    if (!first) throw new Error(`MCP 表单缺少必填项：${schema?.title || key}`);
    if (schema?.type === 'boolean') {
      content[key] = first === 'true';
    } else if (schema?.type === 'number' || schema?.type === 'integer') {
      const numeric = Number(first);
      if (!Number.isFinite(numeric) || (schema.type === 'integer' && !Number.isInteger(numeric))) {
        throw new Error(`${schema?.title || key} 必须是有效数字`);
      }
      if (Number.isFinite(schema.minimum) && numeric < schema.minimum) throw new Error(`${schema?.title || key} 不能小于 ${schema.minimum}`);
      if (Number.isFinite(schema.maximum) && numeric > schema.maximum) throw new Error(`${schema?.title || key} 不能大于 ${schema.maximum}`);
      content[key] = numeric;
    } else {
      if (Number.isFinite(schema?.minLength) && first.length < schema.minLength) throw new Error(`${schema?.title || key} 长度不足`);
      if (Number.isFinite(schema?.maxLength) && first.length > schema.maxLength) throw new Error(`${schema?.title || key} 长度超限`);
      content[key] = first;
    }
  }
  return content;
}

function handleCodexAppInteractiveResponse(ws, msg) {
  const sessionId = sanitizeId(msg?.sessionId || '');
  const requestId = String(msg?.requestId || '').trim();
  const rejectResponse = (message, retryable = false) => {
    wsSend(ws, {
      type: 'interactive_response_result',
      sessionId,
      requestId,
      success: false,
      retryable,
      error: message,
    });
    wsSend(ws, { type: 'error', sessionId, message });
  };
  if (!sessionId || wsSessionMap.get(ws) !== sessionId) {
    return rejectResponse('当前页面不属于该 Codex 交互请求。');
  }
  const runtime = codexAppRuntimes.get(sessionId);
  const request = runtime?.pendingUi.get(requestId);
  if (!runtime?.client?.isAlive || !request) {
    return rejectResponse('该 Codex 交互请求已失效。');
  }

  let result;
  try {
    if (request.kind === 'command-approval' || request.kind === 'file-approval') {
      const fallback = request.approvalDecisions?.has('decline') ? 'decline' : 'cancel';
      const selected = msg.cancelled === true
        ? (request.approvalDecisions?.get('cancel') || request.approvalDecisions?.get('decline') || fallback)
        : request.approvalDecisions?.get(String(msg.value || ''));
      result = { decision: selected || fallback };
    } else if (request.kind === 'permissions') {
      const decision = msg.cancelled === true ? 'decline' : String(msg.value || 'decline');
      result = decision === 'grant-turn' || decision === 'grant-session'
        ? {
            permissions: request.params.permissions || {},
            scope: decision === 'grant-session' ? 'session' : 'turn',
          }
        : { permissions: {}, scope: 'turn' };
    } else if (request.kind === 'questions') {
      result = { answers: msg.cancelled === true ? {} : normalizeCodexQuestionAnswers(request, msg) };
    } else if (request.kind === 'elicitation') {
      if (msg.cancelled === true) result = { action: 'cancel', content: null };
      else if (msg.confirmed === false) result = { action: 'decline', content: null };
      else result = {
        action: 'accept',
        content: request.params.mode === 'url' ? null : codexElicitationContent(request, msg),
      };
    } else {
      return rejectResponse('不支持的 Codex 交互响应。');
    }
  } catch (error) {
    return rejectResponse(error.message || 'Codex 交互响应无效。', true);
  }

  runtime.client.respond(request.rpcId, result).then(() => {
    if (request.timeout) clearTimeout(request.timeout);
    runtime.pendingUi.delete(requestId);
    wsSend(ws, { type: 'interactive_response_result', sessionId, requestId, success: true });
  }).catch((error) => {
    wsSend(ws, {
      type: 'interactive_response_result',
      sessionId,
      requestId,
      success: false,
      retryable: true,
      error: error.message,
    });
    wsSend(ws, { type: 'error', sessionId, message: `Codex 交互响应失败：${error.message}` });
  });
}

function handleInteractiveResponse(ws, msg) {
  const requestId = String(msg?.requestId || '');
  if (requestId.startsWith('claude-')) handleClaudeStreamInteractiveResponse(ws, msg);
  else if (requestId.startsWith('codex-')) handleCodexAppInteractiveResponse(ws, msg);
  else handlePiRpcInteractiveResponse(ws, msg);
}

function sendCodexAppMessageRejected(ws, sessionId, clientMessageId, message, retryable = true) {
  wsSend(ws, {
    type: 'message_rejected',
    sessionId,
    clientMessageId: clientMessageId || null,
    retryable,
    error: message,
  });
}

function handleActiveCodexAppMessage(ws, msg, session, entry, resolvedAttachments, savedAttachments, textValue) {
  const sessionId = session.id;
  const runtime = entry.appRuntime || codexAppRuntimes.get(sessionId);
  const clientMessageId = normalizeClientMessageId(msg.clientMessageId);
  if (msg.streamingBehavior !== 'steer') {
    sendCodexAppMessageRejected(ws, sessionId, clientMessageId, 'Codex 正在生成；当前只支持“转向”输入。', false);
    return;
  }
  if (!runtime?.client?.isAlive || !runtime.turnId) {
    sendCodexAppMessageRejected(ws, sessionId, clientMessageId, 'Codex App Server 尚未准备好接收转向输入。');
    return;
  }
  entry.ws = ws;
  entry.wsDisconnectTime = null;
  wsSessionMap.set(ws, sessionId);
  runtime.client.request('turn/steer', {
    threadId: runtime.threadId,
    expectedTurnId: runtime.turnId,
    input: codexAppInput(textValue, resolvedAttachments),
    clientUserMessageId: clientMessageId || null,
  }, { timeoutMs: 30_000 }).then(() => {
    if (activeProcesses.get(sessionId) !== entry) {
      sendCodexAppMessageRejected(ws, sessionId, clientMessageId, '当前 Codex 任务已经结束。', false);
      return;
    }
    session.messages.push({
      role: 'user',
      content: textValue,
      attachments: savedAttachments,
      timestamp: new Date().toISOString(),
      streamingBehavior: 'steer',
    });
    session.updated = new Date().toISOString();
    saveSession(session);
    const ack = { execution: 'codex-steer', streamingBehavior: 'steer' };
    if (clientMessageId) rememberAcceptedClientMessage(sessionId, clientMessageId, ack);
    sendMessageAccepted(ws, sessionId, clientMessageId, ack);
  }).catch((error) => {
    sendCodexAppMessageRejected(ws, sessionId, clientMessageId, `Codex 未接收转向输入：${error.message}`);
  });
}

function sendPiRpcMessageRejected(ws, sessionId, clientMessageId, message, retryable = true) {
  wsSend(ws, {
    type: 'message_rejected',
    sessionId,
    clientMessageId: clientMessageId || null,
    retryable,
    error: message,
  });
}

function handleActivePiRpcMessage(ws, msg, session, entry, resolvedAttachments, savedAttachments, textValue) {
  const sessionId = session.id;
  const runtime = entry.rpcRuntime || piRpcRuntimes.get(sessionId);
  const clientMessageId = normalizeClientMessageId(msg.clientMessageId);
  const streamingBehavior = msg.streamingBehavior === 'steer'
    ? 'steer'
    : msg.streamingBehavior === 'followUp'
      ? 'followUp'
      : null;
  if (!streamingBehavior) {
    sendPiRpcMessageRejected(
      ws,
      sessionId,
      clientMessageId,
      'Pi 正在生成，请选择“转向”或“接着做”后再发送。',
      false,
    );
    return;
  }
  if (!runtime?.client?.isAlive || entry.rpcCompleted) {
    sendPiRpcMessageRejected(ws, sessionId, clientMessageId, 'Pi RPC 连接正在切换，请稍后重试。');
    return;
  }

  const requestKey = clientMessageId || `pi-${crypto.randomUUID()}`;
  const inflight = entry.rpcQueuedRequests.get(requestKey);
  if (inflight) {
    inflight.waiters.add(ws);
    return;
  }

  entry.ws = ws;
  entry.wsDisconnectTime = null;
  wsSessionMap.set(ws, sessionId);
  const record = {
    id: requestKey,
    clientMessageId,
    text: textValue,
    savedAttachments,
    streamingBehavior,
    status: 'submitting',
    observedQueued: false,
    accepted: false,
    started: false,
    immediate: false,
    waiters: new Set([ws]),
  };
  entry.rpcQueuedMessages.push(record);
  entry.rpcQueuedRequests.set(requestKey, record);

  const images = piRpcPromptImages(resolvedAttachments);
  record.promise = runtime.client.request({
    type: 'prompt',
    message: String(textValue || ''),
    streamingBehavior,
    ...(images.length > 0 ? { images } : {}),
  }, { timeoutMs: 60_000 }).then(() => {
    if (entry.abortRequested) {
      entry.rpcQueuedRequests.delete(requestKey);
      entry.rpcQueuedMessages = entry.rpcQueuedMessages.filter((item) => item !== record);
      for (const waiter of record.waiters) {
        sendPiRpcMessageRejected(waiter, sessionId, clientMessageId, '当前任务已停止，这条排队消息未执行。', false);
      }
      return;
    }
    record.accepted = true;
    // Pi extension commands execute immediately during streaming and therefore
    // never enter either native queue. Other slash inputs (skills/templates) do.
    record.immediate = String(record.text || '').trim().startsWith('/') && !record.observedQueued && !record.started;
    record.status = record.immediate ? 'handled' : (record.started ? 'started' : 'queued');
    const ack = record.immediate
      ? { execution: 'local' }
      : { execution: 'pi-queue', streamingBehavior };
    if (clientMessageId) rememberAcceptedClientMessage(sessionId, clientMessageId, ack);
    for (const waiter of record.waiters) {
      sendMessageAccepted(waiter, sessionId, clientMessageId, ack);
    }
    if (record.immediate) {
      entry.rpcQueuedMessages = entry.rpcQueuedMessages.filter((item) => item !== record);
    }
    entry.rpcQueuedRequests.delete(requestKey);
    sendPiRpcQueueState(entry);
  }).catch((error) => {
    entry.rpcQueuedRequests.delete(requestKey);
    entry.rpcQueuedMessages = entry.rpcQueuedMessages.filter((item) => item !== record);
    for (const waiter of record.waiters) {
      sendPiRpcMessageRejected(
        waiter,
        sessionId,
        clientMessageId,
        `Pi 未接收这条消息：${error.message || String(error)}`,
      );
    }
    sendPiRpcQueueState(entry);
  });
}

// === Runtime Message Handler ===
function handleMessage(ws, msg, options = {}) {
  const { text, sessionId, mode } = msg;
  const { hideInHistory = false } = options;
  const textValue = typeof text === 'string' ? text : '';
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const normalizedText = textValue.trim();
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    const activeEntry = sessionId ? activeProcesses.get(sessionId) : null;
    if (activeEntry?.transport === 'pi-rpc') {
      sendPiRpcMessageRejected(
        ws,
        sessionId,
        normalizeClientMessageId(msg.clientMessageId),
        '图片附件已过期或不可用，请重新上传后再发送。',
        false,
      );
      return;
    }
    return wsSend(ws, { type: 'error', message: '图片附件已过期或不可用，请重新上传后再发送。' });
  }
  if (!normalizedText && resolvedAttachments.length === 0) return;

  const savedAttachments = resolvedAttachments.map((attachment) => ({
    id: attachment.id,
    kind: 'image',
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
    storageState: attachment.storageState,
  }));

  const clientMessageIdEarly = normalizeClientMessageId(msg.clientMessageId);
  if (sessionId && clientMessageIdEarly && wasClientMessageAccepted(sessionId, clientMessageIdEarly)) {
    sendMessageAccepted(
      ws,
      sessionId,
      clientMessageIdEarly,
      getAcceptedClientMessageAck(sessionId, clientMessageIdEarly),
    );
    return;
  }

  if (sessionId && (piForkOperations.has(sessionId) || codexForkOperations.has(sessionId))) {
    wsSend(ws, {
      type: 'message_rejected',
      sessionId,
      clientMessageId: clientMessageIdEarly || null,
      retryable: true,
      error: '当前会话正在创建分支，请稍候重试。',
    });
    return;
  }

  if (sessionId && activeProcesses.has(sessionId)) {
    const runningSession = loadSession(sessionId);
    const runningEntry = activeProcesses.get(sessionId);
    if (
      runningSession
      && runningEntry
      && getSessionAgent(runningSession) === 'pi'
      && runningEntry.transport === 'pi-rpc'
    ) {
      handleActivePiRpcMessage(
        ws,
        msg,
        runningSession,
        runningEntry,
        resolvedAttachments,
        savedAttachments,
        textValue,
      );
      return;
    }
    if (
      runningSession
      && runningEntry
      && getSessionAgent(runningSession) === 'codex'
      && runningEntry.transport === 'codex-app-server'
    ) {
      handleActiveCodexAppMessage(
        ws,
        msg,
        runningSession,
        runningEntry,
        resolvedAttachments,
        savedAttachments,
        textValue,
      );
      return;
    }
    return wsSend(ws, { type: 'error', sessionId, message: '正在处理中，请先点击停止按钮。' });
  }

  const derivedTitle = normalizedText
    ? textValue.slice(0, 60).replace(/\n/g, ' ')
    : `图片: ${savedAttachments[0]?.filename || 'image'}`;

  const clientMessageId = normalizeClientMessageId(msg.clientMessageId);

  let session;
  if (sessionId) session = loadSession(sessionId);

  // Idempotent accept BEFORE mutating history / spawning.
  if (session && clientMessageId && wasClientMessageAccepted(session.id, clientMessageId)) {
    sendMessageAccepted(ws, session.id, clientMessageId, getAcceptedClientMessageAck(session.id, clientMessageId));
    return;
  }

  if (!session) {
    const id = crypto.randomUUID();
    const agent = normalizeAgent(msg.agent);
    const resolvedCwd = agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null;
    session = {
      id,
      title: derivedTitle,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      agent,
      claudeSessionId: null,
      codexThreadId: null,
      piSessionId: null,
      runtimeContexts: { claude: {}, codex: {}, pi: {} },
      model: null,
      permissionMode: mode || 'yolo',
      totalCost: 0,
      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      messages: [],
      cwd: resolvedCwd,
    };
  }
  normalizeSession(session);

  if (normalizedText.startsWith('/') && resolvedAttachments.length > 0) {
    return wsSend(ws, { type: 'error', message: '命令消息暂不支持同时附带图片。请先发送图片说明，再单独使用 /model 或 /mode。' });
  }

  if (mode && ['default', 'plan', 'yolo'].includes(mode)) {
    session.permissionMode = mode;
  }

  if (!hideInHistory && normalizedText !== '/compact' && getRuntimeSessionId(session)) {
    pendingCompactRetries.set(session.id, { text: normalizedText, mode: session.permissionMode || 'yolo', reason: 'normal', autoRetryCount: 0 });
  }

  if (session.title === 'New Chat' || session.title === 'Untitled') {
    session.title = derivedTitle;
  }

  if (!hideInHistory) {
    session.messages.push({
      role: 'user',
      content: textValue,
      attachments: savedAttachments,
      timestamp: new Date().toISOString(),
    });
  }
  session.updated = new Date().toISOString();
  saveSession(session);

  const currentSessionId = session.id;
  if (clientMessageId) {
    const ack = { execution: 'turn' };
    rememberAcceptedClientMessage(currentSessionId, clientMessageId, ack);
    sendMessageAccepted(ws, currentSessionId, clientMessageId, ack);
  }

  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }
  wsSessionMap.set(ws, currentSessionId);

  if (!sessionId) {
    // Mark isRunning true before spawn so the client can preserve optimistic
    // streaming UI when the first session_info arrives for a brand-new chat.
    wsSend(ws, {
      type: 'session_info',
      sessionId: currentSessionId,
      messages: session.messages,
      title: session.title,
      mode: session.permissionMode || 'yolo',
      model: sessionModelLabel(session),
      agent: getSessionAgent(session),
      cwd: session.cwd || null,
      totalCost: session.totalCost || 0,
      totalUsage: session.totalUsage || null,
      updated: session.updated,
      hasUnread: false,
      historyPending: false,
      isRunning: true,
      ...buildSessionRuntimeMeta(session),
    });
  }
  sendSessionList(ws);

  const sessionAgent = getSessionAgent(session);
  const codexReviewMatch = sessionAgent === 'codex'
    ? normalizedText.match(/^\/review(?:\s+([\s\S]*))?$/i)
    : null;
  const spawnSpec = sessionAgent === 'codex'
    ? buildCodexSpawnSpec(session, {
        attachments: resolvedAttachments,
        review: codexReviewMatch ? { instructions: codexReviewMatch[1] || '' } : null,
        transport: CODEX_TRANSPORT,
      })
    : sessionAgent === 'pi'
      ? buildPiSpawnSpec(session, {
          attachments: resolvedAttachments,
          transport: PI_TRANSPORT,
        })
      : buildClaudeSpawnSpec(session, { attachments: resolvedAttachments });
  if (spawnSpec?.error) {
    // New-chat session_info may have advertised isRunning=true; clear client state.
    wsSend(ws, { type: 'error', sessionId: currentSessionId, message: spawnSpec.error });
    return wsSend(ws, { type: 'done', sessionId: currentSessionId, costUsd: null });
  }
  const shouldInjectCarryover = !!(spawnSpec?.threadReset && !hideInHistory && !normalizedText.startsWith('/'));
  const carryoverHistory = shouldInjectCarryover
    ? (Array.isArray(session.messages) ? session.messages.slice(0, -1) : [])
    : [];
  const threadCarryover = shouldInjectCarryover
    ? buildThreadCarryoverPayload(session, textValue, resolvedAttachments, carryoverHistory, spawnSpec.threadReset)
    : null;
  if (spawnSpec?.warningMessage) {
    wsSend(ws, { type: 'system_message', sessionId: currentSessionId, message: spawnSpec.warningMessage });
  }
  if (spawnSpec?.threadReset) {
    wsSend(ws, { type: 'system_message', sessionId: currentSessionId, message: buildThreadCarryoverNotice(threadCarryover) });
  }
  const runtimeInputText = threadCarryover?.prompt
    || (Object.prototype.hasOwnProperty.call(spawnSpec, 'inputText') ? spawnSpec.inputText : textValue);

  if (sessionAgent === 'pi' && spawnSpec.transport === 'rpc') {
    startPiRpcTurn(ws, session, spawnSpec, resolvedAttachments, runtimeInputText);
    return;
  }
  if (sessionAgent === 'codex' && spawnSpec.transport === 'app-server') {
    startCodexAppTurn(ws, session, spawnSpec, resolvedAttachments, runtimeInputText);
    return;
  }
  if (sessionAgent === 'claude' && CLAUDE_TRANSPORT === 'stream-json') {
    startClaudeStreamTurn(ws, session, spawnSpec, resolvedAttachments, runtimeInputText);
    return;
  }

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  if (isClaudeSession(session)) {
    const content = claudeStreamContent(runtimeInputText, resolvedAttachments);
    fs.writeFileSync(inputPath, `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })}\n`);
  } else {
    fs.writeFileSync(inputPath, runtimeInputText);
  }

  const runId = crypto.randomUUID();
  const inputFd = fs.openSync(inputPath, 'r');
  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  function finalizeSpawnFailure(errMessage) {
    try {
      const active = activeProcesses.get(currentSessionId);
      if (active?.tailer) {
        try { active.tailer.stop(); } catch {}
      }
      removeActiveProcess(currentSessionId);
    } catch {}
    try { cleanRunDir(currentSessionId); } catch {}
    const agent = getSessionAgent(session);
    const message = formatRuntimeError(agent, errMessage, { exitCode: null, signal: null });
    wsSend(ws, { type: 'error', sessionId: currentSessionId, message });
    wsSend(ws, { type: 'done', sessionId: currentSessionId, costUsd: null });
    sendSessionList(ws);
  }

  let proc;
  let entry = null;
  try {
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: [inputFd, outputFd, errorFd],
      detached: !IS_WIN,
      windowsHide: true,
      shell: !!spawnSpec.useShell,
    });
  } catch (err) {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    plog('ERROR', 'process_spawn_fail', { sessionId: currentSessionId.slice(0, 8), error: err.message });
    finalizeSpawnFailure(err.message);
    return;
  }

  fs.closeSync(inputFd);
  fs.closeSync(outputFd);
  fs.closeSync(errorFd);

  // Handle spawn errors (e.g. ENOENT when CLI binary not found) — must be registered
  // immediately after spawn, before any async work, to avoid unhandled 'error' event crash.
  proc.on('error', (err) => {
    plog('ERROR', 'process_spawn_fail', { sessionId: currentSessionId.slice(0, 8), error: err.message });
    finalizeSpawnFailure(err.message);
  });

  fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
  writeRunMeta(currentSessionId, {
    runId,
    pid: proc.pid,
    permissionMode: spawnSpec.mode || session.permissionMode || 'yolo',
    agent: getSessionAgent(session),
    detached: !IS_WIN,
    startedAt: new Date().toISOString(),
  });
  proc.unref(); // Process survives Node.js exit

  plog('INFO', 'process_spawn', {
    sessionId: currentSessionId.slice(0, 8),
    pid: proc.pid,
    agent: getSessionAgent(session),
    mode: spawnSpec.mode,
    model: session.model || 'default',
    resume: spawnSpec.resume,
    threadResetReason: spawnSpec.threadReset?.reason || null,
    carryover: threadCarryover
      ? {
          summaryDetailed: threadCarryover.summaryDetailed,
          recentCount: threadCarryover.recentCount,
          historyCount: threadCarryover.historyCount,
        }
      : null,
    args: spawnSpec.args.join(' '),
  });

  // Fast exit detection (while Node.js is running)
  proc.on('exit', (code, signal) => {
    if (entry) {
      entry.pendingProcessComplete = true;
      entry.pendingExitCode = code;
      entry.pendingSignal = signal;
    }
    plog('INFO', 'process_exit_event', {
      sessionId: currentSessionId.slice(0, 8),
      pid: proc.pid,
      exitCode: code,
      signal: signal,
    });
    // Small delay to ensure file is fully flushed
    setTimeout(() => handleProcessComplete(currentSessionId, code, signal), 300);
  });

  entry = createRuntimeEntry(session, ws, spawnSpec, resolvedAttachments, proc.pid);
  entry.runId = runId;
  setActiveProcess(currentSessionId, entry);
  sendSessionList(ws);

  // Tail the output file for real-time streaming
  entry.tailer = new FileTailer(outputPath, (line) => {
    try {
      const event = JSON.parse(line);
      processRuntimeEvent(entry, event, currentSessionId);
    } catch {}
  });
  entry.tailer.start();
}

function truncateObj(obj, maxLen) {
  const s = JSON.stringify(obj);
  if (s.length <= maxLen) return obj;
  return s.slice(0, maxLen) + '...';
}

function safeJsonParse(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return input;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function sanitizeToolInput(toolName, input) {
  const parsed = safeJsonParse(input);
  if (toolName === 'AskUserQuestion') {
    return parsed;
  }
  return truncateObj(parsed, 500);
}

const {
  buildClaudeSpawnSpec,
  buildClaudeEnv,
  shouldUseShellForCommand,
  buildCodexSpawnSpec,
  buildPiSpawnSpec,
  processRuntimeEvent,
} = createAgentRuntime({
  processEnv: process.env,
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
  getPiRuntimeFingerprint,
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
  clearRuntimeSessionId,
  runtimeFingerprintsCompatible,
  onSlashCommandsDiscovered,
  plog,
});

// === Check Update ===
function handleCheckUpdate(ws) {
  const localVersion = PACKAGE_VERSION;

  const https = require('https');
  const options = {
    hostname: 'raw.githubusercontent.com',
    path: '/HsMirage/webcoding/main/CHANGELOG.md',
    headers: { 'User-Agent': 'webcoding-update-check' },
    timeout: 10000,
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'update_info', localVersion, error: `HTTP ${res.statusCode}` });
      }
      const m = body.match(/##\s*v([\d.]+)/) || body.match(/\*\*v([\d.]+)\*\*/);
      const latest = m ? m[1] : null;
      if (!latest) {
        return wsSend(ws, { type: 'update_info', localVersion, error: '无法解析远端版本号' });
      }
      const hasUpdate = latest !== localVersion;
      wsSend(ws, {
        type: 'update_info',
        localVersion,
        latestVersion: latest,
        hasUpdate,
        releaseUrl: 'https://github.com/HsMirage/webcoding',
      });
    });
  });
  req.on('error', (e) => {
    wsSend(ws, { type: 'update_info', localVersion, error: '网络请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'update_info', localVersion, error: '请求超时' });
  });
  req.end();
}

// === Native Session Import ===

const CLAUDE_PROJECTS_DIR = path.join(getClaudeConfigDir(), 'projects');
const CODEX_SESSIONS_DIR = path.join(getUserCodexHome(), 'sessions');
const CODEX_RUNTIME_SESSIONS_DIR = path.join(CODEX_RUNTIME_HOME, 'sessions');
const CODEX_STATE_DB_PATH = path.join(getUserCodexHome(), 'state_5.sqlite');
const CODEX_LOG_DB_PATH = path.join(getUserCodexHome(), 'logs_1.sqlite');
const CODEX_RUNTIME_STATE_DB_PATH = path.join(CODEX_RUNTIME_HOME, 'state_5.sqlite');
const CODEX_RUNTIME_LOG_DB_PATH = path.join(CODEX_RUNTIME_HOME, 'logs_1.sqlite');
const PI_NATIVE_SESSIONS_DIR = getUserPiSessionsDir();

function resolveClaudeSessionLocalMeta(claudeSessionId) {
  if (!claudeSessionId) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((dir) => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, dir)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sanitizeId(claudeSessionId)}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let cwd = null;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed);
            if (entry.type === 'user' && entry.cwd) {
              cwd = entry.cwd;
              break;
            }
          } catch {}
        }
        return { cwd, projectDir: dir, filePath };
      } catch {}
    }
  } catch {}
  return null;
}

function parseJsonlToMessages(lines) {
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type === 'user') {
      const raw = entry.message?.content;
      let content = '';
      if (typeof raw === 'string') {
        content = raw;
      } else if (Array.isArray(raw)) {
        // skip tool_result blocks, only take text blocks
        content = raw
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }
      if (content.trim()) {
        messages.push({ role: 'user', content, timestamp: entry.timestamp || null });
      }
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      let content = '';
      const toolCalls = [];
      const segments = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          content += b.text;
          const last = segments[segments.length - 1];
          if (last && last.type === 'text') last.text = `${last.text || ''}${b.text}`;
          else segments.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          const tc = { name: b.name, id: b.id, input: b.input, done: true };
          toolCalls.push(tc);
          segments.push({ type: 'tool_call', ...tc });
        } else if (b.type === 'tool_result') {
          const resultText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((item) => item.text || '').join('\n')
              : JSON.stringify(b.content || '');
          const tc = toolCalls.find((item) => item.id === b.tool_use_id);
          if (tc) tc.result = resultText.slice(0, 2000);
          const segment = segments.find((item) => item.type === 'tool_call' && item.id === b.tool_use_id);
          if (segment) segment.result = resultText.slice(0, 2000);
        }
        // skip thinking blocks
      }
      if (content.trim() || toolCalls.length > 0) {
        messages.push({ role: 'assistant', content, toolCalls, segments, timestamp: entry.timestamp || null });
      }
    }
    // skip other types
  }
  return messages;
}

const {
  getCodexRolloutFiles,
  getImportedCodexThreadIds,
  parseCodexRolloutFile,
} = createCodexRolloutStore({
  codexSessionsDir: CODEX_SESSIONS_DIR,
  codexRuntimeSessionsDir: CODEX_RUNTIME_SESSIONS_DIR,
  sessionsDir: SESSIONS_DIR,
  normalizeSession,
  sanitizeToolInput,
});

function getImportedSessionIds() {
  const now = Date.now();
  if (importedSessionIdsCache.expiresAt > now) {
    return importedSessionIdsCache.ids;
  }
  const imported = new Set();
  try {
    const files = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
    for (const f of files) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        for (const runtimeId of getAllRuntimeSessionIds(s, 'claude')) {
          imported.add(String(runtimeId));
        }
      } catch {}
    }
  } catch {}
  importedSessionIdsCache.ids = imported;
  importedSessionIdsCache.expiresAt = now + IMPORTED_SESSION_IDS_CACHE_TTL_MS;
  return imported;
}

function readFileSliceUtf8(filePath, start, length) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeLength = Math.max(0, Number(length) || 0);
  if (safeLength <= 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(safeLength);
    const bytesRead = fs.readSync(fd, buffer, 0, safeLength, safeStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function extractNativeSessionHeadMeta(filePath, sessionId) {
  const fallbackTitle = sessionId.slice(0, 20);
  const headText = readFileSliceUtf8(filePath, 0, JSONL_HEAD_READ_BYTES);
  const lines = headText.split('\n');
  let title = fallbackTitle;
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type !== 'user') continue;
      if (!cwd) cwd = e.cwd || null;
      const raw = e.message?.content;
      let text = '';
      if (typeof raw === 'string') text = raw;
      else if (Array.isArray(raw)) text = raw.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      if (text.trim()) {
        title = text.trim().slice(0, 80).replace(/\n/g, ' ');
        break;
      }
    } catch {}
  }
  return { title, cwd };
}

function extractNativeSessionUpdatedAt(filePath, fileSize, fallbackIso) {
  const size = Number(fileSize) || 0;
  if (size <= 0) return fallbackIso || null;
  const readBytes = Math.min(size, JSONL_TAIL_READ_BYTES);
  const start = size - readBytes;
  const tailText = readFileSliceUtf8(filePath, start, readBytes);
  const lines = tailText.split('\n');
  if (start > 0 && lines.length > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e?.timestamp) return e.timestamp;
    } catch {}
  }
  return fallbackIso || null;
}

function handleListNativeSessions(ws) {
  const groups = [];
  try {
    const imported = getImportedSessionIds();
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    // Decode dir name to real path and merge duplicates
    const mergedMap = new Map(); // decodedKey -> { dir, sessions[] }
    for (const dirEntry of dirs) {
      const dir = dirEntry.name;
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      // Decode: Claude encodes /a/b/c as -a-b-c
      let decodedKey = dir;
      if (dir.startsWith('-') && !dir.includes('/') && !dir.includes('\\')) {
        decodedKey = '/' + dir.split('-').filter(Boolean).join('/');
      }
      const sessionItems = [];
      try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
        for (const fileEntry of files) {
          const sessionId = fileEntry.name.replace('.jsonl', '');
          const filePath = path.join(dirPath, fileEntry.name);
          try {
            const stat = fs.statSync(filePath);
            const fallbackUpdatedAt = stat.mtime ? stat.mtime.toISOString() : null;
            const meta = extractNativeSessionHeadMeta(filePath, sessionId);
            const updatedAt = extractNativeSessionUpdatedAt(filePath, stat.size, fallbackUpdatedAt);
            sessionItems.push({
              sessionId,
              title: meta.title,
              cwd: meta.cwd,
              updatedAt,
              alreadyImported: imported.has(sessionId),
            });
          } catch {}
        }
      } catch {}
      if (sessionItems.length > 0) {
        if (mergedMap.has(decodedKey)) {
          mergedMap.get(decodedKey).sessions.push(...sessionItems);
        } else {
          mergedMap.set(decodedKey, { dir, sessions: sessionItems });
        }
      }
    }
    for (const { dir, sessions } of mergedMap.values()) {
      sessions.sort((a, b) => {
        if (!a.updatedAt) return 1;
        if (!b.updatedAt) return -1;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });
      groups.push({ dir, sessions });
    }
  } catch {}
  wsSend(ws, { type: 'native_sessions', groups });
}

function handleImportNativeSession(ws, msg) {
  const { sessionId, projectDir } = msg;
  if (!sessionId || !projectDir) {
    return wsSend(ws, { type: 'error', message: '缺少 sessionId 或 projectDir' });
  }
  const filePath = path.join(CLAUDE_PROJECTS_DIR, String(projectDir), `${sanitizeId(sessionId)}.jsonl`);
  if (!isPathInside(filePath, CLAUDE_PROJECTS_DIR)) {
    return wsSend(ws, { type: 'error', message: '非法路径' });
  }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return wsSend(ws, { type: 'error', message: '无法读取会话文件' });
  }
  const lines = content.split('\n');
  const messages = parseJsonlToMessages(lines);

  // Find or create webcoding session with this claudeSessionId
  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (sessionHasRuntimeId(s, 'claude', sessionId)) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  // Determine title and cwd from messages/raw
  let title = sessionId.slice(0, 20);
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'user') {
        if (!cwd) cwd = e.cwd || null;
        const raw = e.message?.content;
        let text = '';
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
        if (text.trim()) { title = text.trim().slice(0, 60).replace(/\n/g, ' '); break; }
      }
    } catch {}
  }

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title,
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'claude',
    claudeSessionId: sessionId,
    codexThreadId: null,
    runtimeContexts: existingSession?.runtimeContexts || { claude: {}, codex: {} },
    importedFrom: projectDir,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages,
    cwd: cwd || existingSession?.cwd || null,
  };
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) session.projectId = ensured.project.id;
  }
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    imported: true,
    ...buildSessionRuntimeMeta(session),
  });
  sendSessionList(ws);
}

function handleListCodexSessions(ws) {
  const imported = getImportedCodexThreadIds();
  const cwdMap = new Map(); // cwd -> items[]
  const seen = new Set();
  for (const filePath of getCodexRolloutFiles()) {
    const parsed = parseCodexRolloutFile(filePath);
    if (!parsed?.meta?.threadId) continue;
    if (seen.has(parsed.meta.threadId)) continue;
    seen.add(parsed.meta.threadId);
    const title = parsed.meta.title || parsed.meta.threadId.slice(0, 20);
    const cwd = parsed.meta.cwd || '/unknown';
    if (!cwdMap.has(cwd)) cwdMap.set(cwd, []);
    cwdMap.get(cwd).push({
      threadId: parsed.meta.threadId,
      title,
      cwd: parsed.meta.cwd || null,
      updatedAt: parsed.meta.updatedAt || null,
      cliVersion: parsed.meta.cliVersion || '',
      source: (() => {
        const s = parsed.meta.source;
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object') return s.name || s.type || JSON.stringify(s);
        return '';
      })(),
      rolloutPath: filePath,
      alreadyImported: imported.has(parsed.meta.threadId),
    });
  }
  const groups = [];
  for (const [cwd, sessions] of cwdMap.entries()) {
    sessions.sort((a, b) => {
      if (!a.updatedAt) return 1;
      if (!b.updatedAt) return -1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    groups.push({ cwd, sessions });
  }
  wsSend(ws, { type: 'codex_sessions', groups });
}

function handleImportCodexSession(ws, msg) {
  const threadId = String(msg?.threadId || '').trim();
  if (!threadId) {
    return wsSend(ws, { type: 'error', message: '缺少 threadId' });
  }

  let parsed = null;
  const requestedPath = msg?.rolloutPath ? path.resolve(String(msg.rolloutPath)) : '';
  if (requestedPath && (isPathInside(requestedPath, CODEX_SESSIONS_DIR) || isPathInside(requestedPath, CODEX_RUNTIME_SESSIONS_DIR)) && fs.existsSync(requestedPath)) {
    parsed = parseCodexRolloutFile(requestedPath);
  }
  if (!parsed) {
    for (const filePath of getCodexRolloutFiles()) {
      const candidate = parseCodexRolloutFile(filePath);
      if (candidate?.meta?.threadId === threadId) {
        parsed = candidate;
        break;
      }
    }
  }

  if (!parsed || parsed.meta.threadId !== threadId) {
    return wsSend(ws, { type: 'error', message: '未找到对应的 Codex 会话文件' });
  }

  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (sessionHasRuntimeId(s, 'codex', threadId)) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title: parsed.meta.title || existingSession?.title || threadId.slice(0, 20),
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'codex',
    claudeSessionId: null,
    codexThreadId: threadId,
    runtimeContexts: existingSession?.runtimeContexts || { claude: {}, codex: {} },
    importedFrom: 'codex',
    importedRolloutPath: parsed.filePath,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: parsed.totalUsage || existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: parsed.messages,
    cwd: parsed.meta.cwd || existingSession?.cwd || null,
  };
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) session.projectId = ensured.project.id;
  }
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    imported: true,
    ...buildSessionRuntimeMeta(session),
  });
  sendSessionList(ws);
}

function getImportedPiSessionIds() {
  const imported = new Set();
  try {
    const files = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    for (const file of files) {
      try {
        const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file.name), 'utf8')));
        for (const runtimeId of getAllRuntimeSessionIds(session, 'pi')) imported.add(String(runtimeId));
      } catch {}
    }
  } catch {}
  return imported;
}

function handleListPiSessions(ws) {
  const imported = getImportedPiSessionIds();
  const cwdMap = new Map();
  const seen = new Set();
  for (const filePath of getPiSessionFiles(PI_NATIVE_SESSIONS_DIR)) {
    const summary = summarizePiSessionFile(filePath);
    if (!summary?.sessionId || seen.has(summary.sessionId)) continue;
    seen.add(summary.sessionId);
    const cwd = summary.cwd || '/unknown';
    if (!cwdMap.has(cwd)) cwdMap.set(cwd, []);
    cwdMap.get(cwd).push({
      ...summary,
      alreadyImported: imported.has(summary.sessionId),
    });
  }
  const groups = [...cwdMap.entries()].map(([cwd, sessions]) => ({
    cwd,
    sessions: sessions.sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      return rightTime - leftTime;
    }),
  }));
  groups.sort((left, right) => {
    const leftTime = left.sessions[0]?.updatedAt ? Date.parse(left.sessions[0].updatedAt) : 0;
    const rightTime = right.sessions[0]?.updatedAt ? Date.parse(right.sessions[0].updatedAt) : 0;
    return rightTime - leftTime;
  });
  wsSend(ws, { type: 'pi_sessions', groups });
}

function findPiNativeSessionFile(sessionId, requestedPath = '') {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) return null;
  const candidate = requestedPath ? path.resolve(String(requestedPath)) : '';
  if (
    candidate
    && isPathInside(candidate, PI_NATIVE_SESSIONS_DIR)
    && candidate.endsWith('.jsonl')
    && fs.existsSync(candidate)
  ) {
    const summary = summarizePiSessionFile(candidate);
    if (summary?.sessionId === normalizedId) return candidate;
  }
  for (const filePath of getPiSessionFiles(PI_NATIVE_SESSIONS_DIR)) {
    const summary = summarizePiSessionFile(filePath);
    if (summary?.sessionId === normalizedId) return filePath;
  }
  return null;
}

function copyPiSessionIntoWebStorage(sourcePath, webSessionId, nativeSessionId) {
  const targetDir = piSessionDir(webSessionId);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const target = path.join(targetDir, entry.name);
    const summary = summarizePiSessionFile(target);
    if (summary?.sessionId === nativeSessionId) fs.unlinkSync(target);
  }
  const targetPath = path.join(targetDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function handleImportPiSession(ws, msg) {
  const nativeSessionId = String(msg?.sessionId || '').trim();
  if (!nativeSessionId) {
    return wsSend(ws, { type: 'error', message: '缺少 Pi sessionId' });
  }
  const sourcePath = findPiNativeSessionFile(nativeSessionId, msg?.sessionPath || '');
  if (!sourcePath) {
    return wsSend(ws, { type: 'error', message: '未找到对应的 Pi 原生会话文件' });
  }
  const parsed = parsePiSessionFile(sourcePath);
  if (!parsed || parsed.meta.sessionId !== nativeSessionId) {
    return wsSend(ws, { type: 'error', message: 'Pi 会话文件无效或已损坏' });
  }

  let existingSession = null;
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR).filter((name) => name.endsWith('.json'))) {
      try {
        const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')));
        if (sessionHasRuntimeId(session, 'pi', nativeSessionId)) {
          existingSession = session;
          break;
        }
      } catch {}
    }
  } catch {}

  if (existingSession && activeProcesses.has(existingSession.id)) {
    return wsSend(ws, { type: 'error', message: '该 Pi 会话正在运行，请结束当前轮次后再重新导入' });
  }
  if (existingSession) disposePiRpcRuntime(existingSession.id, 'session_reimported');

  const id = existingSession?.id || crypto.randomUUID();
  let importedPath;
  try {
    importedPath = copyPiSessionIntoWebStorage(sourcePath, id, nativeSessionId);
  } catch (error) {
    return wsSend(ws, { type: 'error', message: `复制 Pi 会话失败：${error.message || error}` });
  }

  const now = new Date().toISOString();
  const session = normalizeSession({
    id,
    title: parsed.meta.title || existingSession?.title || nativeSessionId.slice(0, 20),
    created: existingSession?.created || parsed.meta.createdAt || now,
    updated: now,
    agent: 'pi',
    claudeSessionId: null,
    codexThreadId: null,
    piSessionId: nativeSessionId,
    runtimeContexts: existingSession?.runtimeContexts || { claude: {}, codex: {}, pi: {} },
    importedFrom: 'pi',
    importedPiSessionPath: importedPath,
    importedPiSourcePath: sourcePath,
    model: existingSession?.model || null,
    thinking: existingSession?.thinking || parsed.meta.thinkingLevel || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: parsed.totalCost || 0,
    totalUsage: parsed.totalUsage,
    messages: parsed.messages,
    cwd: parsed.meta.cwd || existingSession?.cwd || null,
    projectId: existingSession?.projectId || null,
  });
  const piConfig = loadPiConfig();
  const descriptor = buildPiRuntimeChannelDescriptor(session, { piConfig });
  const channelKey = buildRuntimeChannelKey('pi', descriptor);
  setRuntimeSessionState(session, {
    runtimeId: nativeSessionId,
    runtimeFingerprint: getPiRuntimeFingerprint(piConfig),
    channelDescriptor: descriptor,
  }, {
    agent: 'pi',
    channelKey,
    channelDescriptor: descriptor,
  });
  if (session.cwd && !session.projectId) {
    const ensured = ensureProjectForPath(session.cwd);
    if (ensured.project?.id) session.projectId = ensured.project.id;
  }
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: 'pi',
    cwd: session.cwd,
    projectId: session.projectId,
    totalCost: session.totalCost,
    totalUsage: session.totalUsage,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    imported: true,
    ...buildSessionRuntimeMeta(session),
  });
  sendSessionList(ws);
}

function handleListCwdSuggestions(ws) {
  const paths = new Set();
  // Always include HOME
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) paths.add(home);
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const session = loadSession(file.replace(/\.json$/, ''));
      if (!session) continue;
      const preferredClaudeRuntimeId = getSessionAgent(session) === 'claude'
        ? getPreferredRuntimeSessionId(session, 'claude')
        : null;
      const localMeta = getSessionAgent(session) === 'claude' && preferredClaudeRuntimeId && !session.cwd
        ? resolveClaudeSessionLocalMeta(preferredClaudeRuntimeId)
        : null;
      const cwd = session.cwd || localMeta?.cwd || activeProcesses.get(session.id)?.cwd || null;
      if (cwd) paths.add(cwd);
    }
  } catch {}
  for (const entry of activeProcesses.values()) {
    if (entry.cwd) paths.add(entry.cwd);
  }
  wsSend(ws, { type: 'cwd_suggestions', paths: Array.from(paths).sort() });
}

// === Project Handlers ===
function handleSaveProject(ws, msg) {
  const config = loadProjectsConfig();
  const projectPath = msg.path ? normalizeProjectPathKey(msg.path) : null;
  const projectName = msg.name ? String(msg.name).trim() : null;
  if (!projectPath) {
    return wsSend(ws, { type: 'error', message: '项目路径不能为空' });
  }
  try {
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) {
      return wsSend(ws, { type: 'error', message: '指定路径不是目录' });
    }
  } catch {
    return wsSend(ws, { type: 'error', message: '路径不存在或无法访问' });
  }
  const id = msg.id || crypto.randomUUID();
  const existing = config.projects.find(p => p.id === id)
    || config.projects.find(p => normalizeProjectPathKey(p.path) === projectPath);
  if (existing) {
    if (projectName) existing.name = projectName;
    existing.path = projectPath;
  } else {
    const name = projectName || path.basename(projectPath) || projectPath;
    config.projects.push({ id, name, path: projectPath });
  }
  saveProjectsConfig(config);
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

function handleDeleteProject(ws, msg) {
  const config = loadProjectsConfig();
  config.projects = config.projects.filter(p => p.id !== msg.projectId);
  saveProjectsConfig(config);
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

function handleRenameProject(ws, msg) {
  const config = loadProjectsConfig();
  const project = config.projects.find(p => p.id === msg.projectId);
  if (project && msg.name) {
    project.name = String(msg.name).trim();
    saveProjectsConfig(config);
  }
  wsSend(ws, { type: 'projects_config', projects: config.projects });
}

async function handleGitCommand(ws, msg) {
  const action = String(msg?.action || '').trim();
  const requestId = msg?.requestId || null;
  let responseCwd = typeof msg?.cwd === 'string' ? String(msg.cwd).trim() : '';

  function sendGitResult(success, data = null, error = '') {
    wsSend(ws, {
      type: 'git_result',
      requestId,
      action,
      success: !!success,
      data: success ? data : null,
      error: success ? null : (error || 'Git 操作失败'),
      cwd: responseCwd || null,
    });
  }

  function execGit(args, cwd) {
    return new Promise((resolve) => {
      execFile('git', args, {
        cwd,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout = '', stderr = '') => {
        resolve({
          ok: !error,
          error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      });
    });
  }

  function formatGitError(result, fallback = 'Git 操作失败') {
    if (result?.error?.code === 'ENOENT') {
      return '找不到 git 命令，请先确认本机已经安装 Git。';
    }
    const merged = [result?.stderr, result?.stdout, result?.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!merged) return fallback;
    return merged
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
  }

  function sanitizeGitRelativePath(rawValue, repoRoot) {
    const raw = String(rawValue || '.').trim();
    if (!raw || raw === '.') return '.';
    if (raw.includes('\u0000')) throw new Error('文件路径不合法。');
    if (path.isAbsolute(raw)) throw new Error('文件路径必须是仓库内相对路径。');
    const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
    if (normalized === '.' || normalized === '') return '.';
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error('不允许访问仓库外部路径。');
    }
    if (normalized.startsWith('-')) throw new Error('文件路径不能以 - 开头。');
    const resolved = path.resolve(repoRoot, normalized.split('/').join(path.sep));
    if (!isPathInside(resolved, repoRoot)) throw new Error('文件路径超出仓库范围。');
    return normalized;
  }

  function sanitizeGitBranchName(rawValue) {
    const name = String(rawValue || '').trim();
    if (!name) throw new Error('分支名不能为空。');
    if (name.includes('\u0000') || name.startsWith('-') || /\s/.test(name)) {
      throw new Error('分支名不合法。');
    }
    if (
      name.startsWith('/') ||
      name.endsWith('/') ||
      name.includes('//') ||
      name.includes('..') ||
      name.endsWith('.lock') ||
      name.includes('@{') ||
      name === '@'
    ) {
      throw new Error('分支名不合法。');
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
      throw new Error('分支名只允许字母、数字、点、下划线、中划线和斜杠。');
    }
    return name;
  }

  function ensureGitCwdAllowed(targetPath) {
    return BROWSE_ROOTS.some((root) => isPathInside(targetPath, root));
  }

  async function hasActiveProcessInRepo(targetRepoRoot) {
    for (const [, entry] of activeProcesses) {
      const entryCwd = String(entry?.cwd || '').trim();
      if (!entryCwd) continue;
      let resolvedEntryCwd;
      try {
        resolvedEntryCwd = fs.realpathSync(path.resolve(entryCwd));
      } catch {
        continue;
      }
      const repoProbe = await execGit(['rev-parse', '--show-toplevel'], resolvedEntryCwd);
      const activeRepoRoot = repoProbe.ok ? (String(repoProbe.stdout || '').trim() || resolvedEntryCwd) : null;
      if (activeRepoRoot && activeRepoRoot === targetRepoRoot) return true;
    }
    return false;
  }

  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

  function parseGitStatusPorcelain(rawText) {
    const lines = String(rawText || '').split(/\r?\n/).filter(Boolean);
    const files = [];
    let branch = '';
    let upstream = '';
    let ahead = 0;
    let behind = 0;
    let detached = false;

    for (const line of lines) {
      if (line.startsWith('## ')) {
        const head = line.slice(3).trim();
        if (/^No commits yet on /i.test(head)) {
          branch = head.replace(/^No commits yet on /i, '').trim();
          continue;
        }
        const bracketMatch = head.match(/\[(.+)\]$/);
        const trackingPart = bracketMatch ? bracketMatch[1] : '';
        const refPart = bracketMatch ? head.slice(0, head.lastIndexOf(' [')).trim() : head;
        const refPieces = refPart.split('...');
        branch = refPieces[0] || '';
        upstream = refPieces[1] || '';
        detached = branch.startsWith('HEAD');
        const aheadMatch = trackingPart.match(/ahead (\d+)/);
        const behindMatch = trackingPart.match(/behind (\d+)/);
        ahead = aheadMatch ? parseInt(aheadMatch[1], 10) || 0 : 0;
        behind = behindMatch ? parseInt(behindMatch[1], 10) || 0 : 0;
        continue;
      }

      const x = line[0] || ' ';
      const y = line[1] || ' ';
      const code = `${x}${y}`;
      let filePath = line.slice(3).trim();
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop().trim();
      const conflicted = conflictCodes.has(code);
      const untracked = code === '??';
      const staged = !conflicted && x !== ' ' && x !== '?';
      const modified = !conflicted && y !== ' ' && y !== '?';

      files.push({
        path: filePath,
        code,
        indexStatus: x,
        worktreeStatus: y,
        staged,
        modified,
        untracked,
        conflicted,
        renamed: x === 'R' || y === 'R',
        added: x === 'A' || y === 'A',
        deleted: x === 'D' || y === 'D',
      });
    }

    return {
      branch: branch || 'HEAD',
      upstream: upstream || '',
      ahead,
      behind,
      detached,
      clean: files.length === 0,
      summary: {
        staged: files.filter((file) => file.staged).length,
        modified: files.filter((file) => file.modified).length,
        untracked: files.filter((file) => file.untracked).length,
        conflicted: files.filter((file) => file.conflicted).length,
      },
      files,
    };
  }

  function parseGitLog(rawText) {
    return String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(' ');
        if (firstSpace < 0) return { hash: line, subject: '' };
        return {
          hash: line.slice(0, firstSpace),
          subject: line.slice(firstSpace + 1),
        };
      });
  }

  function parseGitBranchList(rawText) {
    const branches = [];
    let current = '';
    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const isCurrent = rawLine.startsWith('*');
      const name = rawLine.slice(2).trim();
      if (!name) continue;
      branches.push({ name, current: isCurrent });
      if (isCurrent) current = name;
    }
    return { current, branches };
  }

  try {
    let requestedCwd = typeof msg?.cwd === 'string' ? String(msg.cwd).trim() : '';
    if (!requestedCwd && msg?.sessionId) {
      requestedCwd = String(loadSession(msg.sessionId)?.cwd || '').trim();
    }
    if (!requestedCwd) {
      return sendGitResult(false, null, '缺少工作目录，无法执行 Git 操作。');
    }

    let targetCwd;
    try {
      targetCwd = fs.realpathSync(path.resolve(requestedCwd));
      responseCwd = targetCwd;
    } catch {
      return sendGitResult(false, null, '工作目录不存在或无法访问。');
    }

    if (!ensureGitCwdAllowed(targetCwd)) {
      return sendGitResult(false, null, '工作目录不在允许范围内。');
    }

    const repoProbe = await execGit(['rev-parse', '--show-toplevel'], targetCwd);
    if (!repoProbe.ok) {
      return sendGitResult(false, null, '当前目录不是 Git 仓库。');
    }
    const repoRoot = String(repoProbe.stdout || '').trim() || targetCwd;
    if (!ensureGitCwdAllowed(repoRoot)) {
      return sendGitResult(false, null, 'Git 仓库根目录不在允许范围内。');
    }

    const isWriteAction = action === 'add'
      || action === 'commit'
      || action === 'checkout'
      || (action === 'branch' && String(msg?.name || '').trim());
    if (isWriteAction && await hasActiveProcessInRepo(repoRoot)) {
      return sendGitResult(false, null, '当前仓库有正在运行的会话，暂时禁止 Git 写操作。');
    }

    switch (action) {
      case 'status': {
        const result = await execGit(['status', '--porcelain=1', '--branch'], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '读取 Git 状态失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          ...parseGitStatusPorcelain(result.stdout),
        });
      }
      case 'log': {
        const headCheck = await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
        if (!headCheck.ok) {
          return sendGitResult(true, {
            cwd: responseCwd,
            repoRoot,
            entries: [],
          });
        }
        const result = await execGit(['log', '--no-color', '--oneline', '-20'], repoRoot);
        if (!result.ok) {
          return sendGitResult(false, null, formatGitError(result, '读取 Git 历史失败。'));
        }
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          entries: parseGitLog(result.stdout),
        });
      }
      case 'diff': {
        const staged = msg?.staged === true || msg?.staged === '1' || msg?.staged === 1;
        const file = msg?.file ? sanitizeGitRelativePath(msg.file, repoRoot) : '';
        const args = ['diff', '--no-color'];
        if (staged) args.push('--staged');
        if (file) args.push('--', file);
        const result = await execGit(args, repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '读取 Git diff 失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          staged,
          file: file || '',
          diff: result.stdout || '',
        });
      }
      case 'add': {
        const file = sanitizeGitRelativePath(msg?.file || '.', repoRoot);
        const result = await execGit(['add', '--', file], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '暂存文件失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          file,
          output: (result.stdout || result.stderr || '').trim(),
        });
      }
      case 'commit': {
        const message = String(msg?.message || '').trim();
        if (!message) return sendGitResult(false, null, '提交说明不能为空。');
        const result = await execGit(['commit', '-m', message], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, 'Git 提交失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          message,
          output: (result.stdout || result.stderr || '').trim(),
        });
      }
      case 'branch': {
        const name = String(msg?.name || '').trim();
        if (name) {
          const safeName = sanitizeGitBranchName(name);
          const result = await execGit(['branch', safeName], repoRoot);
          if (!result.ok) return sendGitResult(false, null, formatGitError(result, '创建分支失败。'));
          return sendGitResult(true, {
            cwd: responseCwd,
            repoRoot,
            created: true,
            branch: safeName,
            output: (result.stdout || result.stderr || '').trim(),
          });
        }
        const result = await execGit(['branch', '--list', '--no-color'], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '读取分支列表失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          ...parseGitBranchList(result.stdout),
        });
      }
      case 'checkout': {
        const branch = sanitizeGitBranchName(msg?.branch || '');
        const result = await execGit(['checkout', branch], repoRoot);
        if (!result.ok) return sendGitResult(false, null, formatGitError(result, '切换分支失败。'));
        return sendGitResult(true, {
          cwd: responseCwd,
          repoRoot,
          branch,
          output: (result.stdout || result.stderr || '').trim(),
        });
      }
      default:
        return sendGitResult(false, null, `不支持的 Git 操作：${action || 'unknown'}`);
    }
  } catch (error) {
    return sendGitResult(false, null, error?.message || 'Git 操作失败。');
  }
}

function handleBrowseDirectory(ws, msg) {
  const home = USER_HOME || '/';
  const requestedPath = msg && typeof msg.path === 'string' ? msg.path : '';
  let targetPath;
  try {
    targetPath = requestedPath ? path.resolve(String(requestedPath)) : home;
    targetPath = fs.realpathSync(targetPath);
  } catch (e) {
    return wsSend(ws, {
      type: 'directory_listing',
      path: requestedPath || home,
      parent: requestedPath ? path.dirname(path.resolve(String(requestedPath))) : null,
      dirs: [],
      error: '路径不存在或无法访问',
    });
  }

  if (!BROWSE_ROOTS.some((root) => isPathInside(targetPath, root))) {
    return wsSend(ws, {
      type: 'directory_listing',
      path: targetPath,
      parent: null,
      dirs: [],
      error: '路径不在允许浏览范围内',
    });
  }

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return wsSend(ws, {
        type: 'directory_listing',
        path: targetPath,
        parent: path.dirname(targetPath),
        dirs: [],
        error: '指定路径不是目录',
      });
    }
  } catch (e) {
    return wsSend(ws, {
      type: 'directory_listing',
      path: targetPath,
      parent: null,
      dirs: [],
      error: '无法读取路径信息',
    });
  }

  const showHidden = !!(msg && msg.showHidden);
  let entries;
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (e) {
    const parentPath = path.dirname(targetPath);
    return wsSend(ws, {
      type: 'directory_listing',
      path: targetPath,
      parent: parentPath !== targetPath ? parentPath : null,
      dirs: [],
      error: e.code === 'EACCES' ? '权限不足，无法读取此目录' : '读取目录失败',
    });
  }

  const dirs = entries
    .filter(e => {
      if (!e.isDirectory()) return false;
      if (!showHidden && e.name.startsWith('.')) return false;
      return true;
    })
    .map(e => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const parentPath = path.dirname(targetPath);
  wsSend(ws, {
    type: 'directory_listing',
    path: targetPath,
    parent: parentPath !== targetPath ? parentPath : null,
    dirs,
    error: null,
  });
}

// === Startup ===
recoverProcesses();

// Periodic heartbeat: log active processes status every 60s
setInterval(() => {
  if (activeProcesses.size === 0) return;
  const procs = [];
  for (const [sid, entry] of activeProcesses) {
    const alive = isProcessRunning(entry.pid);
    procs.push({
      sessionId: sid.slice(0, 8),
      pid: entry.pid,
      alive,
      wsConnected: !!entry.ws,
      wsDisconnectTime: entry.wsDisconnectTime || null,
      responseLen: (entry.fullText || '').length,
    });
  }
  plog('INFO', 'heartbeat', { activeCount: procs.length, wsClients: wss.clients.size, processes: procs });
}, 60000);

// Backfill projectId for existing sessions that have cwd but no projectId
try {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')));
      if (session && session.cwd && !session.projectId) {
        const ensured = ensureProjectForPath(session.cwd);
        if (ensured.project?.id) {
          session.projectId = ensured.project.id;
          saveSession(session);
        }
      }
    } catch {}
  }
} catch {}

plog('INFO', 'server_start', {
  port: PORT,
  host: HOST,
  wsMaxPayloadBytes: WS_MAX_PAYLOAD_BYTES,
  piTransport: PI_TRANSPORT,
  piRpcIdleTimeoutMinutes: PI_RPC_IDLE_TIMEOUT_MINUTES,
  maxPiRpcRuntimes: MAX_PI_RPC_RUNTIMES,
  codexTransport: CODEX_TRANSPORT,
  codexAppIdleTimeoutMinutes: CODEX_APP_IDLE_TIMEOUT_MINUTES,
  maxCodexAppRuntimes: MAX_CODEX_APP_RUNTIMES,
  claudeTransport: CLAUDE_TRANSPORT,
  claudeStreamIdleTimeoutMinutes: CLAUDE_STREAM_IDLE_TIMEOUT_MINUTES,
  maxClaudeStreamRuntimes: MAX_CLAUDE_STREAM_RUNTIMES,
});

server.listen(PORT, HOST, () => {
  console.log(`webcoding server listening on ${HOST}:${PORT}`);
  console.log(`CLI paths: claude=${CLAUDE_PATH} | codex=${CODEX_PATH} | pi=${PI_PATH}`);
  function warnStaleCliEnv(name, envVal, resolved) {
    if (!envVal || envVal === resolved) return;
    // Only warn when an explicit path was broken (not when a bare name was expanded to absolute).
    const looksLikePath = path.isAbsolute(envVal) || envVal.includes('/') || envVal.includes('\\');
    const configuredPath = path.isAbsolute(envVal) ? envVal : path.resolve(__dirname, envVal);
    if (looksLikePath && !isExecutablePath(configuredPath)) {
      console.warn(`[webcoding] ${name} env "${envVal}" is missing/unusable; using "${resolved}"`);
    }
  }
  warnStaleCliEnv('CLAUDE_PATH', process.env.CLAUDE_PATH, CLAUDE_PATH);
  warnStaleCliEnv('CODEX_PATH', process.env.CODEX_PATH, CODEX_PATH);
  warnStaleCliEnv('PI_PATH', process.env.PI_PATH, PI_PATH);
  const wildcardHost = HOST === '0.0.0.0' || HOST === '::';
  const localDisplayHost = wildcardHost ? 'localhost' : (HOST.includes(':') ? `[${HOST}]` : HOST);
  console.log(`  Local:   http://${localDisplayHost}:${PORT}`);
  if (wildcardHost) {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  Network: http://${addr.address}:${PORT}`);
        }
      }
    }
  }
});

let shutdownStarted = false;
function shutdownServer(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  plog('INFO', 'server_shutdown', { signal });
  for (const runtime of [...piRpcRuntimes.values()]) disposePiRpcRuntime(runtime.sessionId, 'server_shutdown');
  for (const runtime of [...codexAppRuntimes.values()]) disposeCodexAppRuntime(runtime.sessionId, 'server_shutdown');
  for (const runtime of [...claudeStreamRuntimes.values()]) disposeClaudeStreamRuntime(runtime.sessionId, 'server_shutdown');
  server.close(() => process.exit(0));
  const forceTimer = setTimeout(() => process.exit(0), 2500);
  forceTimer.unref?.();
}

process.on('SIGTERM', () => shutdownServer('SIGTERM'));
process.on('SIGINT', () => shutdownServer('SIGINT'));
