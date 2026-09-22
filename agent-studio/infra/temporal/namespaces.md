# Temporal Namespaces

| Environment | Namespace              | Retention | Description                                                      | History Archival            |
| ----------- | ---------------------- | --------- | ---------------------------------------------------------------- | --------------------------- |
| dev         | `agent-studio-dev`     | 7 days    | Local dev via Testcontainers / `temporalite`                     | disabled                    |
| staging     | `agent-studio-staging` | 14 days   | Staging, shared cluster per env                                  | disabled                    |
| production  | `agent-studio-prod`    | 30 days   | Production — business history remains in Engine PG, not Temporal | S3 archival after retention |

Notes:

- Engine PostgreSQL is system of record; Temporal stores workflow execution history, run refs, retry
  state, timers, approval waits, bounded checkpoint metadata only
  `agent_studio_architecture.md:575-581`.
- Namespace per environment, not per organization — multi-tenant isolation is via `organization_id`
  in payload + RLS in Engine, not Temporal namespace per org
  `agent_studio_implementation_plan.md:547`.
- Workflow history retention 7d dev / 14d staging / 30d prod `retention.md`. Do not use Temporal as
  canonical customer-data store `148`.

Source: `agent_studio_implementation_plan.md:79`, `agent_studio_architecture.md:28,198,242-246`.
