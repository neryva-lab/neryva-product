# FL-2.11 — Sandbox spike → `code_interpreter` (design decision)

**Status:** DECIDED (spike conclusion) · **Owner:** Agent Studio · **Date:** 2026-09-12

## Decision

Adopt **an HTTP sandbox-worker boundary** as the integration contract, with a
self-hosted **E2B-compatible API** (E2B OSS or Daytona) as the reference
backend. Cloudflare Sandboxes is ruled out for v1: no per-run filesystem
persistence and a different auth model complicate the failure-injection
matrix for no near-term gain.

## Rationale

- The tool gateway already grades tools by `executionMode` (`in-process` |
  `activity` | `sandbox`); a sandbox is an **executor**, not a policy change.
  Any backend that speaks a small HTTP protocol can serve it.
- The E2B API shape (`POST /runs` → run code, stream stdout, kill) maps 1:1
  onto `executors/sandbox.ts` and keeps the Temporal/inline paths identical.
- Self-host keeps egress under the tenant policy (`egressClass='none'`
  default for `code_interpreter`), which Cloudflare's model cannot promise.

## Contract

```
POST {SANDBOX_ENDPOINT}/v1/runs      {code, language, env_hash?, timeout_ms}
→ 200 {run_id}
GET  {SANDBOX_ENDPOINT}/v1/runs/:id  → {state, stdout_b64, stderr_b64, exit_code, artifact?}
DELETE {SANDBOX_ENDPOINT}/v1/runs/:id  (kill / reclaim)
```

- Network egress: **denied by default** inside the sandbox; the worker allows
  an explicit host allowlist per tool descriptor (`egressClass='limited'`).
- Results > the inline bound are claim-checked via the Engine
  (`PutRunArtifact`, contract v1.3) and referenced by ArtifactRef.
- Timeouts/CPU/mem are enforced by the sandbox worker; the gateway applies
  its own outer timeout and surfaces `UNKNOWN_OUTCOME` per policy.

## First catalog tool

`code_interpreter` — `READ_ONLY` is **not** achievable for arbitrary code, so
the tool is `MUTATING` (sandbox state) with `approvalRequirement='NONE'`,
`egressClass='none'` (network-denied default), `executionMode='sandbox'`,
`timeoutMs=30_000`, `idempotency='supported'` (run keyed by toolCallId).

## Spike outcome (failure-injection suite)

`executors/sandbox.ts` gains `HttpSandboxExecutor` behind
`TOOL_GATEWAY_SANDBOX_ENDPOINT` (already wired in runtime-worker config);
without the env, `executionMode='sandbox'` tools fail closed with
`SANDBOX_UNCONFIGURED`. The kill -9 / lost-response matrix is inherited from
the gateway's idempotency store (`UNKNOWN_OUTCOME` reconciliation).
