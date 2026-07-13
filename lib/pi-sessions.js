'use strict';

const fs = require('fs');
const path = require('path');

const HEAD_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 128 * 1024;

function readFileSliceUtf8(filePath, start, length) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeLength = Math.max(0, Number(length) || 0);
  if (!safeLength) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(safeLength);
    const bytesRead = fs.readSync(fd, buffer, 0, safeLength, safeStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonLines(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch {}
  }
  return entries;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function summarizePiSessionFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile() || !filePath.endsWith('.jsonl')) return null;

  const head = parseJsonLines(readFileSliceUtf8(filePath, 0, Math.min(stat.size, HEAD_READ_BYTES)));
  const header = head.find((entry) => entry?.type === 'session');
  if (!header?.id) return null;

  let title = '';
  let name = '';
  let provider = '';
  let modelId = '';
  let thinkingLevel = '';
  let messageCount = 0;
  for (const entry of head) {
    if (entry?.type === 'session_info' && typeof entry.name === 'string') name = entry.name.trim();
    if (entry?.type === 'model_change') {
      provider = String(entry.provider || '');
      modelId = String(entry.modelId || '');
    }
    if (entry?.type === 'thinking_level_change') thinkingLevel = String(entry.thinkingLevel || '');
    if (entry?.type !== 'message') continue;
    messageCount += 1;
    if (!title && entry.message?.role === 'user') title = contentText(entry.message.content).trim();
  }

  let updatedAt = stat.mtime?.toISOString?.() || header.timestamp || null;
  if (stat.size > 0) {
    const readBytes = Math.min(stat.size, TAIL_READ_BYTES);
    const tail = parseJsonLines(readFileSliceUtf8(filePath, stat.size - readBytes, readBytes));
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      if (tail[index]?.timestamp) {
        updatedAt = tail[index].timestamp;
        break;
      }
    }
  }

  return {
    sessionId: String(header.id),
    filePath: path.resolve(filePath),
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    title: (name || title || String(header.id)).replace(/\s+/g, ' ').slice(0, 100),
    updatedAt,
    createdAt: header.timestamp || null,
    provider,
    modelId,
    thinkingLevel,
    messageCount,
  };
}

function getPiSessionFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  return files;
}

function getActivePiEntries(entries) {
  const body = entries.filter((entry) => entry?.id && entry.type !== 'session');
  const byId = new Map(body.map((entry) => [String(entry.id), entry]));
  let current = body[body.length - 1] || null;
  const active = [];
  const seen = new Set();
  while (current?.id && !seen.has(String(current.id))) {
    seen.add(String(current.id));
    active.push(current);
    current = current.parentId ? byId.get(String(current.parentId)) : null;
  }
  return active.reverse();
}

function piToolResultText(message) {
  const text = contentText(message?.content);
  if (text) return text;
  if (!Array.isArray(message?.content)) return '';
  const imageCount = message.content.filter((part) => part?.type === 'image').length;
  return imageCount > 0 ? `[${imageCount} 个图片结果]` : '';
}

function piBashExecutionTool(entry) {
  const command = String(entry?.command || '');
  const output = String(entry?.output || '');
  const cancelled = entry?.cancelled === true;
  const truncated = entry?.truncated === true;
  const exitCode = Number.isInteger(entry?.exitCode) ? entry.exitCode : null;
  const resultParts = [];
  if (output) resultParts.push(output);
  if (cancelled) resultParts.push('（命令已取消）');
  else if (exitCode !== null && exitCode !== 0) resultParts.push(`（命令退出码：${exitCode}）`);
  if (truncated) {
    const fullOutputPath = typeof entry?.fullOutputPath === 'string' ? entry.fullOutputPath.trim() : '';
    resultParts.push(fullOutputPath
      ? `（输出已截断，完整输出：${fullOutputPath}）`
      : '（输出已截断）');
  }

  const id = `pi-bash-${String(entry?.id || 'execution')}`;
  const meta = {
    kind: 'command_execution',
    title: 'Bash',
    subtitle: command,
    cancelled,
    truncated,
    ...(exitCode !== null ? { exitCode } : {}),
  };
  const toolCall = {
    id,
    name: 'bash',
    input: { command },
    result: resultParts.join('\n\n').slice(0, 12000),
    kind: 'command_execution',
    meta,
    done: true,
    isError: cancelled || (exitCode !== null && exitCode !== 0),
  };
  return {
    role: 'assistant',
    content: '',
    toolCalls: [toolCall],
    segments: [{ type: 'tool_call', ...toolCall }],
    timestamp: entry?.timestamp || null,
  };
}

function parsePiSessionFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  let raw;
  try { raw = fs.readFileSync(resolvedPath, 'utf8'); } catch { return null; }
  const entries = parseJsonLines(raw);
  const header = entries.find((entry) => entry?.type === 'session');
  if (!header?.id) return null;

  const activeEntries = getActivePiEntries(entries);
  const messages = [];
  const toolCallsById = new Map();
  let provider = '';
  let modelId = '';
  let thinkingLevel = '';
  let sessionName = '';
  let totalCost = 0;
  const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  for (const entry of activeEntries) {
    if (entry.type === 'model_change') {
      provider = String(entry.provider || provider);
      modelId = String(entry.modelId || modelId);
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      thinkingLevel = String(entry.thinkingLevel || thinkingLevel);
      continue;
    }
    if (entry.type === 'session_info') {
      if (typeof entry.name === 'string') sessionName = entry.name.trim();
      continue;
    }
    if (entry.type === 'bashExecution') {
      messages.push(piBashExecutionTool(entry));
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const nativeMessage = entry.message;

    if (nativeMessage.role === 'user') {
      const text = contentText(nativeMessage.content).trim();
      const hasImage = Array.isArray(nativeMessage.content)
        && nativeMessage.content.some((part) => part?.type === 'image');
      if (text || hasImage) {
        messages.push({
          role: 'user',
          content: text || '（图片消息）',
          timestamp: entry.timestamp || null,
        });
      }
      continue;
    }

    if (nativeMessage.role === 'assistant') {
      provider = String(nativeMessage.provider || provider);
      modelId = String(nativeMessage.model || modelId);
      const segments = [];
      const toolCalls = [];
      let answerText = '';
      for (const part of Array.isArray(nativeMessage.content) ? nativeMessage.content : []) {
        if (part?.type === 'thinking' && part.thinking) {
          segments.push({ type: 'text', text: String(part.thinking), phase: 'thinking', thinking: true });
        } else if (part?.type === 'text' && part.text) {
          answerText += String(part.text);
          segments.push({ type: 'text', text: String(part.text), phase: 'final' });
        } else if (part?.type === 'toolCall' || part?.type === 'tool_call' || part?.type === 'tool_use') {
          const toolCall = {
            id: String(part.id || part.toolCallId || ''),
            name: String(part.name || part.toolName || 'tool'),
            input: part.arguments ?? part.input ?? {},
            done: true,
          };
          const toolSegment = { type: 'tool_call', ...toolCall };
          toolCalls.push(toolCall);
          segments.push(toolSegment);
          if (toolCall.id) toolCallsById.set(toolCall.id, { toolCall, toolSegment });
        }
      }
      const usage = nativeMessage.usage || {};
      totalUsage.inputTokens += Number(usage.input || usage.inputTokens || 0) || 0;
      totalUsage.cachedInputTokens += Number(usage.cacheRead || usage.cachedInputTokens || 0) || 0;
      totalUsage.outputTokens += Number(usage.output || usage.outputTokens || 0) || 0;
      totalCost += Number(usage.cost?.total || usage.totalCost || 0) || 0;
      if (answerText || segments.length > 0) {
        messages.push({
          role: 'assistant',
          content: answerText,
          toolCalls,
          segments,
          model: modelId || null,
          timestamp: entry.timestamp || null,
        });
      }
      continue;
    }

    if (nativeMessage.role === 'toolResult' || nativeMessage.role === 'tool_result') {
      const toolCallId = String(nativeMessage.toolCallId || nativeMessage.tool_use_id || '');
      const record = toolCallsById.get(toolCallId);
      if (!record) continue;
      const result = piToolResultText(nativeMessage).slice(0, 12000);
      record.toolCall.result = result;
      record.toolCall.isError = nativeMessage.isError === true;
      record.toolSegment.result = result;
      record.toolSegment.isError = nativeMessage.isError === true;
    }
  }

  const firstUser = messages.find((message) => message.role === 'user' && message.content)?.content || '';
  const lastEntry = activeEntries[activeEntries.length - 1];
  return {
    meta: {
      sessionId: String(header.id),
      filePath: resolvedPath,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      title: (sessionName || firstUser || String(header.id)).replace(/\s+/g, ' ').slice(0, 100),
      createdAt: header.timestamp || null,
      updatedAt: lastEntry?.timestamp || header.timestamp || null,
      provider,
      modelId,
      thinkingLevel,
    },
    messages,
    totalCost,
    totalUsage,
  };
}

module.exports = {
  getPiSessionFiles,
  parsePiSessionFile,
  summarizePiSessionFile,
};
