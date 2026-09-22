# Setup — market-analyst

1. **Install:** `POST /console/org/:orgId/assistants { name, template: { slug: "market-analyst" } }`
2. **Connect knowledge:** ingest the `market-research` corpus.
3. **Review the draft:** brief schema, banned claims, disclaimer.
4. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
5. **Bind channels:** widget only (research is a desk workflow).
