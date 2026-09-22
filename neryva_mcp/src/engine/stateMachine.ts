/**
 * Run state machine — monotonic, Engine-owned, CAS with expected_version.
 * Reference: neryva_mcp_implementation_plan.md:414-452, RunState enum + 7 rules
 */

import { RunState } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { concurrencyError, lifecycleError } from "../shared/errors.js";

// Allowed transitions map. Terminal states are immutable (except repair, out of scope for spike).
const allowed: Record<RunState, RunState[]> = {
  [RunState.UNSPECIFIED]: [],
  [RunState.QUEUED]: [RunState.CLAIMED, RunState.CANCELLED, RunState.EXPIRED],
  [RunState.CLAIMED]: [RunState.RUNNING, RunState.CANCELLED, RunState.EXPIRED],
  [RunState.RUNNING]: [RunState.WAITING_APPROVAL, RunState.WAITING_INPUT, RunState.CANCELLING, RunState.SUCCEEDED, RunState.FAILED, RunState.CANCELLED, RunState.EXPIRED],
  [RunState.WAITING_APPROVAL]: [RunState.RUNNING, RunState.CANCELLING, RunState.EXPIRED, RunState.CANCELLED, RunState.FAILED],
  [RunState.WAITING_INPUT]: [RunState.RUNNING, RunState.CANCELLING, RunState.EXPIRED, RunState.CANCELLED, RunState.FAILED],
  [RunState.CANCELLING]: [RunState.CANCELLED, RunState.FAILED],
  [RunState.SUCCEEDED]: [],
  [RunState.FAILED]: [],
  [RunState.CANCELLED]: [],
  [RunState.EXPIRED]: [],
};

const terminal = new Set<RunState>([RunState.SUCCEEDED, RunState.FAILED, RunState.CANCELLED, RunState.EXPIRED]);

export function isTerminal(s: RunState): boolean {
  return terminal.has(s);
}

export function assertCanTransition(from: RunState, to: RunState): void {
  if (isTerminal(from)) {
    throw lifecycleError(`terminal run in ${RunState[from]} rejects mutation to ${RunState[to]}`);
  }
  const next = allowed[from] ?? [];
  if (!next.includes(to)) {
    throw lifecycleError(`illegal transition ${RunState[from]} -> ${RunState[to]}`);
  }
}

/**
 * CAS helper — validates expected_version matches current version, else ABORTED.
 * Reference: neryva_mcp_implementation_plan.md:444 rule 2
 */
export function assertExpectedVersion(currentVersion: bigint | number, expected: bigint | number): void {
  const cur = typeof currentVersion === "bigint" ? currentVersion : BigInt(currentVersion);
  const exp = typeof expected === "bigint" ? expected : BigInt(expected);
  if (cur !== exp) {
    throw concurrencyError(`stale version: expected ${exp} but current is ${cur} — ABORTED`);
  }
}

export function runStateName(s: RunState): string {
  return RunState[s] ?? `UNKNOWN(${s})`;
}
