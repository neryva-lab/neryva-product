# ADR-006: LiteLLM Only Behind Model Gateway for Separate Network Boundary

- **Status:** Accepted (Phase 0.3a)
- **Date:** 2026-09-02
- **Context:** `agent_studio_architecture.md:444` — LiteLLM may be evaluated as optional self-hosted
  gateway route for customers requiring separate provider boundary. Its unified
  interface/routing/fallback/virtual-key/spend-tracking are useful, but it introduces another
  service and Python operational dependency.
- **Decision:** Evaluate LiteLLM **only** as optional route _behind_ Neryva Model Gateway contract
  for deployments needing separate network boundary or provider gateway. It must remain behind
  `NeryvaModelRequest/Response` types (`432`) and capability registry (`406`), never become core
  dependency. Fallback via LiteLLM still requires explicit, auditable policy and must preserve
  output/tool/schema compat + retention/residency (`920`).
- **Consequences:** No LiteLLM in `packages/model-gateway` core path for v1. If added, ADR update +
  spike evaluation + provider conformance (`tests/providers/*.test.ts`) required. Do not copy
  LiteLLM routing as Studio's primary failover — Studio's `routing.ts` remains authoritative.
- **References:** `agent_studio_architecture.md:444`, `agent_studio_implementation_plan.md:858-920`
