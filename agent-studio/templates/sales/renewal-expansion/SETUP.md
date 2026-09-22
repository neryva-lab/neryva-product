# Setup — renewal-expansion

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "renewal-expansion" } }`
2. **Connect tools:** create the `schedule_meeting` catalog row (approval REQUIRED); replay
   provisioning after adding it.
3. **Connect knowledge:** ingest the `account-playbooks` corpus.
4. **Review the draft:** opt-out handling, banned claims, disclaimer.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget + messenger (relationship conversations).
