# Tool Compatibility

> Source: `agent_studio_implementation_plan.md:968-990`, `contracts/tool/descriptor.ts`

- `effectClass: READ_ONLY | MUTATING | DESTRUCTIVE` — **not** `WRITE` vs `HUMAN_APPROVAL_REQUIRED`
  as peers. `DESTRUCTIVE` is an effect class; `HUMAN_APPROVAL_REQUIRED` is `approvalRequirement`
  (989).
- `approvalRequirement: NONE | REQUIRED` orthogonal to `effectClass`: read-only can require approval
  (confidential), mutating can be pre-approved under explicit policy.
- Adding new `toolId` is additive; removing or changing `inputSchema` required fields is breaking →
  new `version`.
- Registry is versioned per `toolId@version` (970-987).
