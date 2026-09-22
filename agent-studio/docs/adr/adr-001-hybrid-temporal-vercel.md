# ADR-001: Hybrid Temporal + Vercel AI SDK — Build Kernel/MCP Yourself

- **Status:** Accepted (Phase 0.3a)
- **Date:** 2026-09-02
- **Context:** `agent_studio_architecture.md:5-33` proposes hybrid: build Neryva agent runtime +
  Neryva MCP yourself, adopt Temporal for durable execution, use TypeScript + Vercel AI SDK Core
  behind own Model Gateway, plus PostgreSQL (Engine), object storage, OTel, isolated tool execution.
  Need to decide what to adopt vs own (`599-621`).
- **Decision:** Adopt generic infra — Temporal (`agent_studio_architecture.md:35`), Vercel AI SDK
  Core + provider SDKs (`84,428`), OTel (`669`), pgvector initially (`27`), sandbox isolation — and
  **build** product-specific parts: Neryva MCP, agent definition model, Context Compiler, Tool
  Gateway, provider gateway contract, tenant/run semantics, billing/audit integration (`847-856`).
  TypeScript on Node LTS (`81-96`), Temporal workers are Node workloads (`37`).
- **Consequences:** Engine remains system of record; Studio is replaceable execution. Model adapters
  avoid Node-only assumptions for edge optimization (`37`). LiteLLM evaluation remains optional
  behind gateway (`444`), not core.
- **Alternatives considered:** Full platform adoption (Mastra `170`, OpenAI Agents SDK `180`,
  Microsoft Agent Framework `186`) — rejected as overlapping tenant/billing/auth models; pure
  Python/PydanticAI (`93`) — rejected to avoid dual TypeScript+Python Studio for v1.
- **References:** `agent_studio_architecture.md:5-13`, `599-621`, `847-861`
