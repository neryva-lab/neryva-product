# Setup — internal-helpdesk

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "internal-helpdesk" } }`
2. **Connect tools:** create the `create_ticket` catalog row (approval REQUIRED, scoped credential);
   replay provisioning after adding it.
3. **Connect knowledge:** ingest the `it-runbooks` corpus.
4. **Review the draft:** runbook scope, redaction posture, routing queues.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget only (internal workflow, auditable surface).
