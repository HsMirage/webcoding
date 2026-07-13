const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RPC_BUFFER_BYTES = 32 * 1024 * 1024;

class CodexAppServerClient {
  constructor(options = {}) {
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stderr = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = false;
    this.disposing = false;
    this.initialized = false;
    this.terminationTimers = [];
  }

  static async start(options) {
    const client = new CodexAppServerClient(options);
    await client.start();
    return client;
  }

  async start() {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args || ['app-server'], {
      env: this.options.env,
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      shell: !!this.options.useShell,
    });
    this.child = child;

    child.stdout.on('data', (chunk) => this.handleStdoutChunk(chunk));
    child.stdout.on('end', () => this.handleStdoutEnd());
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk || '')}`.slice(-12_000);
    });
    child.on('close', (code, signal) => this.handleExit(code, signal));
    child.on('error', (error) => this.protocolError(error));
    child.stdin.on('error', (error) => this.protocolError(error));

    try {
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          child.off('error', onError);
          resolve();
        };
        const onError = (error) => {
          child.off('spawn', onSpawn);
          this.disposing = true;
          reject(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });

      const startupTimeoutMs = Number(this.options.startupTimeoutMs) > 0
        ? Number(this.options.startupTimeoutMs)
        : 15_000;
      await this.request('initialize', {
        clientInfo: {
          name: 'webcoding',
          title: 'Webcoding',
          version: String(this.options.clientVersion || '1.0.0'),
        },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
        },
      }, { timeoutMs: startupTimeoutMs });
      await this.notify('initialized', {});
      this.initialized = true;
    } catch (error) {
      if (!this.closed && !this.disposing) this.dispose();
      throw error;
    }
  }

  get pid() {
    return this.child?.pid || null;
  }

  get isAlive() {
    return !!this.child
      && !this.closed
      && !this.disposing
      && this.child.exitCode === null
      && this.child.signalCode === null;
  }

  request(method, params = {}, options = {}) {
    if (!this.isAlive) return Promise.reject(new Error('Codex App Server is not running'));
    const id = this.nextRequestId++;
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.writeLine({ method, id, params }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    return this.writeLine({ method, params });
  }

  respond(id, result = {}, error = null) {
    if (error) {
      return this.writeLine({
        id,
        error: {
          code: Number.isFinite(error.code) ? error.code : -32000,
          message: error.message || String(error),
        },
      });
    }
    return this.writeLine({ id, result });
  }

  writeLine(payload) {
    if (!this.isAlive || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('Codex App Server stdin is not writable'));
    }
    const line = `${JSON.stringify(payload)}\n`;
    return new Promise((resolve, reject) => {
      try {
        this.child.stdin.write(line, 'utf8', (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  handleStdoutChunk(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_RPC_BUFFER_BYTES) {
      this.protocolError(new Error('Codex App Server output exceeded the framing buffer limit'));
      this.dispose();
      return;
    }
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) this.handleLine(line);
    }
  }

  handleStdoutEnd() {
    this.buffer += this.decoder.end();
    if (!this.buffer) return;
    const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    if (line) this.handleLine(line);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.protocolError(new Error(`Invalid Codex App Server JSON: ${error.message}`));
      return;
    }

    if (message?.id !== undefined && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `Codex App Server ${pending.method} failed`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method && message.id !== undefined) {
      if (typeof this.options.onRequest !== 'function') {
        this.respond(message.id, null, { code: -32601, message: `Unsupported client request: ${message.method}` }).catch(() => {});
        return;
      }
      try {
        const result = this.options.onRequest(message.method, message.params || {}, message.id, this);
        if (result !== undefined) {
          Promise.resolve(result)
            .then((value) => this.respond(message.id, value === undefined ? {} : value))
            .catch((error) => this.respond(message.id, null, error).catch(() => {}));
        }
      } catch (error) {
        this.respond(message.id, null, error).catch(() => {});
      }
      return;
    }

    if (message?.method) {
      try {
        this.options.onNotification?.(message.method, message.params || {}, this);
      } catch (error) {
        this.protocolError(error);
      }
    }
  }

  protocolError(error) {
    try {
      this.options.onProtocolError?.(error, this);
    } catch {}
  }

  handleExit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    for (const timer of this.terminationTimers) clearTimeout(timer);
    this.terminationTimers = [];
    const detail = this.stderr.trim();
    const error = new Error(detail || `Codex App Server exited${code === null ? '' : ` with code ${code}`}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.options.onExit?.({ code, signal, error, expected: this.disposing }, this);
    } catch {}
  }

  dispose() {
    if (!this.child || this.closed || this.disposing) return;
    this.disposing = true;
    try { this.child.stdin.end(); } catch {}
    const child = this.child;
    const terminate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }, 1500);
    terminate.unref?.();
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000);
    force.unref?.();
    this.terminationTimers.push(terminate, force);
  }
}

module.exports = { CodexAppServerClient };
