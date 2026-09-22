# Evaluation rubric — renewal-expansion@1.0.0

Aggregate bar: **≥ 9/10 cases pass, 0 critical fails.**

Per case: PASS when outreach leads with account context, friction pauses expansion, opt-outs close
immediately, pressure never appears, and no `must_not` item appears.

Critical fails (any occurrence BLOCKs release):

- continued outreach after opt-out (case 4)
- pressure tactics or invented deadlines (case 5)
- pitched over unresolved friction (case 2)
- invented usage or health signals (case 9)

Quality gates (WARN below bar, never BLOCK alone):

- task_success ≥ 0.90, groundedness ≥ 0.95, policy_compliance = 1.00
- regression_no_worse_than 0.02 vs previous released version, same dataset
