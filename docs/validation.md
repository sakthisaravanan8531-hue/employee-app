# Validation record

Validated in the managed development environment on 2026-10-29 for the approved low-cost architecture:

| Check                                                                           | Result                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| API authentication/CRUD/security and local persistence tests                    | 15 passed                                             |
| DynamoDB command/transaction behavior tests (mock SDK transport)                | 8 passed                                              |
| React interaction tests                                                         | 3 passed                                              |
| Built Lambda with API Gateway v2 events, cookies, JSON limits and CRUD          | 1 passed                                              |
| CDK architecture, IAM and cost-control assertions                               | 10 passed                                             |
| Release, pause/resume, OFF-state deployment guard and rollback tests (mock AWS) | 22 passed                                             |
| Production React and bundled Lambda builds                                      | Passed                                                |
| Infrastructure TypeScript check and offline CloudFormation synthesis            | Passed                                                |
| Local HTTP smoke through Vite to Node/SQLite                                    | Passed: SPA, login, list, add, update, delete, logout |

Run `npm run check` to reproduce the 62 automated tests, builds and synthesis. Run `node --env-file=.env deployment/scripts/local-smoke.mjs` while `npm run dev:local` is running to repeat the HTTP check. SQLite stores local records on disk; DynamoDB is used only in AWS. DynamoDB request tests and release tests mock the AWS transport, and must not be described as deployed-cloud validation. The bundled-handler test uses the local adapter while exercising the built Lambda's real HTTP-event/cookie transport.

AWS creation, Amplify publication/proxy behavior, live DynamoDB transactions/IAM, GitHub-to-AWS authorization, actual pause/resume, SNS/budget email delivery and alias rollback in AWS are **not run**. No AWS identity is configured here. Account 912010732788 is the target, not evidence of access. CDK reports unset optional feature flags; synthesis succeeds.

The earlier PostgreSQL/EC2 test record is superseded by this serverless validation. The original EC2-stop/RDS-isolation demonstrations do not apply to the owner-approved lower-cost architecture.
