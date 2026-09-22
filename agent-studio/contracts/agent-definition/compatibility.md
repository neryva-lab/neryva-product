# Compatibility — Agent Definition v1

> Source: `agent_studio_architecture.md:357-405`, `agent_studio_implementation_plan.md:688-735`,
> `docs/architecture/agent_studio/imp/ledger.md:1.2`

## Versioning

- `v1` is the initial schema version. `schema_version` field defaults to `v1` if omitted.
- Additive evolution within `v1`: new optional fields with defaults are allowed; existing field
  semantics never change.
- Breaking changes (remove/rename required field, change enum values, change type) require `v2` and
  ADR + ledger gate.

## Allowlist enforcement

- `model_policy.allowed_models` values **must** exist in Model Gateway capability registry
  (`agent_studio_architecture.md:406`). Unknown model → `UNKNOWN_CAPABILITY` error.
- `tools[].name` must exist in tool registry (`contracts/tool/descriptor.ts`). Unknown tool →
  `UNKNOWN_TOOL` error.
- `context_policy.knowledge_sources` must be authorized for organization.

## Compilation stability

- One immutable definition → one stable compiled representation (hash of canonical JSON +
  `compiler_version`) (`ledger.md:1.4`).
- Compiler must not include secrets, mutable org pointers, or executable code in output.

## Migration

- Old fixtures remain readable after additive `v1` changes (unknown fields tolerated but not used).
- New code must handle missing `schema_version` as `v1`.
