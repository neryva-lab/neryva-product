# ADR-005: Durable-Execution Constraints (Heartbeat, Claim-Check, Continue-As-New, Retry Ownership, Idempotency)

- **Status:** Accepted (Phase 0.3a)
- **Date:** 2026-09-02
- **Context:** `agent_studio_architecture.md:133-143` lists 5 constraints more important than any
  framework setting: long Activities heartbeat, large payloads via claim-check, Continue-As-New at
  tested threshold, explicit retry ownership, idempotent tools.
- **Decision:**
  1. Long Activities use `heartbeatTimeout` + `RecordHeartbeat` with checkpoint refs.
  2. Large messages/prompts/docs/tool results/transcripts use claim-check refs (`ArtifactRef`) to
     Engine storage/object storage, not copied into workflow args.
  3. `Continue-As-New` when history approaches tested operational threshold (deployment config from
     Temporal version/payload codec/event shape, not hard-coded event count), with safety margin.
  4. Retry ownership explicit: provider adapters classify errors and expose retry hints, but
     workflow applies one bounded retry policy; respect `retry-after`, never blindly retry effectful
     tool.
  5. Tool side effects idempotent because Activities are at-least-once (derive `run_id + step_id`,
     persist before ack).
- **Consequences:** Proved with failure-injection and history-growth tests (`143`). Workflow inputs
  small: IDs/refs only (`558-598`). Encrypted codec only for bounded non-public that must cross
  boundary (`839-848`).
- **References:** `agent_studio_architecture.md:133-143`, `558-598`,
  `agent_studio_implementation_plan.md:839-848`
