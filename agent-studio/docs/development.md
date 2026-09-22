# Development Guide — 13 Implementation Rules Before Coding

> **Source:** `agent_studio_implementation_plan.md:59-79` — the team must agree on these rules
> **before Phase 0 is closed**. No implementation should begin by adding a provider SDK, tool, or UI
> before these boundaries exist (`78`). This document is the enforceable checklist.

## Rule 1 — Exact Neryva MCP contract package and compatible version range

- Contract is `neryva.mcp.v1` at `../neryva_mcp/neryva-mcp-contract` (standalone
  `neryva-mcp-contract/proto/neryva/mcp/*/v1/`). See `contracts/mcp/dependency.md` for pinned
  version + range. Studio consumes generated `@neryva/mcp-contract` via `buf generate` with
  `@bufbuild/protobuf@2.14.1` + `@connectrpc/connect@2.1.2`. Never hand-copy. See `toolchain.md`.

## Rule 2 — Supported Node.js LTS line and TypeScript compiler version

- Node `22.x` (Active LTS), TypeScript `5.7.3`, strict `true` (`tsconfig.base.json`). See
  `toolchain.md`, `package.json:engines`, `.nvmrc`. Temporal SDK must be from currently supported
  range at install time (`77`).

## Rule 3 — Package manager, workspace tool, formatter, linter, CI commands

- pnpm `9.12.0` canonical (`pnpm-workspace.yaml`). Formatter `prettier@3.4.0` (100 width, lf),
  linter `eslint@9.18.0` + `typescript-eslint@8.20.0`, CI:
  `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm check:generated && pnpm check:dependencies && pnpm check:container`
  (`agent_studio_implementation_plan.md:1314-1322`). Prettier and ESLint configs are authoritative,
  not per-package overrides.

## Rule 4 — Temporal namespace, task queues, worker identity, payload codec, retention

- Namespace `default` (dev), task queues `agent-run-default`, `agent-run-long`, `tool-read-only`,
  `tool-effectful`, `retrieval-indexing`, `evaluation` (`536-545`). Worker identity
  `agent-studio-worker-{id}`. Payload codec `claim-check` by default, `encrypted` only for bounded
  non-public with documented classification (`839-848`). Retention 7 days dev, per-env override via
  `TEMPORAL_RETENTION_DAYS`.

## Rule 5 — Model provider credential ownership and redaction

- Credentials are secret-manager references (e.g., `arn:aws:secretsmanager:...`), never plaintext in
  `.env.example`, workflow input, logs, definitions, or MCP capability claims (`605`).
  `packages/security/src/secret-provider.ts` owns acquisition. Redaction policy: default `hash-only`
  for prompts/docs/tool args/credentials (`1153-1161`). Verified by `grep` on trace export.

## Rule 6 — Tool effect classes, approval requirements, timeout budgets, idempotency

- `effect_class: READ_ONLY | MUTATING | DESTRUCTIVE` (`970-977`) +
  `approval_requirement: NONE | REQUIRED` orthogonal (`989`). Timeouts per tool class:
  `schedule-to-start` + `start-to-close` + `heartbeat` where applicable (`813-825`). Idempotency:
  stable `run_id + step_id + tool_version` key, persist before ack, `UNKNOWN_OUTCOME` when
  unprovable (`1008-1017`). See `studio-tool-gateway` skill.

## Rule 7 — Maximum sizes for MCP messages, workflow inputs, tool outputs, artifacts, event payloads

- `ARTIFACTS_MAX_INLINE_BYTES=8192`, `ARTIFACTS_MAX_ARTIFACT_BYTES=10485760` (10 MiB), event batch
  bounded (`1080-1089`). Workflow args ideally `<8 KiB` IDs/refs only; reject oversized before
  scheduling (`845`). Large values via claim-check `ArtifactRef` with 8 fields (`674`).

## Rule 8 — Engine capability-token claims and key rotation

- Capability is short-lived, audience `neryva-agent-studio`, bound to `organization_id`,
  `conversation_id`, `run_id`, `agent_version_id`, `actor identity`, `capabilities`,
  `replay protection` (nonce/key version/expiry) (`1177-1192`). Rotation via `kid` overlap, cache
  refresh, no downtime. Every operation re-verifies; mismatch → terminal auth error.

## Rule 9 — Initial supported agent-definition schema version

- `contracts/agent-definition/v1.schema.json` with `agent_id`, `version`, `instructions`,
  `model_policy.allowed_models` (must reference capability registry `406`), `context_policy`,
  `tools[]`, `guardrails` (`357-405`, `688-724`). One immutable version → one stable compiled
  representation (`706`).

## Rule 10 — Supported provider feature matrix

- Per provider: streaming, tools, structured output, usage, cancellation, context limits
  (`773-790`). Initial `openai` (Phase 4), then `anthropic`, `google` (Phase 9). Matrix must be
  explicit and visible; unsupported → typed error, not silent degrade (`1513`). See
  `packages/model-gateway/src/capabilities.ts`.

## Rule 11 — Which data is allowed in traces, logs, Temporal history, diagnostic artifacts

- Default: hashes/sizes/classifications/artifact IDs only. No raw prompts, full docs, tool args,
  credentials, tokens (`1153-1161`). Diagnostic samples only under explicit `content_capture_policy`
  with expiry+authorization (`1157`). Billable usage from Engine ledger, not span sum (`1158`).
  Workflow history small: IDs/refs, not docs (`795`).

## Rule 12 — Minimum failure-injection and tenant-isolation test suite required for every merge

- Must include: workflow replay from history, worker crash at every boundary, heartbeat, Signal
  before/after wait, `Continue-As-New` (`1236-1247`); cross-tenant capability confusion, artifact
  substitution, prompt-injection via retrieved docs (`1266-1276`); duplicate/reordered delivery,
  lease fencing (`property`); tenant-skew load + chaos kill-9 after durable boundary (`1518-1536`).
  See `vitest.workspace.ts` projects `isolation`, `security`, `property`, `chaos`.

## Rule 13 — Encrypted Temporal payload codec and claim-check thresholds for non-public payloads

- Default claim-check for large/sensitive/long-retained; encrypted codec only for bounded non-public
  that must cross workflow/activity boundary (`13`, `839-848`). Thresholds:
  `ARTIFACTS_MAX_INLINE_BYTES` vs `ARTIFACTS_MAX_ARTIFACT_BYTES` + `payload_codec_mode`. Every read
  does fresh authorization; ref ≠ bearer token (`687`). Tested via `size-policy.test.ts` + bundle
  scan.

---

## Enforcement

- These 13 rules are checked in PR template: `docs/architecture/agent_studio/imp/ledger.md:1` task
  ID required + `pnpm check:dependencies` + `pnpm check:generated` green.
- Directory names are contract — rename only via ADR (`447`).
- No provider SDK/tool/UI PR before Phase 0 exit gates `DONE` (`78`).
