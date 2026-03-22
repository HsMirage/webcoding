#!/usr/bin/env node
'use strict';

/**
 * Cloudflare Tunnel manager (cf-tunnel.js)
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` as a detached
 * child process, parses its stderr for the public HTTPS URL, and persists
 * state to a JSON file so server.js can read it without keeping a handle.
 *
 * State file schema:
 *   { pid, port, url, startedAt, error? }
 */

const { spawn } = require('child_process');
const fs = require('fs');

const statePath = process.env.CF_TUNNEL_STATE_PATH || '';
const targetPort = parseInt(process.env.CF_TUNNEL_PORT || '8001', 10);
const cfPath = process.env.CF_TUNNEL_BIN || 'cloudflared';

if (!statePath) {
  console.error('[cf-tunnel] CF_TUNNEL_STATE_PATH not set');
  process.exit(1);
}

function writeState(obj) {
  try {
    const tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, statePath);
  } catch (e) {
    // best-effort
  }
}

const child = spawn(cfPath, ['tunnel', '--url', `http://localhost:${targetPort}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

writeState({ pid: child.pid, port: targetPort, url: null, startedAt: new Date().toISOString() });

// cloudflared prints the public URL to stderr
function onData(chunk) {
  const text = chunk.toString();
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m) {
    writeState({ pid: child.pid, port: targetPort, url: m[0], startedAt: new Date().toISOString() });
  }
}

child.stdout.on('data', onData);
child.stderr.on('data', onData);

child.on('exit', (code) => {
  writeState({ pid: null, port: targetPort, url: null, startedAt: null, error: `exited with code ${code}` });
});

// Keep process alive until child exits
child.on('close', () => process.exit(0));
