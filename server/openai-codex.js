/**
 * OpenAI Codex App Server Integration
 * =============================
 *
 * This module talks to the official `codex app-server` JSON protocol instead of
 * the standalone SDK. That keeps CloudCLI-created and CloudCLI-resumed sessions
 * materialized in Codex's own state database and session transcript files, so
 * they appear in the Codex desktop app too.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { spawn } from 'node:child_process';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { sessionSynchronizerService } from './modules/providers/services/session-synchronizer.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage } from './shared/utils.js';

// Track active sessions
const activeCodexSessions = new Map();
const CODEX_APP_SERVER_COMMAND = process.env.CODEX_CLI_PATH || 'codex';
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;

class CodexAppServerClient {
  constructor() {
    this.child = spawn(CODEX_APP_SERVER_COMMAND, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.closed = false;
    this.intentionalClose = false;
    this.onNotification = null;
    this.onClose = null;

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.handleStderr(chunk));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      const error = new Error(`Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      this.rejectAll(error);
      if (!this.intentionalClose && typeof this.onClose === 'function') {
        this.onClose(error);
      }
    });
  }

  async initialize() {
    return this.request('initialize', {
      clientInfo: {
        name: 'cloudcli',
        title: 'CloudCLI',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  request(method, params = {}) {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}`));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString();

    let newlineIndex;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleProtocolLine(line);
      }
    }
  }

  handleStderr(chunk) {
    this.stderrBuffer += chunk.toString();

    let newlineIndex;
    while ((newlineIndex = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line) {
        this.logDiagnosticLine(line);
      }
    }
  }

  handleProtocolLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.warn('[Codex] Ignoring non-JSON app-server stdout:', line);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} failed`);
        error.details = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && typeof this.onNotification === 'function') {
      this.onNotification(message);
    }
  }

  logDiagnosticLine(line) {
    try {
      const message = JSON.parse(line);
      const level = message.level || 'INFO';
      const text = message.fields?.message || line;
      if (level === 'ERROR') {
        console.warn('[Codex app-server]', text);
      }
      return;
    } catch {
      // Fall through to plain diagnostics.
    }

    console.warn('[Codex app-server]', line);
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.intentionalClose = true;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // Process may already be gone.
    }

    setTimeout(() => {
      if (!this.child.killed) {
        this.child.kill('SIGTERM');
      }
    }, 500).unref?.();
  }

  kill() {
    this.intentionalClose = true;
    this.closed = true;
    try {
      this.child.kill('SIGTERM');
    } catch {
      // Process may already be gone.
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

function appServerSandboxPolicy(sandboxMode, writableRoot) {
  switch (sandboxMode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: writableRoot ? [writableRoot] : [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function normalizeReasoningEffort(model) {
  if (typeof model !== 'string') {
    return null;
  }

  const lowered = model.toLowerCase();
  if (lowered.includes('xhigh')) {
    return 'xhigh';
  }
  if (lowered.includes('high')) {
    return 'high';
  }
  if (lowered.includes('medium')) {
    return 'medium';
  }
  if (lowered.includes('low')) {
    return 'low';
  }
  return null;
}

function buildTextInput(command) {
  return [{ type: 'text', text: command, text_elements: [] }];
}

function readAppServerThreadId(result) {
  return result?.thread?.id || null;
}

function readAppServerThreadPath(result) {
  return result?.thread?.path || null;
}

function transformAppServerItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  switch (item.type) {
    case 'agentMessage':
      return {
        type: 'item',
        itemType: 'agent_message',
        message: {
          role: 'assistant',
          content: item.text || '',
        },
      };
    case 'reasoning':
      return {
        type: 'item',
        itemType: 'reasoning',
        message: {
          role: 'assistant',
          content: [
            ...(Array.isArray(item.summary) ? item.summary : []),
            ...(Array.isArray(item.content) ? item.content : []),
          ].filter(Boolean).join('\n'),
          isReasoning: true,
        },
      };
    case 'commandExecution':
      return {
        type: 'item',
        itemType: 'command_execution',
        command: item.command,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        status: item.status,
      };
    case 'fileChange':
      return {
        type: 'item',
        itemType: 'file_change',
        changes: item.changes,
        status: item.status,
      };
    case 'mcpToolCall':
      return {
        type: 'item',
        itemType: 'mcp_tool_call',
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      };
    case 'webSearch':
      return {
        type: 'item',
        itemType: 'web_search',
        query: item.query,
      };
    default:
      return {
        type: 'item',
        itemType: item.type,
        item,
      };
  }
}

function sendNormalizedMessages(ws, raw, sessionId) {
  const normalizedMsgs = sessionsService.normalizeMessage('codex', raw, sessionId);
  for (const msg of normalizedMsgs) {
    sendMessage(ws, msg);
  }
}

async function syncCodexSessionFile(threadId, rolloutPath) {
  if (!threadId || !rolloutPath) {
    return;
  }

  try {
    await sessionSynchronizerService.synchronizeProviderFile('codex', rolloutPath);
  } catch (error) {
    console.warn(`[Codex] Failed to index Codex session file ${rolloutPath}:`, error);
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    permissionMode = 'default'
  } = options;

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);

  let appServer;
  let currentSessionId = sessionId;
  let currentTurnId = null;
  let currentThreadPath = null;
  let terminalFailure = null;
  let turnCompleted = false;
  const streamedAgentItems = new Set();

  try {
    appServer = new CodexAppServerClient();
    await appServer.initialize();

    appServer.onClose = (error) => {
      if (!turnCompleted && !terminalFailure) {
        terminalFailure = error;
      }
    };

    appServer.onNotification = (message) => {
      const params = message.params || {};
      const notificationThreadId = params.threadId || params.thread?.id || currentSessionId;

      if (message.method === 'turn/started') {
        currentTurnId = params.turn?.id || currentTurnId;
        if (currentSessionId && currentTurnId) {
          const session = activeCodexSessions.get(currentSessionId);
          if (session) {
            session.turnId = currentTurnId;
          }
        }
        return;
      }

      if (message.method === 'item/agentMessage/delta') {
        if (params.itemId) {
          streamedAgentItems.add(params.itemId);
        }
        sendMessage(ws, createNormalizedMessage({
          kind: 'stream_delta',
          content: params.delta || '',
          sessionId: notificationThreadId,
          provider: 'codex',
        }));
        return;
      }

      if (message.method === 'item/completed') {
        const transformed = transformAppServerItem(params.item);
        if (!transformed) {
          return;
        }

        // When deltas were already streamed, the complete event only closes the
        // UI stream; appending the final text again would duplicate the answer.
        if (params.item?.type === 'agentMessage' && streamedAgentItems.has(params.item.id)) {
          return;
        }

        sendNormalizedMessages(ws, transformed, notificationThreadId);
        return;
      }

      if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage?.total;
        if (usage) {
          sendMessage(ws, createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: {
              used: usage.totalTokens || 0,
              total: params.tokenUsage?.modelContextWindow || 200000,
            },
            sessionId: notificationThreadId,
            provider: 'codex',
          }));
        }
        return;
      }

      if (message.method === 'turn/completed') {
        if (params.turn?.status === 'failed') {
          const reason = params.turn?.error?.message || params.turn?.error || 'Turn failed';
          terminalFailure = new Error(String(reason));
        }
        turnCompleted = true;
        sendMessage(ws, createNormalizedMessage({
          kind: 'stream_end',
          sessionId: notificationThreadId,
          provider: 'codex',
        }));
        return;
      }

      if (message.method === 'error') {
        terminalFailure = new Error(params.message || 'Codex app-server error');
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: terminalFailure.message,
          sessionId: notificationThreadId,
          provider: 'codex',
        }));
      }
    };

    const threadOptions = {
      cwd: workingDirectory,
      model: model || null,
      modelProvider: 'openai',
      approvalPolicy,
      sandbox: sandboxMode,
      ephemeral: false,
      config: {
        skip_git_repo_check: true,
      },
    };

    let threadResult;
    if (sessionId) {
      threadResult = await appServer.request('thread/resume', {
        ...threadOptions,
        threadId: sessionId,
        excludeTurns: true,
      });
    } else {
      threadResult = await appServer.request('thread/start', {
        ...threadOptions,
        serviceName: 'CloudCLI',
        sessionStartSource: 'startup',
      });
    }

    currentSessionId = readAppServerThreadId(threadResult) || sessionId || currentSessionId;
    currentThreadPath = readAppServerThreadPath(threadResult);

    if (!currentSessionId) {
      throw new Error('Codex app-server did not return a thread id');
    }

    // Track the session
    activeCodexSessions.set(currentSessionId, {
      appServer,
      status: 'running',
      turnId: null,
      startedAt: new Date().toISOString()
    });

    const threadName = typeof sessionSummary === 'string' && sessionSummary.trim()
      ? sessionSummary.replace(/\s+/g, ' ').trim().slice(0, 200)
      : '';
    if (threadName) {
      try {
        await appServer.request('thread/name/set', {
          threadId: currentSessionId,
          name: threadName,
        });
      } catch (error) {
        console.warn(`[Codex] Failed to set thread name for ${currentSessionId}:`, error);
      }
    }

    await syncCodexSessionFile(currentSessionId, currentThreadPath);

    // Send session created event
    sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: currentSessionId, sessionId: currentSessionId, provider: 'codex' }));

    const turnResult = await appServer.request('turn/start', {
      threadId: currentSessionId,
      input: buildTextInput(command),
      approvalPolicy,
      sandboxPolicy: appServerSandboxPolicy(sandboxMode, workingDirectory),
      effort: normalizeReasoningEffort(model),
      model: model || null,
    });

    currentTurnId = turnResult?.turn?.id || null;
    const activeSession = activeCodexSessions.get(currentSessionId);
    if (activeSession) {
      activeSession.turnId = currentTurnId;
    }

    await new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const session = activeCodexSessions.get(currentSessionId);
        if (session?.status === 'aborted') {
          clearInterval(poll);
          resolve();
          return;
        }
        if (terminalFailure) {
          clearInterval(poll);
          reject(terminalFailure);
          return;
        }
        if (turnCompleted) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });

    await syncCodexSessionFile(currentSessionId, currentThreadPath);

    const finalSession = activeCodexSessions.get(currentSessionId);
    const wasAborted = finalSession?.status === 'aborted';

    // Send completion event
    if (wasAborted) {
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: currentSessionId,
        sessionName: sessionSummary,
        stopReason: 'aborted'
      });
    } else if (!terminalFailure) {
      sendMessage(ws, createNormalizedMessage({ kind: 'complete', actualSessionId: currentSessionId, sessionId: currentSessionId, provider: 'codex' }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: currentSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    }

  } catch (error) {
    const session = currentSessionId ? activeCodexSessions.get(currentSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // Check if Codex CLI is available for a clearer error message
      const installed = await providerAuthService.isProviderInstalled('codex');
      const errorContent = !installed
        ? 'Codex CLI is not configured. Please set up authentication first.'
        : error.message;

      sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: currentSessionId, provider: 'codex' }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: currentSessionId,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    // Update session status
    if (currentSessionId) {
      const session = activeCodexSessions.get(currentSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
    if (appServer) {
      try {
        if (currentSessionId) {
          await appServer.request('thread/unsubscribe', { threadId: currentSessionId }).catch(() => {});
        }
      } finally {
        await appServer.close();
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';

  const stopAppServer = () => {
    try {
      session.appServer?.kill();
    } catch (error) {
      console.warn(`[Codex] Failed to stop app-server for session ${sessionId}:`, error);
    }
  };

  if (!session.appServer || !session.turnId) {
    stopAppServer();
    return true;
  }

  session.appServer.request('turn/interrupt', {
    threadId: sessionId,
    turnId: session.turnId,
  }).catch((error) => {
    console.warn(`[Codex] Failed to interrupt turn ${session.turnId}:`, error);
  }).finally(() => {
    setTimeout(stopAppServer, 1000).unref?.();
  });

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
