# ADR-004: Node.js LTS for Temporal Workers, Model Adapters Avoid Node-Only Assumptions

- **Status:** Accepted (Phase 0.3a)
- **Date:** 2026-09-02
- **Context:** `agent_studio_architecture.md:35-37` — Runtime should remain Node.js-based because
  Temporal TypeScript workers are Node.js workloads. Model-adapter code should avoid unnecessary
  Node-only assumptions where practical, but edge deployment is optional optimization for
  gateway/streaming endpoints, not requirement for Agent Studio runtime.
- **Decision:** Use Node.js LTS (`22.x` per `toolchain.md`) for all `runtime-worker` and
  `tool-worker` deployments (they rely on `worker_threads`, `vm`, `AsyncLocalStorage` per Temporal
  SDK). Keep model-adapter code (`packages/model-gateway/src/providers/*`) free of Node-only APIs
  where feasible to allow future edge use for gateway/streaming. First production deployment is Node
  containers on Kubernetes, not edge (`30-32`).
- **Consequences:** No dual TypeScript+Python Studio for v1 (`95`). Worker-level Temporal features
  run only on authentic Node.js, not Bun/Deno/Workers edge for now (SDK docs).
- **References:** `agent_studio_architecture.md:35-37`, `81-96`
