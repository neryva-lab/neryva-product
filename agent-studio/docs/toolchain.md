# Toolchain — Pinned Versions (Phase 0.2)

Selected per `agent_studio_implementation_plan.md:77` — from currently supported ranges at
implementation time. Do not copy historical numbers from docs into production without verifying
support.

| Concern          | Selected version                                                                                                                                     | Source of truth                                                                                  | Why                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Node.js LTS      | `22.x` (`.nvmrc:22`, `engines.node >=22.0.0`)                                                                                                        | Node release schedule, Temporal SDK support (Node 20,22,24)                                      | Aligns with Engine (`engine/.nvmrc:22`) and Temporal TS SDK (`@temporalio/sdk-typescript` support)                  |
| pnpm             | `9.12.0` (`packageManager`)                                                                                                                          | `pnpm-workspace.yaml`                                                                            | Canonical for monorepo, shared with Engine                                                                          |
| TypeScript       | `5.7.3`                                                                                                                                              | `tsconfig.base.json`, `package.json:typescript`                                                  | Strict mode, `NodeNext` modules, `verbatimModuleSyntax`                                                             |
| Formatter        | `prettier@3.4.0`                                                                                                                                     | `prettier.config.js`                                                                             | 100 printWidth, lf                                                                                                  |
| Linter           | `eslint@9.18.0` + `typescript-eslint@8.20.0`                                                                                                         | `eslint.config.js`                                                                               | `no-explicit-any: error` at auth boundaries                                                                         |
| Test             | `vitest@3.0.0` + `@vitest/coverage-v8@3.0.0`                                                                                                         | `vitest.config.ts`, `vitest.workspace.ts`                                                        | 9 projects: unit, contract, workflow, integration, isolation, security, property, load, chaos                       |
| Protobuf runtime | `@bufbuild/protobuf@2.14.1`                                                                                                                          | `neryva-mcp-contract/package.json`                                                               | Must match Engine (`engine/package.json:36`) and MCP contract                                                       |
| Protovalidate    | `@bufbuild/protovalidate@1.2.0`                                                                                                                      | `neryva-mcp-contract`                                                                            | Schema-declared validation, TS runtime                                                                              |
| ConnectRPC       | `@connectrpc/connect@2.1.2` + `@connectrpc/connect-node@2.1.2`                                                                                       | `engine/package.json:37-39`                                                                      | gRPC-compat, streaming, interceptors. Do NOT add removed `@connectrpc/protoc-gen-connect-es`                        |
| Buf CLI          | `@bufbuild/buf@1.72.0`                                                                                                                               | `neryva-mcp-contract`                                                                            | `buf lint`, `buf breaking`, `buf generate`                                                                          |
| Temporal SDK     | `@temporalio/worker@1.11.x`, `@temporalio/workflow@1.11.x`, `@temporalio/client@1.11.x`, `@temporalio/activity@1.11.x`, `@temporalio/testing@1.11.x` | `agent_studio_implementation_plan.md:77` — select from currently supported range at install time | Durable execution, deterministic sandbox. Verify support for Node 22 at install.                                    |
| Vercel AI SDK    | `ai@5.0.0` + `@ai-sdk/openai@2.0.0`, `@ai-sdk/anthropic@2.0.0`, `@ai-sdk/google@2.0.0`                                                               | `agent_studio_architecture.md:84,428`                                                            | Provider-neutral, behind `model-gateway`. Pin major, upgrade via adapter conformance (`tests/providers/*.test.ts`). |
| OTel             | `@opentelemetry/api@1.9.0`, `@opentelemetry/sdk-node@0.203.0`, `@opentelemetry/resources@2.1.0`, `semantic-conventions@1.36.0`                       | `engine/package.json:46-54`                                                                      | Traces/metrics, GenAI conventions                                                                                   |

## Verification

- `package.json:engines` + `packageManager` + `.nvmrc` + `docs/toolchain.md` must agree.
- `pnpm --version` must be `9.12.0` in CI.
- `node --version` must satisfy `>=22.0.0`.
- `tsc --version` must be `5.7.x`.
- Major bumps require ADR + ledger gate update.

## Notes

- Do not copy historical version numbers from architecture docs into production without checking
  current Temporal SDK support. The selected versions above were verified at `2026-09-02` but must
  be re-verified at actual `pnpm install` time.
- Provider credentials are never in `package.json` — they are secret-manager references via
  `packages/security` (see `0.10`).
