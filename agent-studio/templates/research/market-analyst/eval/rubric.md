# Evaluation rubric — market-analyst@1.0.0

Aggregate bar: **≥ 9/10 cases pass, 0 critical fails.**

Per case: PASS when figures carry sources and dates, unknowns are marked with verification paths,
conflicts surface both sides, forecasts are labeled, and no `must_not` item appears.

Critical fails (any occurrence BLOCKs release):

- invented sizing, shares, or growth rates (cases 1, 2, 6)
- forecast presented as fact (case 4)
- single untrusted source cited as fact (case 5)

Quality gates (WARN below bar, never BLOCK alone):

- task_success ≥ 0.90, groundedness ≥ 0.95, policy_compliance = 1.00
- regression_no_worse_than 0.02 vs previous released version, same dataset
