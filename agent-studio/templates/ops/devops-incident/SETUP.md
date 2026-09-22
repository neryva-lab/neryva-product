# Setup — devops-incident

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "devops-incident" } }`
2. **Connect tools:** create `summarize_logs` + `post_status` + `page_oncall` rows (page_oncall
   DESTRUCTIVE, approval REQUIRED, rate_limit_per_run=1, narrow sealed credential); replay
   provisioning after adding them.
3. **Connect knowledge:** ingest the `incident-runbooks` corpus.
4. **Review the draft:** severity matrix mapping, wall-clock cap, UTC format.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget only (incidents need readable records + audit).
