# Setup — sales-researcher

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "sales-researcher" } }`
2. **Connect knowledge:** ingest the `sales-playbook` corpus.
3. **Review the draft:** brief schema, banned claims, speculation rules.
4. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
5. **Bind channels:** widget only (research is a desk workflow).
