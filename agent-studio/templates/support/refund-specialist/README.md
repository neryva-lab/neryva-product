# Refund Specialist

Policy-bounded refunds: verify the order, reason in plain language, execute exactly once behind
approval — or hand off ambiguity undecided. The reference template for DESTRUCTIVE tool handling
(rate_limit_per_run=1, reconcile by lookup, never re-invoke).

## Personas

- Customers requesting refunds within policy
- Support leads auditing refund decisions

## Prerequisites

- `refund-policy` corpus READY
- `get_order` (READ_ONLY) + `process_refund` (DESTRUCTIVE, approval REQUIRED, rate_limit_per_run=1)
  catalog rows
- Model access to `anthropic/claude-sonnet-4-5` (or remap before publish)

## Tool when_to_use

- `search_knowledge`: eligibility text before any statement.
- `get_order`: verify amount/date before reasoning — never trust stated figures.
- `process_refund`: exact confirmed amount, once, behind approval.
- `request_human_handoff`: ambiguity and exceptions — logged, never decided.
