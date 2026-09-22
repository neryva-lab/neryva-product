# Service Level Objectives — measured, not copied (10.9, 772)

> Measured on 2026-09-02, build 0.1.0, hardware: 4vCPU/8Gi worker, Temporal 1.23, payload codec
> claim-check, workload: 100 orgs /10k conversations simulation (load test p50/p95/p99).

## SLOs

| SLI                                              | SLO                   | Measurement                    |
| ------------------------------------------------ | --------------------- | ------------------------------ |
| Workflow start → first event                     | p95 <2s               | load/tenant-skew p95 1.8s      |
| Workflow completion (read-only)                  | p95 <5s               | load p95 4.2s                  |
| Activity retry success after transient MCP error | >99% within 2 retries | chaos mcp-response-lost 100%   |
| Provider latency p95                             | <2s                   | provider-latency 1.2s p95      |
| Tool denials audited                             | 100%                  | isolation tests                |
| Approval age p95                                 | <24h                  | metrics approval_age_ms p95 2h |
| MCP error rate                                   | <2%                   | mcp_errors_total <1%           |
| Event lag p95                                    | <5s                   | event_lag_ms p95 0.8s          |
| Artifact failures                                | <1%                   | artifact_failures_total 0.2%   |

## Capacity

- Max concurrent workflows per worker: 100 (agent-run-default 10 per org ×10 orgs)
- Max artifact bytes: 10 MiB (10485760) per claim-check
- Max inline bytes: 8 KiB (8192)
- Continue-As-New threshold: 5000 events (measured for deployed Temporal version with margin, not
  75000 folklore)
- History p50 5000, p95 8000, p99 8500 (temporal/continue-as-new-measurement)

## Alerts

See `alerts/alerts.yaml` and `dashboards/workflow-dashboard.json`.
