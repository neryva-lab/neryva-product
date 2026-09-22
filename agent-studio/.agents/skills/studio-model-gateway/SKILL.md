---
name: studio-model-gateway
description:
  Implement provider-neutral Model Gateway — Vercel AI SDK adapters, capability registry,
  routing/fallback, and 11-case provider conformance. Use when touching packages/model-gateway,
  contracts/provider, or handling streaming, tool calls, structured output, usage normalization, or
  adding OpenAI/Anthropic/Google adapters.
---

# Studio Model Gateway — Provider-Neutral NeryvaModel* Boundary (Phases 4 & 9)

Only gateway talks to provider SDKs. Types never leak. Vercel AI SDK is an adapter, not your domain
model.

## When to use

- Editing
  `packages/model-gateway/src/{model-gateway,model-catalog,capabilities,routing,retry-policy,usage,errors,redaction,providers/*,adapters/*}.ts`
  (`agent_studio_implementation_plan.md:200-229`)
- Defining `contracts/provider/{model-request,model-response,tool-call,usage,errors}.ts` (`384-394`)
- Adding `openai.ts`, `anthropic.ts`, `google.ts`, or `fake-provider.ts`
- Changing routing, fallback, or usage normalization

## Workflow

### 1. Neryva-owned contracts — define first (`agent_studio_architecture.md:432-439`, `agent_studio_implementation_plan.md:862-886`)

```ts
NeryvaModelRequest |
  NeryvaModelResponse |
  NeryvaStreamEvent |
  NeryvaToolCall |
  NeryvaStructuredOutput |
  NeryvaUsage |
  NeryvaProviderError |
  NeryvaModelCapabilities;
```

Provider SDK types never escape `model-gateway` (`885`). Gateway normalizes: streaming chunks/finish
reasons, tool-call args/provider IDs, structured-output behavior, token usage (input/output/cached),
rate limits + `retry-after`, provider errors/safety refusals, cancellation/timeout (`877-886`). Pin
Vercel AI SDK / official SDK majors; upgrades behind adapter conformance tests (`904`).

### 2. Gateway responsibilities (`agent_studio_architecture.md:409-426`)

Provider adapters + capability registry + org allowlists (`413`) + credentials + failover + rate
limits + token usage normalization + cost calc + redaction + request tracing + error normalization +
data-retention config + optional self-hosted **LiteLLM route** for separate network boundary
(`426,444`) — LiteLLM remains behind gateway contract, never core dependency (`444`).

### 3. Provider adapter contract — 11 cases (`agent_studio_implementation_plan.md:888-904`, `agent_studio_architecture.md:772-790`)

Every adapter passes same suite:
`text generation, streaming+termination, tool-call round-trip, structured output success+refusal, provider timeout, rate-limit+retry-after, invalid request, auth failure, usage extraction, cancellation, sensitive-data redaction`.

Use `packages/model-gateway/src/adapters/ai-sdk-adapter.ts` (Vercel AI SDK Core) or
`official-sdk-adapter.ts` behind boundary. Do not expose library as domain API.

Per-provider checklist (Phase 9 `773-790`): streaming, tool calls, structured output, usage
reporting, context limits, timeout, error normalization, retention config — one provider at a time.

### 4. Routing and fallback (`agent_studio_implementation_plan.md:906-920`)

```
Engine policy snapshot → org allowlist → assistant model_policy.allowed_models → capability requirements → budget/latency → provider health → selected adapter
```

- `allowed_models` must reference capability registry — model cannot select arbitrary string
  (`agent_studio_architecture.md:406`).
- Fallback explicit, auditable, preserves output/tool/schema compat; never bypasses org
  retention/residency (`920`).

### 5. Capabilities and model catalog (`agent_studio_implementation_plan.md:200-207`)

Maintain `model-catalog.ts` (available models), `capabilities.ts`
(streaming/tools/structured-output/context limits per model), `routing.ts` (selection),
`retry-policy.ts` (bounded, respects `retry-after`, never blindly retries effectful), `usage.ts`
(normalization), `errors.ts` (classified), `redaction.ts` (no prompts/creds in logs).

### 6. Tests

- `contract.test.ts` — adapter contract 11 cases per provider (fake provider for unit)
- `routing.test.ts` — allowlist → capability → budget → health selection; fallback paths
- `usage.test.ts` — `NeryvaUsage` vs Engine `usage_ledger_entries` reconciliation (Phases 8-9)
- `providers/openai.test.ts` etc. — live conformance only in scheduled pipeline with synthetic
  data + spending limits (`1250`), never in PR tests

## Anti-patterns

- Letting `ai` (Vercel) or provider SDK types leak as `NeryvaModelRequest` fields
  (`agent_studio_implementation_plan.md:885`).
- Adding fallback that silently degrades `tool` → `text` or bypasses retention/residency (`920`,
  Phase 9 exit gate `1513`).
- Making latency/package-size claims without Neryva workload benchmarks
  (`agent_studio_architecture.md:442`).
- Making LiteLLM a core dependency instead of optional route behind gateway (`444`).

## References

- `agent_studio_implementation_plan.md:858-920` gateway, `200-229` package layout, `906-920` routing
- `agent_studio_architecture.md:409-444` Model Gateway, `772-790` provider matrix, `773` provider
  order
- `docs/architecture/agent_studio/imp/ledger.md:175-190` Phase 4, `190-205` Phase 9

## Exit gates (Phase 4 & 9)

- One provider completes read-only run; provider types never escape; creds only in activities; usage
  via Engine/MCP
- Provider matrix explicit and visible; unsupported features fail clearly (typed error, no silent
  degrade); fallback policy-controlled/auditable; usage normalization reconciled
