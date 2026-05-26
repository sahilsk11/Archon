import type { MessageChunk } from '@archon/providers/types';
import type { KannaExecutionConfig, KannaExecutionOptions } from './schemas';

type KannaProvider = 'claude' | 'codex';
type KannaStatus = 'idle' | 'starting' | 'running' | 'waiting_for_user' | 'failed';

type KannaSubscriptionTopic =
  | { type: 'chat'; chatId: string; recentLimit?: number }
  | { type: 'local-projects' };

type KannaClientCommand =
  | { type: 'project.open'; localPath: string }
  | { type: 'task.create'; localPath: string; title: string }
  | { type: 'chat.create'; projectId: string; taskId?: string | null }
  | { type: 'chat.rename'; chatId: string; title: string }
  | {
      type: 'chat.send';
      chatId: string;
      clientTraceId?: string;
      provider?: KannaProvider;
      content: string;
      model?: string;
      effort?: string;
    };

type KannaServerEnvelope =
  | { v: 1; type: 'snapshot'; id: string; snapshot: KannaServerSnapshot }
  | { v: 1; type: 'ack'; id: string; result?: unknown }
  | { v: 1; type: 'error'; id?: string; message: string }
  | { v: 1; type: 'event'; id: string; event: unknown };

type KannaServerSnapshot =
  | { type: 'chat'; data: KannaChatSnapshot | null }
  | { type: 'local-projects'; data: KannaLocalProjectsSnapshot }
  | { type: string; data: unknown };

interface KannaChatSnapshot {
  runtime: {
    status: KannaStatus;
  };
  messages: KannaTranscriptEntry[];
}

type KannaTranscriptEntry =
  | { kind: 'assistant_text'; id?: string; text: string; hidden?: boolean }
  | { kind: 'status'; id?: string; status: string; hidden?: boolean }
  | {
      kind: 'tool_call';
      id?: string;
      hidden?: boolean;
      tool?: { toolName?: string; toolId?: string; input?: unknown };
    }
  | { kind: 'tool_result'; id?: string; hidden?: boolean; toolId?: string; content: unknown }
  | {
      kind: 'result';
      id?: string;
      hidden?: boolean;
      subtype?: 'success' | 'error' | 'cancelled';
      isError?: boolean;
      result?: string;
      costUsd?: number;
    }
  | { kind: 'interrupted'; id?: string; hidden?: boolean; reason?: string; detail?: string }
  | { kind: string; id?: string; hidden?: boolean; [key: string]: unknown };

interface KannaLocalProjectsSnapshot {
  tasks: {
    id: string;
    title: string;
    localPath: string;
  }[];
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface RunTarget {
  projectId: string;
  taskId: string | null;
  firstChatId?: string;
}

interface KannaRunOptions {
  prompt: string;
  cwd: string;
  provider: string;
  model?: string;
  resumeSessionId?: string;
  workflowRunId: string;
  workflowName: string;
  nodeId: string;
  config: KannaExecutionOptions;
  abortSignal?: AbortSignal;
}

const DEFAULT_KANNA_BASE_URL = 'http://localhost:3210';
const DEFAULT_KANNA_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KANNA_CHAT_TITLE_TEMPLATE = '{{nodeId}}';
const OPEN_STATE = 1;

const targetsByRun = new Map<string, Promise<RunTarget>>();

function normalizeOptions(
  config: KannaExecutionConfig | undefined
): KannaExecutionOptions | undefined {
  if (config === undefined || config === false) return undefined;
  if (config === true) return {};
  if (config.enabled === false) return undefined;
  return config;
}

export function resolveKannaExecutionOptions(
  workflowConfig: KannaExecutionConfig | undefined,
  nodeConfig: KannaExecutionConfig | undefined
): KannaExecutionOptions | undefined {
  const workflow = normalizeOptions(workflowConfig);
  const node = normalizeOptions(nodeConfig);
  if (nodeConfig === false || (typeof nodeConfig === 'object' && nodeConfig.enabled === false)) {
    return undefined;
  }
  if (workflow && node) return { ...workflow, ...node };
  return node ?? workflow;
}

function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function renderTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key: string) => values[key] ?? ''
  );
}

function titleFromTemplate(template: string, values: Record<string, string | undefined>): string {
  return renderTemplate(template, values).replace(/\s+/g, ' ').trim() || 'Archon node';
}

function chatIdFromKannaSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId?.startsWith('kanna:')) return undefined;
  const parts = sessionId.split(':');
  return parts.length >= 5 ? parts.slice(4).join(':') : undefined;
}

function entryKey(entry: KannaTranscriptEntry, index: number): string {
  return typeof entry.id === 'string' ? entry.id : `${entry.kind}:${index}`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '[unserializable tool output]';
  }
}

function mapEntry(entry: KannaTranscriptEntry): MessageChunk[] {
  if (entry.hidden) return [];
  const record = entry as Record<string, unknown>;
  switch (entry.kind) {
    case 'assistant_text': {
      const text = typeof record.text === 'string' ? record.text : '';
      return text ? [{ type: 'assistant', content: text }] : [];
    }
    case 'status': {
      const status = typeof record.status === 'string' ? record.status : '';
      return status ? [{ type: 'system', content: status }] : [];
    }
    case 'tool_call': {
      const tool = objectRecord(record.tool);
      const toolName = typeof tool?.toolName === 'string' ? tool.toolName : undefined;
      if (!toolName) return [];
      return [
        {
          type: 'tool',
          toolName,
          toolCallId: typeof tool?.toolId === 'string' ? tool.toolId : undefined,
          toolInput: objectRecord(tool?.input),
        },
      ];
    }
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          toolName: 'tool',
          toolCallId: typeof record.toolId === 'string' ? record.toolId : undefined,
          toolOutput: stringifyContent(record.content),
        },
      ];
    default:
      return [];
  }
}

function terminalState(
  entries: KannaTranscriptEntry[]
): Partial<MessageChunk & { type: 'result' }> {
  const terminal = entries.find(
    entry => !entry.hidden && (entry.kind === 'result' || entry.kind === 'interrupted')
  );
  if (!terminal) return {};
  const record = terminal as Record<string, unknown>;
  if (terminal.kind === 'interrupted') {
    const detail = typeof record.detail === 'string' ? record.detail : undefined;
    return {
      isError: true,
      stopReason: typeof record.reason === 'string' ? record.reason : 'interrupted',
      errors: detail ? [detail] : undefined,
    };
  }
  const subtype = typeof record.subtype === 'string' ? record.subtype : undefined;
  const result = typeof record.result === 'string' ? record.result : undefined;
  return {
    isError: Boolean(record.isError) || subtype === 'error',
    stopReason: subtype,
    cost: typeof record.costUsd === 'number' ? record.costUsd : undefined,
    errors: record.isError && result ? [result] : undefined,
  };
}

function isLocalProjectsSnapshot(data: unknown): data is KannaLocalProjectsSnapshot {
  const snapshot = objectRecord(data);
  return Array.isArray(snapshot?.tasks);
}

function isChatSnapshot(data: unknown): data is KannaChatSnapshot {
  const snapshot = objectRecord(data);
  const runtime = objectRecord(snapshot?.runtime);
  return typeof runtime?.status === 'string' && Array.isArray(snapshot?.messages);
}

class KannaSocket {
  private ws?: WebSocket;
  private openPromise?: Promise<void>;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly subscriptions = new Map<string, (envelope: KannaServerEnvelope) => void>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === OPEN_STATE) return;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        resolve();
      });
      ws.addEventListener('message', event => {
        this.handleMessage(event.data);
      });
      ws.addEventListener('close', () => {
        this.rejectPending(new Error('Kanna WebSocket closed'));
      });
      ws.addEventListener('error', () => {
        reject(new Error(`Failed to connect to Kanna at ${this.url}`));
      });
    }).finally(() => {
      this.openPromise = undefined;
    });

    return this.openPromise;
  }

  async command<TResult>(command: KannaClientCommand): Promise<TResult> {
    await this.connect();
    const id = crypto.randomUUID();
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send({ v: 1, type: 'command', id, command });
    });
  }

  async subscribe(
    topic: KannaSubscriptionTopic,
    onEnvelope: (envelope: KannaServerEnvelope) => void
  ): Promise<() => void> {
    await this.connect();
    const id = crypto.randomUUID();
    this.subscriptions.set(id, onEnvelope);
    this.send({ v: 1, type: 'subscribe', id, topic });
    return () => {
      this.subscriptions.delete(id);
      this.send({ v: 1, type: 'unsubscribe', id });
    };
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
    this.rejectPending(new Error('Kanna WebSocket closed'));
  }

  private send(envelope: unknown): void {
    if (this.ws?.readyState !== OPEN_STATE) {
      throw new Error('Kanna WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(envelope));
  }

  private handleMessage(data: unknown): void {
    let envelope: KannaServerEnvelope;
    try {
      envelope = JSON.parse(String(data)) as KannaServerEnvelope;
    } catch {
      return;
    }
    if (envelope.type === 'ack') {
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      pending.resolve(envelope.result);
      return;
    }
    if (envelope.type === 'error') {
      if (!envelope.id) return;
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      pending.reject(new Error(envelope.message));
      return;
    }
    this.subscriptions.get(envelope.id)?.(envelope);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function readLocalProjects(socket: KannaSocket): Promise<KannaLocalProjectsSnapshot> {
  return new Promise<KannaLocalProjectsSnapshot>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let received = false;
    socket
      .subscribe({ type: 'local-projects' }, envelope => {
        if (envelope.type !== 'snapshot' || envelope.snapshot.type !== 'local-projects') return;
        if (!isLocalProjectsSnapshot(envelope.snapshot.data)) return;
        received = true;
        unsubscribe?.();
        resolve(envelope.snapshot.data);
      })
      .then(value => {
        unsubscribe = value;
        if (received) unsubscribe();
      })
      .catch(reject);
  });
}

async function resolveRunTarget(
  socket: KannaSocket,
  localPath: string,
  config: KannaExecutionOptions
): Promise<RunTarget> {
  if (config.taskId?.trim()) {
    const project = await socket.command<{ projectId: string }>({
      type: 'project.open',
      localPath,
    });
    return { projectId: project.projectId, taskId: config.taskId.trim() };
  }

  if (!config.taskName?.trim()) {
    const project = await socket.command<{ projectId: string }>({
      type: 'project.open',
      localPath,
    });
    return { projectId: project.projectId, taskId: null };
  }

  const taskName = config.taskName.trim();
  const snapshot = await readLocalProjects(socket);
  const matches = snapshot.tasks.filter(task => task.title === taskName);
  const samePath = matches.find(task => task.localPath === localPath);
  const task = samePath ?? matches[0];
  if (task) {
    const project = await socket.command<{ projectId: string }>({
      type: 'project.open',
      localPath,
    });
    return { projectId: project.projectId, taskId: task.id };
  }

  const created = await socket.command<RunTarget & { chatId: string }>({
    type: 'task.create',
    localPath,
    title: taskName,
  });
  return {
    projectId: created.projectId,
    taskId: created.taskId,
    firstChatId: created.chatId,
  };
}

function providerForKanna(provider: string): KannaProvider | undefined {
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

export async function* runPromptViaKanna(options: KannaRunOptions): AsyncGenerator<MessageChunk> {
  const config = options.config;
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_KANNA_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_KANNA_TIMEOUT_MS;
  const localPath = config.localPath?.trim() || options.cwd;
  const runKey = `${baseUrl}:${options.workflowRunId}:${localPath}:${config.taskId ?? config.taskName ?? 'unassigned'}`;
  const chatTitle = titleFromTemplate(
    config.chatTitleTemplate ?? DEFAULT_KANNA_CHAT_TITLE_TEMPLATE,
    {
      workflowRunId: options.workflowRunId,
      workflowName: options.workflowName,
      nodeId: options.nodeId,
      cwd: localPath,
      provider: options.provider,
      model: options.model,
    }
  );

  const socket = new KannaSocket(toWebSocketUrl(baseUrl));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const seen = new Set<string>();
  let lastStatus: KannaStatus | undefined;
  let terminal: Partial<MessageChunk & { type: 'result' }> = {};
  const queue: MessageChunk[] = [];
  let done = false;
  let resolveNext: (() => void) | undefined;

  const push = (chunk: MessageChunk): void => {
    queue.push(chunk);
    resolveNext?.();
    resolveNext = undefined;
  };
  const close = (): void => {
    done = true;
    resolveNext?.();
    resolveNext = undefined;
  };
  const next = async (): Promise<MessageChunk | undefined> => {
    while (!queue.length && !done) {
      await new Promise<void>(resolve => {
        resolveNext = resolve;
      });
    }
    return queue.shift();
  };

  try {
    let targetPromise = targetsByRun.get(runKey);
    if (!targetPromise) {
      targetPromise = resolveRunTarget(socket, localPath, config).catch(error => {
        targetsByRun.delete(runKey);
        throw error;
      });
      targetsByRun.set(runKey, targetPromise);
    }
    const target = await targetPromise;

    const resumedChatId = chatIdFromKannaSessionId(options.resumeSessionId);
    const chatId =
      resumedChatId ??
      target.firstChatId ??
      (
        await socket.command<{ chatId: string }>({
          type: 'chat.create',
          projectId: target.projectId,
          taskId: target.taskId,
        })
      ).chatId;
    if (!resumedChatId) {
      delete target.firstChatId;
      await socket.command({ type: 'chat.rename', chatId, title: chatTitle });
    }

    unsubscribe = await socket.subscribe({ type: 'chat', chatId, recentLimit: 200 }, envelope => {
      if (envelope.type !== 'snapshot' || envelope.snapshot.type !== 'chat') return;
      if (!isChatSnapshot(envelope.snapshot.data)) return;
      const snapshot = envelope.snapshot.data;
      if (snapshot.runtime.status !== lastStatus) {
        push({ type: 'system', content: `Kanna status: ${snapshot.runtime.status}` });
        lastStatus = snapshot.runtime.status;
      }
      snapshot.messages.forEach((entry, index) => {
        const key = entryKey(entry, index);
        if (seen.has(key)) return;
        seen.add(key);
        for (const chunk of mapEntry(entry)) push(chunk);
      });
      terminal = terminalState(snapshot.messages);
      if (terminal.stopReason || terminal.isError || snapshot.runtime.status === 'failed') close();
    });

    await socket.command({
      type: 'chat.send',
      chatId,
      content: options.prompt,
      provider: providerForKanna(options.provider),
      model: options.model,
      clientTraceId: crypto.randomUUID(),
    });

    timeout = setTimeout(() => {
      push({
        type: 'result',
        isError: true,
        errorSubtype: 'timeout',
        errors: [`Kanna run timed out after ${timeoutMs}ms`],
      });
      close();
    }, timeoutMs);

    while (!options.abortSignal?.aborted) {
      const chunk = await next();
      if (!chunk) break;
      if (chunk.type === 'result') {
        yield chunk;
        return;
      }
      yield chunk;
    }

    yield {
      type: 'result',
      sessionId: `kanna:${encodeURIComponent(baseUrl)}:${target.projectId}:${target.taskId ?? 'unassigned'}:${chatId}`,
      ...terminal,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe?.();
    socket.close();
  }
}

export function resetKannaTransportForTests(): void {
  targetsByRun.clear();
}
