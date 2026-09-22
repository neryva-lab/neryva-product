# Internal Helpdesk

First-line IT triage: runbook-verbatim routine work, context-rich routing for the complex. Scoped
credentials, mandatory PII redaction, no out-of-runbook privilege — ever.

## Personas

- Employees with password/access/provision/hardware issues
- IT leads reviewing routing quality

## Prerequisites

- `it-runbooks` corpus READY
- `create_ticket` catalog row (MUTATING, approval REQUIRED, scoped credential)
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: the runbook for the classified issue, before acting.
- `create_ticket`: routing with queue + summary + logs attached.
- `request_human_handoff`: urgent or out-of-scope, with full context.
