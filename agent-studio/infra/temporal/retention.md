# Temporal Retention

- Workflow execution history retention: **7 days** dev, **14 days** staging, **30 days** production.
- Business (canonical) history — conversations, messages, assistant versions, policies, usage
  ledger, audit — lives in **Engine PostgreSQL** (`conversations`/`messages`/`runs`/`assists`
  `drizzle/0022`), not Temporal `agent_studio_architecture.md:558-597`.
- Temporal retains only bounded workflow refs, retry state, timers, approval waits, checkpoint
  metadata `575-581`.
- Continue-As-New at **measured threshold** (history events `~800`, payload `~512KB`, turns `~30`,
  duration `~10m`) with margin — never hard-coded `75000` folklore
  `agent_studio_architecture.md:139`, `continue-as-new.ts`.
- Payload codec: **claim-check** default for large/sensitive; **encrypted** when bounded non-public
  value must stay in workflow history (classification `INTERNAL`/`SENSITIVE`, key source workload
  identity, rotation documented). Codec does not make Temporal canonical store and does not replace
  Engine retention/deletion `841-848`.
- After retention, history is archived to S3 (if configured) then deleted; no customer data is
  retained only in Temporal.

Source: `agent_studio_implementation_plan.md:79, 850-853`.
