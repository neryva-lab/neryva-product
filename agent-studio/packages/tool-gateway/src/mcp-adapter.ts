/**
 * mcp-adapter.ts — FL-2.12: external MCP tool connectors.
 *
 * The Tool Gateway can execute tools hosted on EXTERNAL MCP servers
 * (spec 2026-07-28: stateless HTTP transport, `server/discover` for schema
 * discovery with `ttlMs` caching, `tools/call` for invocation). Every call
 * still flows through the gateway's 10-step policy boundary and the Engine's
 * AuthorizeToolCall/RecordToolOutcome — external servers get arguments only
 * after authorization, and their results are recorded like any other tool.
 *
 * Registration: a catalog entry declares `executionMode: 'in-process'` with
 * an httpBinding pointing at the external MCP endpoint; the runtime binds
 * `mcp:<tool>` executors through this adapter.
 */

/** Tools/list response cached per server, TTL honored (`cacheScope: server`). */
interface DiscoverCacheEntry {
  tools: Map<string, unknown>;
  fetchedAt: number;
  ttlMs: number;
}

export interface McpToolCallResult {
  ok: boolean;
  content: unknown;
}

export class McpToolAdapter {
  private static readonly cache = new Map<string, DiscoverCacheEntry>();

  constructor(private readonly endpoint: string) {}

  /**
   * Stateless discovery per MCP 2026-07-28: every POST carries the full
   * initialization payload — no server-side session to leak between tenants.
   * Schemas are cached per endpoint with the server-declared ttlMs.
   */
  async discover(): Promise<Map<string, unknown>> {
    const key = this.endpoint;
    const cached = McpToolAdapter.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
      return cached.tools;
    }
    const res = await fetch(this.endpoint.replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { ttlMs: 300_000 } },
      }),
    });
    if (!res.ok) {
      throw new Error(`mcp discover HTTP ${res.status}`);
    }
    const body = (await res.json()) as { result?: { tools?: Array<{ name: string }>; ttlMs?: number } };
    const tools = new Map<string, unknown>();
    for (const tool of body.result?.tools ?? []) {
      tools.set(String(tool.name), tool);
    }
    McpToolAdapter.cache.set(key, {
      tools,
      fetchedAt: Date.now(),
      ttlMs: Number(body.result?.ttlMs ?? 300_000),
    });
    return tools;
  }

  async call(toolName: string, args: unknown, timeoutMs: number): Promise<McpToolCallResult> {
    const res = await fetch(this.endpoint.replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, content: { error: `mcp call HTTP ${res.status}` } };
    }
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined && body.error !== null) {
      return { ok: false, content: body.error };
    }
    return { ok: true, content: body.result ?? null };
  }
}
