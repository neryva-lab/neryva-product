# ADR-003: Do Not Adopt Mastra / OpenAI Agents SDK / Microsoft Agent Framework as Core

- **Status:** Accepted (Phase 0.3a)
- **Date:** 2026-09-02
- **Context:** `agent_studio_architecture.md:170-191` evaluates Mastra
  (agents/tools/memory/workflows/evals `174`), OpenAI Agents SDK
  (sessions/tools/guardrails/tracing/handoffs `180-184`), Microsoft Agent Framework with Durable
  Extension (`186-189`). Neryva already needs its own Studio, Engine, tenant model, Neryva MCP,
  memory policy, billing. Adopting a full platform would duplicate abstractions and couple to its
  storage/runtime.
- **Decision:** Do **not** make any of these the foundational platform for v1 without long technical
  evaluation. Use for prototypes/internal experiments if useful (`178`). For provider-neutral
  multi-provider needs, Temporal + TypeScript is more portable than Azure/.NET-centric alternatives
  (`186-191`).
- **Consequences:** Own agent definition/model/context/tool policy directly; keep provider
  portability via Vercel AI SDK adapters behind gateway.
- **References:** `agent_studio_architecture.md:170-191`
