# Setup — data-analyst

1. **Install:** `POST /console/org/:orgId/assistants { name, template: { slug: "data-analyst" } }`
2. **Connect tools:** create the `query_warehouse` catalog row (READ_ONLY, bounded rows/time);
   replay provisioning after adding it.
3. **Connect knowledge:** ingest the `metric-catalog` corpus.
4. **Review the draft:** banned claims, disclaimer, PII scope.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget only (numbers need readable tables).
