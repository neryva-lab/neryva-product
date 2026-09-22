# Setup — knowledge-curator

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "knowledge-curator" } }`
2. **Connect tools:** create the `draft_article` catalog row (approval REQUIRED); replay
   provisioning after adding it.
3. **Connect knowledge:** the `help-center` corpus it curates.
4. **Review the draft:** redaction posture, [NEEDS-SOURCE] discipline.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget only (curation is an internal workflow).
