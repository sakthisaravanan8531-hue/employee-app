# Deploy the low-cost stack

## Prerequisites

- Authorized AWS CLI v2 identity in account **912010732788**, with CDK bootstrap and infrastructure creation permissions including IAM. The account number alone is not authentication. Use an approved role/SSO/workload identity; never put AWS access keys in chat or Git.
- Node.js 24, npm and Python 3. No Docker or external database is required to build.
- An alert email supplied as `ALERT_EMAIL` in secure environment settings, or `-c alertEmail=YOUR_EMAIL`. The owner-provided email is saved in the environment draft, not committed to GitHub.
- GitHub repository settings access for the production environment and Actions variables.

The default region is `us-east-1`. If changing region, update CDK context, the workflow's AWS_REGION and operator commands together. No domain purchase is needed.

## First infrastructure deployment

From the repository root, using your already configured AWS session:

```sh
aws sts get-caller-identity --query Account --output text
# Must return 912010732788.
npm ci
npm run check
mkdir -p .local
cd deployment
npx cdk bootstrap aws://912010732788/us-east-1
npx cdk diff
npx cdk deploy EmployeeApp --outputs-file ../.local/aws-outputs.json
```

CDK reads `ALERT_EMAIL` from the process environment. If it is not set, add `-c alertEmail=YOUR_EMAIL` to the CDK commands. Without an email, the SNS topic/alarms still exist but no email subscription or budget is created. Confirm the SNS subscription email when AWS sends it. The default account-wide budget threshold is $5/month; adjust it with `-c monthlyBudgetUsd=10`. A budget is an alert, not an automatic spending cap.

If the account already has the GitHub OIDC provider, reuse it by adding this context to diff/deploy and future updates:

```sh
-c githubOidcProviderArn=arn:aws:iam::912010732788:oidc-provider/token.actions.githubusercontent.com
```

`npm run build:backend` must run before CDK synthesis/deploy because the stack packages `.local/lambda`. `npm run check` includes that build. CDK creates the initial Lambda version and live alias. Infrastructure creation incurs charges and can fail due to quotas or permissions even after offline synthesis passes. The function uses the account shared concurrency pool, so it does not reserve capacity or require a quota increase simply to deploy. API throttling and DynamoDB throughput ceilings remain in place; they are not hard billing caps.

## Recovering from an initial concurrency-quota failure

If the initial template failed with `UnreservedConcurrentExecution below its minimum`, update the checkout to the shared-pool version and rebuild. Inspect the stack status before choosing recovery:

```sh
aws cloudformation describe-stacks --stack-name EmployeeApp --region us-east-1 --query 'Stacks[0].StackStatus' --output text
```

Do not blindly delete the stack or retained DynamoDB table. A failed deployment may leave resources behind. A CREATE_FAILED stack with preserved resources and a ROLLBACK_COMPLETE stack require different recovery steps; retain the actual status/error output when troubleshooting. The OIDC provider may also already exist from a partial attempt, so check it again before retrying. No employee data is automatically migrated or removed during this fix.

## Connect GitHub Actions

Create a GitHub environment named `production` and restrict deployment branches to `main`. Protect that environment/main branch appropriately: releasing backend code grants indirect access to the runtime role. The OIDC trust policy allows only the exact repository/production-environment subject and STS audience.

Set these **repository-level Actions variables** from the stack outputs:

| Variable              | Output              |
| --------------------- | ------------------- |
| `DEPLOYMENT_ROLE_ARN` | `DeploymentRoleArn` |
| `AMPLIFY_APP_ID`      | `AmplifyAppId`      |
| `FUNCTION_NAME`       | `FunctionName`      |
| `API_URL`             | `ApiUrl`            |
| `APP_URL`             | `AppUrl`            |

Remove the old ASG/artifact-bucket variables if present; they are unused by this workflow. If DEPLOYMENT_ROLE_ARN is unset, verification runs and deployment is skipped. No static AWS key is stored in GitHub. Run **Test and deploy** manually or push to main after configuring the variables. GitHub builds React and the Lambda zip, updates/publishes Lambda, moves the live alias, verifies health/version, then uploads React to Amplify's manual-deployment API. Amplify manages CDN publication; there is no separate CloudFront invalidation step.

Do not enable a competing Amplify Git build pipeline on the same branch. AppUrl becomes functional after frontend publication succeeds, not merely because CloudFormation emitted the URL.

## Manual ON/OFF control

After deployment and GitHub variable setup, use **Actions → Application ON or OFF → Run workflow** on main. Choose `off` to block new backend invocations and publish an offline page; `on` to verify/build/deploy and resume; `status` to read backend concurrency. Both workflows share the production concurrency lock, and push-triggered releases skip AWS publication while paused. If updating an older installed stack, deploy the new scoped Lambda concurrency permissions first. See application-power.md for costs and failure handling.

## Sign in and verify

Retrieve the generated AdminSecretArn secret in the AWS console securely. It contains username `admin` and a random password. Do not print it in CI. Open AppUrl and verify login, employee create/edit/list/delete and reload persistence. `/api/health` should report `status: ok` and the current Git SHA.

For an automated live check, securely supply APP_URL, ADMIN_USERNAME and ADMIN_PASSWORD in the process environment, then run:

```sh
python3 deployment/scripts/smoke.py
```

This temporarily creates and deletes a test employee. API Gateway is deliberately throttled, so the live smoke script retries HTTP 429. Never put the password directly into shell command arguments/history. Amplify proxy behavior, cloud IAM, real DynamoDB transactions and SNS delivery remain live checks until executed.

## Updates and rollback

Use an operator identity for infrastructure changes (`cdk diff` first); the GitHub release role cannot deploy infrastructure. Infrastructure updates may publish a new baseline Lambda version/reset the alias, so do not overlap them with application releases. Run the application release afterward to restore the expected Git SHA.

The release script records the current alias/version and RevisionId, publishes a new immutable version and changes the alias using an optimistic condition. If backend health fails, it restores the prior version with another RevisionId check and reports failure. An unexpected concurrent alias change is never overwritten silently. For a frontend failure or an application bug missed by health checks, revert a known-good commit on main and redeploy. Data changes must remain backward-compatible; rollback does not undo employee changes. Only a version/health check gates automatic rollback; the authenticated CRUD smoke test is a separate live acceptance check.

## If the previous EC2/RDS stack was deployed

Do not assume a template update eliminates its bill. The old stack used retained buckets and a snapshot policy on a deletion-protected RDS instance. Inspect actual resources, back up required data, and create a reviewed migration/teardown plan before applying a replacement. This project has not automatically migrated PostgreSQL records to DynamoDB. No AWS deployment was performed during local implementation.

## Cleanup

Export required DynamoDB records before teardown. The table is deletion-protected and retained; deliberately disable protection and remove it only when appropriate. Retained data storage can continue billing after stack deletion. Review the generated secret, Lambda versions, Amplify app, budget, logs and CDK asset storage. Do not delete shared bootstrap resources or a shared GitHub OIDC provider blindly. See costs.md for pause/charge limitations.

## GitHub OIDC sign-in diagnostics

If AWS rejects `AssumeRoleWithWebIdentity`, inspect the workflow step **Inspect non-secret AWS identity claims**. It prints only an allowlist of issuer, audience, subject and repository/environment metadata, never the JWT or bearer request credential. Compare those claims to the actual IAM trust policy; do not broaden the trust policy with wildcards merely to make a run pass. Also verify the IAM OIDC provider includes the STS audience. A new workflow dispatch uses the latest diagnostic step; rerunning an older run uses its old workflow revision.
