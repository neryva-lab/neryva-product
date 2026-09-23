/**
 * terminal-failure.ts — A2-68: classify a workflow-catch failure into a
 * specific terminal error code + message for the Engine `run.failed` event
 * and `runs.terminal_reason`.
 *
 * Pure and deterministic (string/regex reads only — safe in workflow code).
 * Temporal wraps activity errors: the workflow sees `ActivityFailure`
 * ("Activity task failed") whose `.cause` chain ends at the real
 * `ApplicationFailure` (e.g. the NeryvaProviderError `callModel` threw when
 * the model proposed a tool outside the pinned policy). Without unwrapping,
 * every failure surfaces as code=FAILED / "Activity task failed" and the
 * specific cause is lost.
 */
export interface TerminalFailure {
  /** Short machine code for runs.terminal_reason (Engine slices to 64). */
  code: string;
  /** Human-actionable message for the run.failed event payload. */
  message: string;
}

interface ChainLink {
  name?: string;
  type?: string;
  message: string;
}

function failureChain(err: unknown): ChainLink[] {
  const chain: ChainLink[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const link: ChainLink = {
      name: cur.name,
      message: cur.message,
    };
    const linkType = (cur as { type?: unknown }).type;
    if (typeof linkType === 'string') link.type = linkType;
    chain.push(link);
    const cause = (cur as { cause?: unknown }).cause;
    if (!(cause instanceof Error)) break;
    cur = cause;
  }
  return chain;
}

export function classifyTerminalFailure(err: unknown): TerminalFailure {
  const chain = failureChain(err);
  const root = chain[chain.length - 1];
  const message = root?.message ?? (err instanceof Error ? err.message : String(err));
  const rootType = root?.type ?? root?.name;

  // Tool-policy denial: the model proposed a tool outside the pinned policy,
  // e.g. "Model tried to call unavailable tool 'create_ticket'. Available
  // tools: search_tickets." Name the tool so the UI can say something
  // actionable instead of "Activity task failed".
  const denied = /tried to call unavailable tool '([^']+)'/i.exec(message);
  if (denied) {
    return { code: 'TOOL_POLICY_DENIED', message: `tool policy denied: ${denied[1]}` };
  }
  // Typed provider failures keep a stable code.
  if (rootType === 'NeryvaProviderError') {
    return { code: 'PROVIDER_ERROR', message };
  }
  return { code: 'FAILED', message };
}
