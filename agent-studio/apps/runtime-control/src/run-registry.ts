/**
 * run-registry.ts — in-process run cancellation registry for EXECUTION_MODE=inline.
 *
 * Engine→Studio CancelRun lands here while a run is executing in THIS process:
 * the registry owns the run-scoped AbortController whose signal is wired into
 * the Model Gateway stream/generate calls, so a cancel aborts the in-flight
 * provider request instead of letting it run to completion (FL-1.3). In
 * Temporal mode cancellation flows through the workflow signal instead and
 * this registry is unused.
 *
 * The registry never owns run state — Engine is the system of record. An
 * abort here only stops local work; the run's CANCELED state was already
 * persisted Engine-side before the RPC reached Studio.
 */

export interface RunCancellationHandle {
  /** Signal wired into gateway calls and between-turn checks. */
  signal: AbortSignal;
  /** Idempotent local teardown — releases the registry slot. */
  done: () => void;
}

export class RunCancellationRegistry {
  private readonly active = new Map<string, { controller: AbortController; reason: string }>();

  /** Register an active run. Returns its cancellation handle. */
  register(runId: string): RunCancellationHandle {
    // A stale slot for the same run (crashed executor that never called done)
    // must not leak an old controller — a fresh execution replaces it.
    const existing = this.active.get(runId);
    if (existing) {
      existing.controller.abort('superseded');
    }
    const controller = new AbortController();
    this.active.set(runId, { controller, reason: '' });
    return {
      signal: controller.signal,
      done: () => {
        const current = this.active.get(runId);
        if (current && current.controller === controller) {
          this.active.delete(runId);
        }
      },
    };
  }

  /**
   * Cancel the in-flight run. Returns false when no local execution is
   * registered (the run finished, was never inline, or another process owns
   * it) — the caller falls back to the Temporal/MCP paths.
   */
  cancel(runId: string, reason: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.reason = reason;
    entry.controller.abort(reason);
    return true;
  }

  isCancelled(runId: string): boolean {
    return this.active.get(runId)?.controller.signal.aborted ?? false;
  }

  /** Last cancel reason observed for the run ('' when none). */
  reason(runId: string): string {
    return this.active.get(runId)?.reason ?? '';
  }

  activeCount(): number {
    return this.active.size;
  }
}
