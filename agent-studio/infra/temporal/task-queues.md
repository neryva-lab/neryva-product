# Temporal Task Queues

| Queue                | Workload class                | Worker pool                                           | Concurrency | Description                                                                                                                                         |
| -------------------- | ----------------------------- | ----------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-run-default`  | AgentRunWorkflow + activities | `runtime-worker` (stateless, scaled)                  | 10/activity | Default queue for interactive runs, bounded model/tool loop `agent_studio_architecture.md:376-394`                                                  |
| `agent-run-long`     | Long-running workflows        | `runtime-worker` separate deployment (taint/dedicate) | 5/activity  | For runs exceeding 10 min or flagged long — isolates tail latency from interactive                                                                  |
| `tool-read-only`     | Read-only tools (`READ_ONLY`) | `tool-worker` or `runtime-worker`                     | 20/activity | `search_tickets`, `search_knowledge` — no side effects, higher concurrency                                                                          |
| `tool-effectful`     | Mutating/destructive tools    | `tool-worker` (isolated, egress-restricted)           | 5/activity  | `create_ticket` etc. — idempotent, checkpoint before ack, single attempt unless `UNKNOWN_OUTCOME` reconciliation `agent_studio_architecture.md:141` |
| `retrieval-indexing` | Knowledge indexing            | `runtime-worker` (batch)                              | 10/activity | Async ingestion of knowledge chunks/embeddings — not on critical run path                                                                           |
| `evaluation`         | Offline eval (`eval-worker`)  | `eval-worker`                                         | 2/activity  | Synthetic isolated budgets, marked test data `agent_studio_implementation_plan.md:533`                                                              |

Rules:

- Do not create one worker per organization `agent_studio_implementation_plan.md:547` — shared,
  queue by `conversation_id`, one active run per conversation enforced via Engine lease +
  deterministic WorkflowId `agent-run::runId` `main.md:377`.
- Scale horizontally: workers are stateless, Temporal handles dispatch and retries.
- Each queue has distinct timeout/retry policy per Activity class (see
  `packages/workflows/src/workflow-timeouts.ts` → `packages/activities/src/activity-options.ts`).
- Worker identity from `TEMPORAL_WORKER_IDENTITY` `config.ts`, for audit and task-queue routing.

Source: `agent_studio_implementation_plan.md:539-545`, `agent_studio_architecture.md:242-246`.
