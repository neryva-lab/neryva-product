---
name: studio-verification
description:
  Enforce enterprise verification for Agent Studio — cross-phase contract, Temporal replay,
  isolation, security, provider conformance, load/chaos, and ledger Definition of Done. Use when
  marking ledger DONE, before PR/merge, or auditing isolation, determinism, or production readiness.
---

# Studio Verification — Hardening & Production Readiness (Phase 10, Cross-Phase)

No phase N+1 before phase N exit gates DONE. Every box needs evidence (CI log, conformance test,
audit record, dashboard).

## When to use

- Before marking any `docs/architecture/agent_studio/imp/ledger.md` checkbox `DONE`
- Before PR, merge, or release; after rotation/chaos/load
- Writing tests for idempotency, dedup, CAS, cursors, tenant isolation, artifact substitution, or
  replay
- Handling `pnpm check:*`, SBOM, container scan, SLO, or runbook review

## Workflow — 8 verification families + invariant gates

### 1. Contract tests (`agent_studio_implementation_plan.md:1224-1235`)

- Generated client/server compat (`neryva-mcp-client/tests/conformance.test.ts`)
- Required envelope 8+8 fields
  (`request_id/organization_id/conversation_id/run_id/agent_version_id/correlation_id/protocol_version/idempotency_key` +
  `ArtifactRef` 8 fields `agent_studio_architecture.md:305-321`), UUIDv7 opaque IDs
  (`agent_studio_implementation_plan.md:296-306`), `sha256==32B` (`595`)
- Protocol version negotiation, scope immutability (caller cannot override `org/conv/run` `662`),
  capability expiry/revocation, idempotent retries (only idempotent, never blind retry
  tool/finalization `665`), error mapping, claim-check auth, event payload bounds (`589-596`)

### 2. Temporal tests (`agent_studio_implementation_plan.md:1236-1247`)

- Workflow replay from recorded histories (`workflows/tests/replay.test.ts`); worker crash at every
  activity boundary; `Continue-As-New` carry-over (`continue-as-new.test.ts`); version compat via
  Temporal versioning (`850-856`)
- Activity retry/heartbeat (`heartbeat.test.ts`, `retry-safety.test.ts` — long activities
  `RecordHeartbeat` `agent_studio_architecture.md:137`), Signal before/after wait (`627`), duplicate
  approval/input, cancellation during model/tool/approval waits, terminal finalization retry
  (idempotent `CommitRunResult` via lease epoch fencing)

### 3. Isolation tests (`agent_studio_implementation_plan.md:1266-1276`, `agent_studio_architecture.md:653-667`)

- Cross-tenant capability confusion: every repo/MCP query requires tenant scope or global-reviewed;
  RLS on new tables, object keys namespaced `org/{org_id}/...`, vector collections namespaced
  (`381-383`), cache keys include `organization_id`
- Artifact substitution: tampered `ArtifactRef` rejected, other org artifact unreadable,
  deleted/quarantined → denied
- Tests in `tests/isolation/*` with two orgs × multiple roles/principals

### 4. Security tests (`agent_studio_implementation_plan.md:1265-1276`, `1194-1205`)

- Model/tool policy bypass: model cannot choose unallowlisted tool/model or bypass approval (`1194`)
- Prompt injection via retrieved docs: retrieved content is untrusted, cannot change
  tenant/policy/allowlist/persistence or retrieve credentials (`1196-1204`,
  `agent_studio_architecture.md:556`)
- Secret exfiltration: grep export for raw prompts/credentials/tokens/full docs in
  logs/traces/Temporal history — must be clean (`1153-1161`)
- Capability replay: expired/reused `capability_id` rejected;
  `signature/key version, expiry, not-before, org/conv/run/agent version, actor identity, capabilities, replay protection`
  (`1177-1192`) terminal error, no scope repair
- Dependency/container scanning: `pnpm check:dependencies` DAG + forbidden imports (`491-503`),
  `pnpm check:container` SBOM + signed artifacts

### 5. Provider tests (`agent_studio_implementation_plan.md:1248-1251`)

- Fake providers for deterministic unit tests; sandbox/fixture conformance for real adapters
- 11 cases per provider (`890-904`): streaming, tool round-trip, structured output success/refusal,
  timeout, rate-limit+`retry-after`, auth failure, usage extraction, cancellation, redaction
- Live provider tests only in scheduled pipeline with synthetic data + spending limits; never in PR
  tests

### 6. Tool tests (`agent_studio_implementation_plan.md:1252-1264`)

- Schema rejection, tenant/scope mismatch, approval requirement, credential scoping, egress policy
  (`infra/policies/network-egress/`), timeout/cancellation, duplicate execution (stable
  `run_id+step_id`), lost-response/`UNKNOWN_OUTCOME` (`1016`), redaction/size limits, simulated-sandbox honesty bounds (Wave 3: the old pass-by-construction
  escape-attempt test was deleted; the executor is simulated, not isolated)

### 7. Property, load, chaos (`agent_studio_implementation_plan.md:1518-1536`, `1553-1573`)

- Property: arbitrary duplicate/reordered delivery, concurrent publish/cancel, lease fencing, cursor
  replay with gaps — invariant: retries/duplicates/worker replacements never produce conflicting
  canonical business state
- Load: tenant-skew (`100 orgs / 10k conversations / many workers / one Engine layer`
  `agent_studio_architecture.md:387-392`), history growth, `p50/p95/p99` with version/hardware
  recorded, no copied vendor benchmarks (`442`)
- Chaos/failure-injection via `testkit/fault-injection.ts`: worker crash before/after claim, model
  timeout, tool ambiguous timeout, MCP response lost, approval before/after wait, capability expiry,
  version unpublished, artifact expiry, Redis/broker down, Temporal down, deploy workflow change,
  cancellation — each with expected behavior `1553-1573`; kill-9 after durable boundary must not
  duplicate business effect
- Continue-As-New: measure payload codec + event shape + workload, pick tested safety threshold,
  never hard-code (`139,856`)

### 8. Operational gates (`agent_studio_implementation_plan.md:1518-1536`, `1292-1323`)

- CI must verify: `buf generate` current, workflow bundle deterministic, DAG valid, no forbidden
  DB/provider imports, all providers pass conformance, fixtures contain no prod data, lockfile+SBOM
  updated (`1314-1322`)
- Dashboards/alerts/SLOs: `infra/observability/{dashboards,alerts,service-level-objectives.md}` —
  workflow starts/completions, activity retries, provider latency/errors, tool denials, approval
  age, budget exhaustion, MCP errors, event lag, artifact failures (`1160`); SLOs measured not
  copied (`772`)
- Runbooks (`1574-1592`, `133-143` invariants): worker crash/backlog, stuck claim/lease, MCP
  capability rotation, protocol incompatibility, provider outage, `UNKNOWN_OUTCOME`, approval
  signal, replay/version failure, history growth, artifact failure, retrieval outage, isolation
  incident, prompt injection, secret rotation, redaction failure, noisy-neighbor throttling,
  emergency disablement
- Supply chain: lockfile pinned, SBOM, signed artifacts, `pnpm check:container`, SAST/scanning, code
  signing (`1526`)

## Commands

```bash
buf lint && buf format --diff --exit-code && buf breaking --against '.git#branch=main'
buf generate && git diff --exit-code gen/ts
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
pnpm test:unit && pnpm test:contract && pnpm test:workflow && pnpm test:integration
pnpm test:isolation && pnpm test:security && pnpm test:property
pnpm test:load && pnpm test:chaos
pnpm check:generated && pnpm check:dependencies && pnpm check:container
# secret grep (must be clean)
grep -R --exclude-dir=node_modules --exclude-dir=gen "sk-\|Bearer\|secret" packages/ apps/ contracts/ || true
```

## Definition of Done (DoD) — all must be true (`agent_studio_implementation_plan.md:1594-1611`, `agent_studio_architecture.md:653-671`)

- [ ] Runtime executes pinned `agent_version_id + policy snapshot`; Model Gateway passes provider
      matrix; Context bounded/authorized/reproducible; Tool scoped/auditable/idempotent;
      Approval/cancellation survive restarts; Workflow replay-safe; Claim-check for large/sensitive;
      Durable events + final message via Engine; No Engine DB in Studio; No provider types leak;
      Isolation/redaction/injection tests pass; OTel correlates Engine/MCP/Temporal/provider/tool;
      Build/dep/container/SBOM/load/chaos/eval gates pass; Runbooks + on-call complete
- Plus enterprise `653-671`: tenant-isolated, scoped creds, auditable, deletable, provider-portable,
  allowlisted, metered, regionally deployable

## References

- `agent_studio_implementation_plan.md:1206-1323` test architecture + CI, `1518-1611` hardening +
  DoD, `1553-1592` failure matrix + runbooks
- `agent_studio_architecture.md:133-143` durable constraints, `558-598` persistence, `653-671`
  verification, `772` provider matrix, `669` OTel
- `docs/architecture/agent_studio/imp/ledger.md:250-270` cross-phase checks, `1553-1611` gates

## Exit gates (Phase 10)

- DoD holds; all high-risk threat-model items have evidence; on-call can diagnose/replay/quarantine
  without DB; SLOs measured
