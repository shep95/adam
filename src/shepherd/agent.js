/**
 * The Shepherd conversation loop: send the thread with a fresh [console]
 * reading, stream the reply, run any tool calls against the live console,
 * hand the results back, and repeat until the model answers in words (or the
 * round limit is reached). UI concerns arrive through `onEvent`.
 */
import { trimThread, THREAD_LIMIT } from './memory.js';

export const MAX_TOOL_ROUNDS = 8;

/**
 * Make a thread safe to send: every assistant tool call must be answered by
 * a tool turn, and tool turns must follow the call that asked for them.
 */
export function repairThread(input) {
  const thread = [...input];
  const out = [];
  for (let i = 0; i < thread.length; i += 1) {
    const turn = thread[i];
    if (turn.role === 'tool') {
      const owner = [...out].reverse().find((t) => t.role === 'assistant');
      if (owner?.toolCalls?.some((c) => c.id === turn.toolCallId))
        out.push(turn);
      continue;
    }
    out.push(turn);
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      const answered = new Set();
      for (
        let j = i + 1;
        j < thread.length && thread[j].role === 'tool';
        j += 1
      )
        answered.add(thread[j].toolCallId);
      for (const call of turn.toolCalls)
        if (!answered.has(call.id))
          thread.splice(i + 1, 0, {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            result: '{"ok":false,"error":"cancelled by operator"}',
          });
    }
  }
  return out;
}

/** Only the newest operator turn carries its images upstream. */
export function wireMessages(thread) {
  const lastUser = thread.map((t) => t.role).lastIndexOf('user');
  return thread.map((turn, index) => {
    if (turn.role === 'user')
      return {
        role: 'user',
        text: turn.text,
        ...(index === lastUser && turn.images?.length
          ? { images: turn.images }
          : {}),
      };
    if (turn.role === 'assistant')
      return {
        role: 'assistant',
        text: turn.text || '',
        toolCalls: turn.toolCalls || [],
      };
    return {
      role: 'tool',
      toolCallId: turn.toolCallId,
      name: turn.name,
      result: turn.result,
    };
  });
}

export const ACTION_LOG_KEY = 'adam.shepherd.actions.v1';
const ACTION_LOG_MAX = 300;

/** One audit line for a tool call: what was asked, what came back. */
export function actionLogEntry(call, result, at = Date.now()) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  let ok = true;
  try {
    const parsed = JSON.parse(text);
    ok = parsed?.ok !== false && !parsed?.error;
  } catch {
    ok = !/error/i.test(String(text).slice(0, 80));
  }
  return {
    at,
    tool: String(call?.name || '').slice(0, 60),
    args: JSON.stringify(call?.args ?? {}).slice(0, 300),
    ok,
    result: String(text ?? '').slice(0, 240),
  };
}

export function createShepherdAgent({
  client,
  executor,
  memory,
  getConsoleBlock,
  onEvent = () => {},
}) {
  let thread = [];
  let controller = null;
  let prefs = { provider: null, model: null };
  const ready = Promise.all([memory.loadThread(), memory.loadPrefs()]).then(
    ([saved, savedPrefs]) => {
      thread = repairThread(saved);
      prefs = { ...prefs, ...savedPrefs };
    },
  );

  const persist = () => memory.saveThread(thread).catch(() => {});

  // Operator-facing audit trail of every tool Shepherd ran.
  const store = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  })();
  let actionLog = [];
  try {
    actionLog = JSON.parse(store?.getItem(ACTION_LOG_KEY) || '[]');
    if (!Array.isArray(actionLog)) actionLog = [];
  } catch {
    actionLog = [];
  }
  const logAction = (entry) => {
    actionLog = [...actionLog, entry].slice(-ACTION_LOG_MAX);
    try {
      store?.setItem(ACTION_LOG_KEY, JSON.stringify(actionLog));
    } catch {
      /* storage full */
    }
  };

  async function send({ text, images = [], task = 'chat', display = null }) {
    await ready;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const userTurn = {
      role: 'user',
      text: String(text || '').trim(),
      images,
      at: Date.now(),
    };
    if (display) userTurn.display = String(display).slice(0, 400);
    thread.push(userTurn);
    thread = trimThread(repairThread(thread), THREAD_LIMIT);
    onEvent({ type: 'user', turn: userTurn });
    let rounds = 0;
    try {
      while (rounds < MAX_TOOL_ROUNDS && !signal.aborted) {
        rounds += 1;
        const assistant = {
          role: 'assistant',
          text: '',
          toolCalls: [],
          at: Date.now(),
        };
        onEvent({ type: 'assistant-start', turn: assistant, round: rounds });
        const stream = client.chat({
          messages: wireMessages(thread),
          console: getConsoleBlock(),
          provider: prefs.provider || undefined,
          model: prefs.model || undefined,
          task,
          signal,
        });
        let failed = null;
        for await (const event of stream) {
          if (event.type === 'text') {
            assistant.text += event.delta;
            onEvent({ type: 'delta', delta: event.delta, turn: assistant });
          } else if (event.type === 'tool_call') {
            assistant.toolCalls.push({
              id: event.id,
              name: event.name,
              args: event.args || {},
            });
          } else if (event.type === 'error') {
            failed = event.error;
          } else {
            onEvent(event);
          }
        }
        thread.push(assistant);
        onEvent({ type: 'assistant-end', turn: assistant });
        if (failed) {
          onEvent({ type: 'error', error: failed });
          break;
        }
        if (!assistant.toolCalls.length) break;
        for (const call of assistant.toolCalls) {
          if (signal.aborted) break;
          onEvent({ type: 'tool-start', call });
          const result = await executor.run(call.name, call.args, { signal });
          thread.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            result,
          });
          logAction(actionLogEntry(call, result));
          onEvent({ type: 'tool-end', call, result });
        }
        if (rounds === MAX_TOOL_ROUNDS)
          onEvent({ type: 'notice', text: 'tool round limit reached' });
      }
    } catch (error) {
      if (!signal.aborted)
        onEvent({
          type: 'error',
          error: error?.message || String(error),
          status: error?.status,
          body: error?.body,
        });
    } finally {
      thread = repairThread(thread);
      if (controller?.signal === signal) controller = null;
      onEvent({ type: 'idle' });
      void persist();
    }
  }

  return {
    ready,
    send,
    abort() {
      controller?.abort();
    },
    busy: () => Boolean(controller),
    thread: () => thread,
    /** Tool-call audit trail, newest last. */
    actionLog: () => actionLog.slice(),
    clearActionLog() {
      actionLog = [];
      try {
        store?.setItem(ACTION_LOG_KEY, '[]');
      } catch {
        /* ignore */
      }
    },
    /** The last assistant reply, for a second opinion. */
    lastAnswer() {
      for (let i = thread.length - 1; i >= 0; i -= 1)
        if (thread[i].role === 'assistant' && thread[i].text)
          return thread[i].text;
      return '';
    },
    async clear() {
      controller?.abort();
      thread = [];
      await memory.clearThread();
    },
    prefs: () => ({ ...prefs }),
    async setPrefs(next) {
      prefs = { ...prefs, ...next };
      await memory.savePrefs(prefs);
    },
  };
}
