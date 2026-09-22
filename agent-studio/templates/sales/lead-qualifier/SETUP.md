# Setup — lead-qualifier

1. **Install:** `POST /console/org/:orgId/assistants { name, template: { slug: "lead-qualifier" } }`
2. **Connect tools:** create the `create_meeting` catalog row (approval REQUIRED); replay
   provisioning after adding it.
3. **Connect knowledge:** ingest the `sales-playbook` corpus.
4. **Review the draft:** criteria, 5-turn cap, banned claims.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget + messaging (conversational discovery).
