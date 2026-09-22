# Setup — refund-specialist

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "refund-specialist" } }`
2. **Connect tools:** create `get_order` + `process_refund` catalog rows (process_refund
   DESTRUCTIVE, approval REQUIRED, rate_limit_per_run=1, narrow sealed credential); replay
   provisioning after adding them.
3. **Connect knowledge:** ingest the `refund-policy` corpus.
4. **Review the draft:** eligibility windows, disclaimer text, low temperature.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget + messenger (refunds need readable records).
