/**
 * Neryva public API SDK (FL-3.15) — a thin, dependency-free client over the
 * L2 conversation plane (`/v1/*`, authenticated with a `nrv_live_` API key).
 * The SDK is a consumer of the documented surface only — it holds no
 * business truth and works against ANY deployment of the Engine.
 */

export interface NeryvaClientOptions {
  /** Engine base URL, e.g. https://engine.example.com (no trailing slash). */
  baseUrl: string;
  /** `nrv_live_...` API key from the Neryva console. */
  apiKey: string;
  /** Dependency injection point for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch | undefined;
}

/** Stable machine-readable error code from the Engine error catalog. */
export class NeryvaApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, retryable: boolean, details?: unknown) {
    super(message);
    this.name = 'NeryvaApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface Conversation {
  id: string;
  assistant_id: string;
  status: string;
  version: number;
  title?: string | null;
  created_at: string;
}

export interface AcceptMessageResult {
  message_id: string;
  run_id: string | null;
  sequence: number;
  conversation_version: number;
  auto_responder?: 'paused';
  replay?: boolean;
}

export interface MessageContentPart {
  text?: string;
  citations?: Array<{ document_id: string; chunk_id: string; source_range: { start: number; end: number } }>;
  suggested_followups?: string[];
  [key: string]: unknown;
}

export interface Message {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: MessageContentPart;
  created_at: string;
}

export interface MessagePage {
  messages: Message[];
  next_cursor: number | null;
}

/** A replayed durable run event (SSE `data:` payload). */
export interface RunStreamEvent {
  /** SSE event name — `delta`, `thinking`, `retrieval`, `terminal`, ... */
  event: string;
  /** engine_sequence — pass as `lastEventId` on reconnect. */
  id?: string;
  data: unknown;
}

const IDEMPOTENT_METHODS = new Set(['POST']);

export class NeryvaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NeryvaClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    if (!options.apiKey || !options.apiKey.startsWith('nrv_live_')) {
      throw new Error('apiKey must be a nrv_live_ key issued by the Neryva console');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ── Conversations ────────────────────────────────────────────────────────

  async createConversation(assistantId: string): Promise<Conversation> {
    const body = await this.request<{ conversation: Conversation }>('POST', '/v1/conversations', { assistant_id: assistantId });
    return body.conversation;
  }

  /**
   * Send a user message and start a run. Idempotent under the same key —
   * a network retry after a lost response returns the ORIGINAL message.
   */
  async sendMessage(
    conversationId: string,
    text: string,
    options?: { idempotencyKey?: string; expectedConversationVersion?: number; attachments?: string[] },
  ): Promise<AcceptMessageResult> {
    return await this.request<AcceptMessageResult>('POST', `/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
      content: { text },
      ...(options?.expectedConversationVersion !== undefined ? { expected_conversation_version: options.expectedConversationVersion } : {}),
      ...(options?.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
      ...(options?.attachments ? { attachments: options.attachments } : {}),
    });
  }

  async listMessages(conversationId: string, options?: { after?: number; limit?: number }): Promise<MessagePage> {
    const query = new URLSearchParams();
    if (options?.after !== undefined) query.set('after', String(options.after));
    if (options?.limit !== undefined) query.set('limit', String(options.limit));
    const qs = query.toString();
    return await this.request<MessagePage>('GET', `/v1/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ''}`);
  }

  /**
   * Stream a run's durable events (SSE). Reconnect by passing the last seen
   * `engine_sequence` as `lastEventId` — replay is identical for a given
   * cursor, so events are never skipped or duplicated.
   */
  async *streamRunEvents(conversationId: string, runId: string, lastEventId = 0): AsyncGenerator<RunStreamEvent, void, undefined> {
    const url = `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/streams/${encodeURIComponent(runId)}${lastEventId > 0 ? `?last_event_id=${lastEventId}` : ''}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      throw await this.toApiError(res);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    const chunks = res.body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) {
          yield parsed;
        }
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(body !== undefined && IDEMPOTENT_METHODS.has(method) ? { 'idempotency-key': newIdempotencyKey() } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw await this.toApiError(res);
    }
    return (await res.json()) as T;
  }

  private async toApiError(res: Response): Promise<NeryvaApiError> {
    let code = 'unknown';
    let message = `HTTP ${res.status}`;
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      details = body.error?.details;
    } catch {
      // body was not JSON — keep the defaults
    }
    return new NeryvaApiError(res.status, code, message, res.status >= 500 || res.status === 429, details);
  }
}

function parseSseFrame(frame: string): RunStreamEvent | null {
  let event = 'message';
  let id: string | undefined;
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data += `${line.slice(5).trim()}\n`;
  }
  if (!data) return null;
  const dataTrimmed = data.trim();
  let parsed: unknown = dataTrimmed;
  try {
    parsed = JSON.parse(dataTrimmed);
  } catch {
    // non-JSON data — pass the raw string
  }
  return id !== undefined ? { event, id, data: parsed } : { event, data: parsed };
}

function newIdempotencyKey(): string {
  return `sdk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
