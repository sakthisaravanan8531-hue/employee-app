# Security and operations

## Networking and storage

Amplify provides a default HTTPS hostname and serves React. `/api/*` is an HTTPS reverse proxy to API Gateway, which invokes the Lambda live alias. There is no VPC, public EC2 address, ALB, NAT gateway, database port or RDS endpoint in this design. Lambda accesses DynamoDB and Secrets Manager using the AWS service network and its execution role. The API origin is publicly callable, but employee routes require a signed administrator session even when bypassing the frontend. API responses send `Cache-Control: no-store, private`.

DynamoDB is encrypted at rest using the AWS-owned key, with on-demand billing, explicit throughput ceilings, deletion protection and retention on stack removal. Employee keys are `EMPLOYEE#<uuid>`; unique-email reservation keys are `EMAIL#<normalized-email>`. Create/update/delete use atomic transactions so email ownership and employee state change together. Revision conditions prevent lost updates. List operations scan/filter all pages and use consistent reads, suitable for a small demo only. A multi-page scan is not a transactionally consistent snapshot. There is no relational database or automated PostgreSQL migration.

To minimize demo costs, point-in-time recovery and scheduled backups are not enabled. Export important data and add a backup policy before storing irreplaceable records. Retention/deletion protection do not protect against an authorized user deleting a record.

## Authentication and IAM

One generated Secrets Manager secret contains the administrator username/password. Lambda fetches it using its runtime role and caches configuration for five minutes per warm execution environment. HKDF derives a separate-context session-signing key from the high-entropy generated password. No actual credentials appear in source, Lambda environment variables, artifacts or outputs; the environment contains the secret ARN only. Password changes apply as execution environments refresh their cache, with up to five minutes of overlap, and invalidate previously signed sessions after refresh.

Sessions expire after eight hours and use HttpOnly, Secure, SameSite Strict cookies in AWS. JSON-only mutations and cross-site rejection provide CSRF protection for the same-origin frontend. Login has an in-memory rate limiter per execution environment; it is not a distributed anti-abuse service. The application is a single-administrator demo, not organizational SSO. The Lambda adapter explicitly parses its completed Buffer-backed requests with the same 16 KB limit as the normal Express transport.

The runtime role can access the specific DynamoDB table, administrator secret and CloudWatch logs. The GitHub release role can update/publish the single Lambda, change its live alias and publish to the Amplify main branch. It cannot directly read employee records or the secret. A separate authorized operator bootstraps/updates infrastructure. Anyone who can release code can indirectly use the runtime permissions, so protect main and the production environment. Do not grant the release role AdministratorAccess.

## Availability, releases and monitoring

Lambda scales within the account shared concurrency pool; DynamoDB provides managed regional availability. There are no EC2 stop tests or ASG recovery expectations anymore. No positive concurrency reservation is required, which supports accounts with small regional quotas. OFF reserves zero to block new execution; ON removes that reservation. Account quotas and API throttling can produce 429 responses during bursts; there is no dedicated per-function concurrency ceiling while ON. API Gateway rate limiting is best-effort, and traffic over these limits must be retried or rejected.

GitHub releases publish a version and move a live alias after recording the prior revision. Backend health failure attempts to restore the old version with an optimistic RevisionId check. Frontend publication follows backend validation. There is no weighted canary or blue/green fleet; prior versions remain available for alias rollback. Review old published-version storage as part of cleanup.

CloudWatch retains API Gateway access logs and structured backend logs for seven days. Two alarms cover HTTP 5xx (>5 in five minutes, from a log metric) and uncaught Lambda errors (>3 in five minutes). Both notify SNS. Missing data is nonbreaching. There is no paid dashboard or detailed API metrics. Confirm the SNS subscription and actual email delivery; a topic ARN alone does not prove delivery. Budget notifications are account-wide and delayed, and do not enforce a spending cap. See costs.md for defaults and caveats.

The optional controlled fault endpoint is off by default. Temporarily configure FAULT_TEST_TOKEN only for an authorized nonproduction drill and remove it afterward. Do not include the token in Git or logs. API Gateway proxy/cookie behavior, real DynamoDB authorization/transactions, fault alarms, budget notification delivery and cloud rollback must be demonstrated after deployment; local tests do not establish those results.
