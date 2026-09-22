---
name: studio-foundation
description:
  Establish Agent Studio monorepo foundation — pnpm workspace, TypeScript strict, Buf/Protobuf
  generated MCP contract, package DAG, typed config and OTel bootstrap. Use ONLY when initializing
  repo, adding packages, or changing toolchain, contracts/mcp/dependency.md, or infra/temporal
  namespaces.
---

# Studio Foundation — Repository & Contract Baseline (Phase 0)

Phase-gated by `docs/architecture/agent_studio/imp/ledger.md:1`. Do not start Phase 1 before Phase 0
exit gates are `DONE`.

## When to use

- Creating `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`
  (`agent_studio_implementation_plan.md:86-98`)
- Pinning toolchain (Node LTS, TypeScript, Temporal SDK, `@bufbuild/protobuf`,
  `@connectrpc/connect`, Vercel AI SDK majors) (`agent_studio_implementation_plan.md:77`)
- Consuming `neryva.mcp.v1` contract via `contracts/mcp/dependency.md` (not proto source)
  (`agent_studio_implementation_plan.md:616-630`) — Engine contract is already 100% at
  `../neryva_mcp/neryva-mcp-contract/proto`
- Changing package dependency DAG or adding
  `infra/{docker,kubernetes,temporal,policies,observability}`

## Workflow

### 1. 13 implementation rules before coding (`agent_studio_implementation_plan.md:59-79`)

Agree and document in `docs/development.md` + `docs/adr/*`: 1 MCP contract range — 2 Node LTS/TS — 3
pnpm/workspace/formatter/linter/CI — 4 Temporal
namespace/task-queues/worker-identity/payload-codec/retention — 5 credential ownership/redaction — 6
tool effect classes/approval/timeout/idempotency — 7 max sizes (MCP/workflow/tool/artifact/event) —
8 capability claims + rotation — 9 agent-definition schema v1 — 10 provider matrix
(streaming/tools/structured-output/usage/cancellation/context-limits) — 11 allowed trace/log content
— 12 minimum failure-injection + isolation suite — 13 encrypted codec + claim-check thresholds.

### 2. Monorepo skeleton (`agent_studio_implementation_plan.md:18-46`)

```
./package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, tsconfig.json
eslint.config.js, prettier.config.js, vitest.workspace.ts, .env.example, .npmrc
apps/{runtime-worker,runtime-control,tool-worker,eval-worker}
packages/{agent-kernel,agent-definition,context-compiler,model-gateway,tool-gateway,
         memory-retrieval,neryva-mcp-client,workflows,activities,artifacts,telemetry,security,testkit}
contracts/{agent-definition,provider,tool,mcp,events}
infra/{docker,kubernetes,temporal,policies,observability}
tests/{contract,integration,temporal,security,isolation,property,load,chaos,evaluation}
```

First production deploy = `runtime-worker` + `runtime-control` only
(`agent_studio_implementation_plan.md:48`). Other apps are isolation targets, not mandatory day one.

### 3. Neryva MCP contract as pinned dependency (`agent_studio_implementation_plan.md:616-631`)

- Canonical proto lives at `../neryva_mcp/neryva-mcp-contract/proto/neryva/mcp/*/v1/` (`buf.yaml:1`
  STANDARD lint, `buf.gen.yaml:1` `bufbuild/es` + `connectrpc/es` to `gen/ts`).
- Studio consumes pinned `contracts/mcp/dependency.md` version + generated `@neryva/mcp-contract` —
  never hand-copy types. CI fails when pinned version / generated API / conformance baseline drift.
- Never add removed `@connectrpc/protoc-gen-connect-es` (Connect v2 uses `protoc-gen-es`
  descriptors) (`neryva_mcp_implementation_plan.md:210`).

### 4. Package DAG and forbidden imports (`agent_studio_implementation_plan.md:447-503`)

DAG:
`contracts / gen-MCP → kernel/definition → context/model/tool/artifacts → activities → workflows → apps`
(`451`).

**Allowed** (excerpt): `agent-kernel→contracts`, `context-compiler→contracts+definition`,
`model-gateway→provider contracts+adapters`, `workflows→kernel+contracts+Temporal APIs`,
`activities→gateways+MCP+artifacts`, `apps→approved packages`.

**Forbidden** (`491-503`): `pg`/Engine ORM, browser packages in worker, provider SDK in workflow,
`fetch/fs/Date.now/Math.random/process.env/setTimeout` in workflow (use Temporal APIs), raw provider
types escaping `model-gateway`, `any` at auth boundaries, raw prompts/creds in logs, second DB as
source of truth. Enforce via `pnpm check:dependencies` + ESLint import boundaries.

Directory names are contract — rename only via ADR preserving ownership (`447`).

### 5. Typed config and fail-closed startup (`agent_studio_implementation_plan.md:549-615`)

Groups: `runtime` (service_name/build_version/env/shutdown_deadline), `temporal`
(address/namespace/task_queue/worker_identity/bundle_path/payload_codec_mode), `neryva_mcp`
(endpoint/protocol_major/minimum_minor/connect_timeout/request_timeout/capability_issuer),
`model_gateway` (enabled providers/catalog/timeouts/concurrency/redaction), `tool_gateway`
(registry/effect/approval/sandbox/egress), `artifacts` (claim-check mode/max inline + artifact
bytes/allowed purposes), `telemetry` (exporter/sampling/content-capture/metrics namespace).

Secrets are references, not values in `.env.example`. Provider credentials never in workflow
input/logs/definitions/MCP claims (`605`). Fail closed if: Temporal/MCP endpoint missing, protocol
unsupported, provider without credential, unsafe capture in prod, egress without policy,
workflow/activity version mismatch (`607-614`).

### 6. ADRs for weakened decisions (`agent_studio_architecture.md:14,145-191,619`)

Cut ADRs for: hybrid Temporal+Vercel (adopt Temporal, build kernel/MCP yourself `5-13`), no
LangGraph+Temporal dual durability same run (`156`), no Mastra as core (`170`), LiteLLM only behind
`model-gateway` for separate network boundary (`444`), Node LTS for workers + adapters avoid
Node-only assumptions (`37`), durable constraints (`133-143`). Keep in `docs/adr/`.

### 7. Spike PoC (`agent_studio_architecture.md:674-694`)

One Engine endpoint + one MCP connection + one Temporal workflow + one provider + one read-only
tool + one streamed response + simulated crash. Success: resume after crash, no duplicate message,
Engine canonical, bounded payloads via claim-check, correlated spans.

## Anti-patterns

- Adding provider SDK/tool/UI before 13 rules and DAG exist
  (`agent_studio_implementation_plan.md:79`).
- Copying historical Temporal/provider SDK versions instead of pinning from currently supported
  range (`77`).
- Treating `.env.example` as secret store.

## References

- `agent_studio_implementation_plan.md:59-79` rules, `86-127` layout, `447-503` DAG, `549-615`
  config
- `agent_studio_architecture.md:5-33` stack, `674-694` spike
- `docs/architecture/agent_studio/imp/ledger.md:14` phase order, `46-62` Phase 0 checklist

## Exit gates (Phase 0)

- `pnpm lint + format:check + typecheck + build` green with no runtime feature code
- `buf generate && git diff --exit-code gen/ts` + `buf lint && buf breaking` in CI
- `pnpm check:generated` deterministic bundle + `pnpm check:dependencies` DAG green
- Worker startup fails closed on every invalid config; no Engine DB deps; ADRs exist
