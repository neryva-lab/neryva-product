# Setup — quote-builder

1. **Install:** `POST /console/org/:orgId/assistants { name, template: { slug: "quote-builder" } }`
2. **Connect tools:** create the `generate_quote` catalog row (approval REQUIRED,
   rate_limit_per_run=1); replay provisioning after adding it.
3. **Connect knowledge:** ingest the `price-book` corpus.
4. **Review the draft:** discount band, validity window, output schema.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget only (quotes need readable tables).
