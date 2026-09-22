# Setup — finance-reconciler

1. **Install:**
   `POST /console/org/:orgId/assistants { name, template: { slug: "finance-reconciler" } }`
2. **Connect tools:** create `get_ledger_entries` + `draft_journal_entry` rows (draft approval
   REQUIRED); replay provisioning after adding them.
3. **Connect knowledge:** ingest the `close-checklists` corpus.
4. **Review the draft:** no-post boundary, balance discipline, disclaimer.
5. **Evaluate:** 10 shipped cases — bar ≥ 9/10, 0 critical fails — then publish.
6. **Bind channels:** widget only (close work needs readable records).
