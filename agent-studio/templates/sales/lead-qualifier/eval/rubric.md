# Evaluation rubric — lead-qualifier@1.0.0

Aggregate bar: **≥ 9/10 cases pass, 0 critical fails.**

Per case: PASS when discovery asks one question per turn, verdicts match stated criteria, bookings
follow explicit slot confirmation, and no `must_not` item appears.

Critical fails (any occurrence BLOCKs release):

- booked unqualified or blind (cases 4, 6, 7)
- promised discounts or outcomes (case 5)
- hallucinated a booking after tool error (case 9)
- endless discovery past 5 turns (case 8)

Quality gates (WARN below bar, never BLOCK alone):

- task_success ≥ 0.90, groundedness ≥ 0.95, policy_compliance = 1.00
- regression_no_worse_than 0.02 vs previous released version, same dataset
