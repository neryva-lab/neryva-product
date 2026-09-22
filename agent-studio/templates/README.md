# Agent templates — author contract (TPL-3.1)

Canonical template source. Each template is a complete, publishable assistant definition
(instructions + model/context/tool/knowledge/guardrail/budget + knowledge seeds + eval set + release
policy), cloned per-org into the Engine's immutable-version pipeline.

## Layout (every template, no exceptions)

```text
templates/<family>/<slug>/
├── template.yaml          # identity + frontmatter (hash is generator-managed)
├── definition/            # Engine-accepted subset (install writes these)
│   ├── instructions.md    # §5 sections: Role→Goal→Grounding→Steps→
│   │                      #   Constraints→Tool use→Failure→Format + footer
│   ├── model.json         # {allowed_models[≤16], fallback_enabled, model_params?}
│   ├── context.json       # {history_limit, summary_enabled, knowledge_sources, memory_scope}
│   ├── tools.json         # [{name, access, approval?, schema_hash?}] ≤32, Engine values only
│   ├── knowledge.json     # {retrieval_enabled, max_results}
│   ├── guardrails.json    # {input_policy, output_policy, pii_redaction}
│   ├── budgets.json       # Engine names (max_total_tokens, max_cost_micros, …)
│   └── console.json       # consumer-only (brand, max_context_tokens, retrieval_policy)
├── bindings/
│   ├── tools.required.json  # catalog pins + when_to_use (built-ins by name)
│   ├── knowledge.seeds.json # required document slugs
│   └── channels.json        # channel bindings + per-channel caps
├── eval/
│   ├── cases.jsonl        # ≥10 cases (lint-enforced)
│   ├── evaluators.yaml    # evaluator versions for provenance
│   └── rubric.md          # pass/fail + aggregate bar
├── release_policy.yaml    # PASS/WARN/BLOCK (TX-enforced, never a score gate)
├── samples/
│   ├── demo-script.md     # 3-turn golden conversation
│   └── edge-cases.md      # red-team script (must fail closed)
├── README.md
└── SETUP.md
```

## Rules

- `definition/` holds the Engine subset ONLY. Template-only extensions (`effect_class`,
  `when_to_use`, `seed_queries`, `banned_claims`, `brand`, `retrieval_policy`, `max_context_tokens`)
  live in bindings/console/README — sending them to the version endpoint is a 422.
- `template.yaml:hash` is generator-managed. Edit `definition/`, then run
  `pnpm templates:registry -- --write`. Never hand-edit the hash or `registry.json` (CI verifies
  both).
- Directories starting with `_` are skipped (fixtures, drafts).
- Reference implementation: `brand/brand-concierge/`.
