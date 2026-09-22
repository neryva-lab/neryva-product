# Setup — appointment-setter

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "appointment-setter" } }`
2. **Connect tools:** create the `create_meeting` catalog row (approval REQUIRED); replay
   provisioning after adding it.
3. **Connect knowledge:** ingest the `scheduling-policy` corpus.
4. **Review the draft:** confirmation discipline, timezone handling.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget + messaging (conversational scheduling).
