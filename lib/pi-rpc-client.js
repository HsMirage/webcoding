const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RPC_BUFFER_BYTES = 16 * 1024 * 1024;

class PiRpcClient {
  constructor(options) {
    this.options = options || {};
    this.child = null;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = false;
    this.disposing = false;
    this.state = null;
    this.terminationTimers = [];
  }

  static async start(options) {
    const client = new PiRpcClient(options);
    await client.start();
    return client;
  }

  async start() {
    if (this.child) return this.state;
    const child = spawn(this.options.command, this.options.args || [], {
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
      this.stderr = `${this.stderr}${String(chunk || '')}`.slice(-8000);
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
      const response = await this.request({ type: 'get_state' }, { timeoutMs: startupTimeoutMs });
      this.state = response.data || null;
      return this.state;
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

  request(command, options = {}) {
    if (!this.isAlive) return Promise.reject(new Error('Pi RPC process is not running'));
    const id = command?.id || `webcoding-${crypto.randomUUID()}`;
    const payload = { ...(command || {}), id };
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${payload.type || 'request'} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, command: payload.type || 'request' });
      this.writeLine(payload).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  sendExtensionResponse(response) {
    const payload = { ...(response || {}), type: 'extension_ui_response' };
    delete payload.command;
    return this.writeLine(payload);
  }

  writeLine(payload) {
    if (!this.isAlive || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('Pi RPC stdin is not writable'));
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
      this.protocolError(new Error('Pi RPC output exceeded the framing buffer limit'));
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
      this.protocolError(new Error(`Invalid Pi RPC JSON: ${error.message}`));
      return;
    }

    if (message?.type === 'response' && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.success === false) {
        const error = new Error(message.error || `Pi RPC ${pending.command} failed`);
        error.response = message;
        pending.reject(error);
      } else {
        pending.resolve(message);
      }
      return;
    }

    try {
      this.options.onEvent?.(message, this);
    } catch (error) {
      this.protocolError(error);
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
    for (const timer of this.terminationTimers) clearTimeout(timer);
    this.terminationTimers = [];
    const detail = this.stderr.trim();
    const error = new Error(detail || `Pi RPC process exited${code === null ? '' : ` with code ${code}`}`);
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
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }, 1500);
    timer.unref?.();
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000);
    forceTimer.unref?.();
    this.terminationTimers.push(timer, forceTimer);
  }
}

module.exports = { PiRpcClient };
