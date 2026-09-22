# ADR-002: Do Not Run LangGraph + Temporal Dual Durability for Same Run

- **Status:** Accepted (Phase 0.3a)
- **Date:** 2026-09-02
- **Context:** `agent_studio_architecture.md:145-168` warns LangGraph + Temporal both own
  durability/checkpointing → competing state machines (Temporal + LangGraph + Engine). LangGraph is
  viable for Python/graph-based teams (`147-154`) but creates unnecessary complexity for Neryva's
  TypeScript/Temporal baseline.
- **Decision:** Do **not** use LangGraph and Temporal together for the same run in v1. Use Temporal
  as durable execution layer and build small Neryva agent kernel above it (`165-168`). Borrow
  concepts (nodes, transitions, interrupts, checkpoints) but do not make two frameworks
  authoritative. If a future component uses LangGraph, bound it inside a well-defined Activity or
  make it sole durability for that workload; never place long-running LangGraph checkpointer beside
  Temporal for same run.
- **Consequences:** Single durability owner per workload; no hidden second run state machine.
- **References:** `agent_studio_architecture.md:145-168`,
  `agent_studio_implementation_plan.md:652-663` (no duplicate durability layer table)
