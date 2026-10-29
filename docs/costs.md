# Cost controls

The approved goal is a low-traffic demonstration application at minimum practical cost. This design removes the largest idle costs in the original assignment: EC2, Multi-AZ RDS, ALB and two NAT gateways. It uses Amplify static hosting, API Gateway HTTP API, ARM64 Lambda and on-demand DynamoDB.

## Included controls

- Lambda uses 256 MB, a 15-second timeout, the shared account concurrency pool (no positive reservation) and no provisioned concurrency.
- API Gateway is configured for a steady rate of two requests/second and a burst of five. Throttling is best-effort, not a billing limit. Heavy or bursty usage may receive HTTP 429 and require retry.
- DynamoDB uses on-demand billing with maximum read/write throughput of ten request units each. Transactions consume additional units; storage is separately billed. Encryption uses the AWS-owned key to avoid customer-managed KMS key costs.
- Lambda/API logs expire after seven days. Request bodies, passwords and session cookies are excluded from application logs.
- Only two basic CloudWatch alarms are created; no paid custom dashboard or detailed API metrics. One log-derived metric counts HTTP 5xx; native Lambda Errors catches uncaught invocation failures.
- One Secrets Manager secret holds the generated administrator credentials. A session-signing key is derived using HKDF at runtime, avoiding a second paid secret. This secret has a small recurring storage charge and API-call charges. Each warm Lambda execution environment caches configuration for five minutes.
- If `ALERT_EMAIL` or `-c alertEmail=...` is configured, the stack creates an **account-wide monthly cost budget**. The default is **$5 USD**, configurable with `-c monthlyBudgetUsd=10`. It emails at 80% actual cost and when forecasted cost exceeds 100%. The default is a notification threshold, not a promise of a $5 bill or a user-approved hard spending cap. It includes other services in the account too.

## Charges that can remain

Amplify storage/data transfer, API calls, Lambda duration, DynamoDB requests/storage, Secrets Manager, CloudWatch metrics/alarms/log ingestion, SNS and CDK bootstrap asset storage can incur charges. Free-tier credits depend on account age, eligibility and current AWS terms. Large traffic or downloads can increase the bill. Budget data and notifications are delayed; budgets and throttles do not automatically stop all spending. Review current AWS pricing for us-east-1 and the account's Billing dashboard before deployment.

A default Amplify domain avoids domain-registration and Route 53 hosted-zone charges. No new domain is purchased by this stack. The frontend is built in GitHub Actions and uploaded to Amplify to avoid duplicate Amplify Git builds.

## Pause or remove the demo

Use **GitHub Actions → Application ON or OFF → Run workflow** to choose `off`, `on` or `status`. OFF sets Lambda concurrency to zero and publishes a small maintenance page; ON tests/builds/releases the app and removes the OFF reservation to restore shared-pool execution. Push-triggered releases skip publication while OFF. See [application-power.md](application-power.md) for prerequisites, failure handling and CLI alternatives.

This prevents new backend invocations but does not delete or fully stop hosting/storage resources. At zero traffic, Lambda already has no idle execution cost. Maintenance-page transfer, DynamoDB storage, Secrets Manager, CloudWatch and direct API Gateway requests can still bill. Verify actual billing rather than treating OFF as a zero-cost guarantee.

Before teardown, export any employee data you need. DynamoDB is retained and deletion-protected, so it continues storage billing until explicitly removed. The administrator secret, published versions and CDK bootstrap storage also need review. Remove resources only after confirming data retention requirements. No cleanup command should blindly delete a shared CDK bootstrap bucket or OIDC provider.

This low-cost design deliberately drops the original assignment's EC2 failure, network-subnet and Multi-AZ RDS demonstrations. Lambda/DynamoDB replace those services; the updated acceptance runbook tests API throttling and version rollback instead.
