const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const MAX_STREAM_BUFFER_BYTES = 32 * 1024 * 1024;

class ClaudeStreamClient {
  constructor(options = {}) {
    this.options = options;
    this.child = null;
    this.stderr = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = false;
    this.disposing = false;
    this.terminationTimers = [];
  }

  static async start(options) {
    const client = new ClaudeStreamClient(options);
    await client.start();
    return client;
  }

  async start() {
    if (this.child) return;
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
      const text = String(chunk || '');
      this.stderr = `${this.stderr}${text}`.slice(-12_000);
      try { this.options.onStderr?.(text, this); } catch {}
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

  sendUserMessage(content) {
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
    return this.writeLine({
      type: 'user',
      message: {
        role: 'user',
        content: blocks,
      },
    });
  }

  writeLine(payload) {
    if (!this.isAlive || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('Claude stream stdin is not writable'));
    }
    return new Promise((resolve, reject) => {
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
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
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_STREAM_BUFFER_BYTES) {
      this.protocolError(new Error('Claude stream output exceeded the framing buffer limit'));
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
    try {
      this.options.onEvent?.(JSON.parse(line), this);
    } catch (error) {
      this.protocolError(error instanceof SyntaxError
        ? new Error(`Invalid Claude stream JSON: ${error.message}`)
        : error);
    }
  }

  protocolError(error) {
    try { this.options.onProtocolError?.(error, this); } catch {}
  }

  handleExit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.terminationTimers) clearTimeout(timer);
    this.terminationTimers = [];
    const error = new Error(this.stderr.trim() || `Claude stream exited${code === null ? '' : ` with code ${code}`}`);
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

module.exports = { ClaudeStreamClient };
