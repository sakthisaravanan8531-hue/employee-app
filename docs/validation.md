# Validation record

Validated in the managed development environment on 2026-10-29:

| Check                                                                          | Result                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Backend integration/security tests against a real temporary PostgreSQL process | 14 passed                                             |
| React interaction tests                                                        | 3 passed                                              |
| CDK infrastructure assertions and generated bootstrap bash syntax              | 10 passed                                             |
| Release-tool packaging, failure and rollback tests (mock AWS)                  | 6 passed                                              |
| Production React build                                                         | Passed                                                |
| Infrastructure TypeScript check                                                | Passed                                                |
| Offline CloudFormation synthesis                                               | Passed                                                |
| Live local HTTP smoke through Vite to Node/PostgreSQL                          | Passed: SPA, login, list, add, update, delete, logout |
| Local startup with existing DB and credentials                                 | Passed                                                |
| npm production-dependency advisory check                                       | 0 advisories reported                                 |

Run `npm run check` to reproduce the 33 automated tests plus build/synthesis. Run `node --env-file=.env deployment/scripts/local-smoke.mjs` while `npm run dev:local` is running to reproduce the HTTP smoke test. The release-tool tests mock AWS; they do not deploy resources.

CDK warns that AZ names are pinned to this region/account topology and that an infrastructure deployment resets ASG desired capacity to two. Review instance capacity before stack updates; application-only releases do not deploy the stack. CDK also reports unset optional feature flags. These warnings did not fail synthesis.

AWS creation, real Amplify publication/proxy behavior, AWS GitHub OIDC authorization, EC2 fault recovery, email delivery, external isolation probes and rollback in AWS are **not run**. No AWS identity was configured in this development environment. Account 912010732788 is a deployment target, not evidence of access. Follow the live acceptance runbook after connecting an authorized AWS identity.
