# Deploy to AWS

## Prerequisites

1. An authorized AWS CLI v2 identity in account **912010732788** with permission to bootstrap CDK and create the stack's resources, including IAM. An account number alone does not grant access. Use IAM Identity Center/SSO, an assumed role or an approved workload identity; do not commit AWS access keys or paste them into chat.
2. Node.js 24, npm and Python 3. AWS CLI v2 is available on GitHub-hosted Ubuntu runners.
3. An alert email address. Confirm the SNS subscription email after stack deployment. Until confirmed, alarms do not deliver email.
4. Repository administrator access to create a GitHub `production` environment and repository variables.

The stack defaults to `us-east-1`, pinned to AZs `us-east-1a` and `us-east-1b` for offline synthesis; if changing region, update the workflow's `AWS_REGION`, all local AWS commands and CDK context together. No purchased domain is required.

## Initial infrastructure deployment

From the repository root, with your AWS profile/session already configured:

```sh
aws sts get-caller-identity --query Account --output text
# Must report 912010732788.
npm ci
npm run check
mkdir -p .local
cd deployment
npx cdk bootstrap aws://912010732788/us-east-1
npx cdk diff -c alertEmail=YOUR_ALERT_EMAIL
npx cdk deploy EmployeeApp -c alertEmail=YOUR_ALERT_EMAIL --outputs-file ../.local/aws-outputs.json
```

Create `.local/` before using the output path if not already created by local development. CDK presents IAM changes for approval. These commands create billable resources. `diff` and `synth` do not prove resources can deploy; quotas, permissions and regional service availability are verified only by actual deployment.

If the AWS account already has the GitHub OIDC provider, reuse it to avoid an `AlreadyExists` failure:

```sh
npx cdk deploy EmployeeApp -c alertEmail=YOUR_ALERT_EMAIL \
  -c githubOidcProviderArn=arn:aws:iam::912010732788:oidc-provider/token.actions.githubusercontent.com \
  --outputs-file ../.local/aws-outputs.json
```

The OIDC provider context choice must also be supplied for later stack updates. The first deployment packages `backend/` as a CDK S3 asset. It includes a standalone lockfile; EC2 runs `npm ci --omit=dev --workspaces=false`. This is source-code distribution using Amazon Linux 2023's Node.js 22 runtime; Node 24 is used for local tooling/CI. The API supports Node >=22. Initial EC2 boots require NAT access to Amazon Linux repositories, S3, Secrets Manager, SSM, npm and the official RDS CA truststore. No passwords are included in user data or the artifact.

Expect RDS, VPC Link and instance initialization to take several minutes. Use the EC2 Systems Manager session and `/var/log/employee-bootstrap.log` for bootstrap failures. Do not expose SSH or assign public IPs to troubleshoot. CloudFormation completion alone does not guarantee the API has passed the post-release smoke checks.

## Connect GitHub Actions

Create the `production` environment in GitHub. Restrict deployment branches to `main` and configure required reviewers if appropriate. The AWS trust policy allows exactly `repo:sakthisaravanan8531-hue/employee-app:environment:production`, with the STS audience. No static AWS key is stored in GitHub.

Set these **repository-level Actions variables** from the `EmployeeApp` stack outputs (repository scope lets the job-level enable condition evaluate):

| GitHub variable       | CloudFormation output |
| --------------------- | --------------------- |
| `DEPLOYMENT_ROLE_ARN` | `DeploymentRoleArn`   |
| `AMPLIFY_APP_ID`      | `AmplifyAppId`        |
| `ARTIFACT_BUCKET`     | `ArtifactBucket`      |
| `ASG_NAME`            | `AutoScalingGroup`    |
| `API_URL`             | `ApiUrl`              |
| `APP_URL`             | `AppUrl`              |

If `DEPLOYMENT_ROLE_ARN` is unset, verification runs and deployment is skipped. The workflow does not create infrastructure or need administrator permissions. Create/update the stack separately with the operator identity. After configuring the variables, run **Test and deploy** manually or push to `main`. The job validates the app, uploads an immutable backend artifact, rolls the ASG and publishes the frontend through Amplify's manual deployment API. Amplify handles its CDN publication; this hosting mode does not require a separately managed CloudFront invalidation.

The AppUrl output becomes usable after that frontend release succeeds. Do not connect Amplify's automatic Git build to the same branch: the supplied workflow owns deployments and avoids two competing deployment paths.

## Sign in and validate

Use the AWS console to retrieve the generated `AdminSecretArn` secret securely. It contains username `admin` and a random password. Do not print it into a CI log. The session signing key is in a separate secret. Verify:

1. Open AppUrl, sign in, add an employee, edit it, refresh the page and delete it.
2. Confirm `/api/health` returns `status: ok` and the deployed Git SHA.
3. Run the authenticated smoke script with `APP_URL`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` supplied securely in the process environment:

```sh
python3 deployment/scripts/smoke.py
```

The smoke script creates and removes a temporary employee. Never add passwords to shell command arguments/history. API Gateway and Amplify integration, cookies and live CRUD are deployment checks, not results established by local unit tests.

## Infrastructure updates and rollback

Run `cdk diff` before every stack update. Avoid replacing RDS, moving its subnets or reducing backup retention without a data-migration plan. Application-only releases use GitHub Actions. If a CDK change replaces or resets the release parameter, explicitly rerun the application release afterward; the stack's initial pointer is a bootstrap artifact, not the latest GitHub release. Stack updates can also roll instances and must not overlap application deployments.

For a bad application release, rerun the workflow at a previously verified commit using an approved main-branch revert. Keep the prior S3 object and record the SSM release value before manual operations. The script automatically attempts a full backend rollback on failed instance refresh or health checks; failed rollback remains a failed job requiring operator investigation. It does not automatically undo schema migrations or a frontend publication that has already succeeded.

## Cleanup

Back up required data first. Disable RDS deletion protection deliberately via a reviewed stack update before `cdk destroy`. The database uses snapshot deletion policy, so retain and track the final snapshot. Artifact buckets, access logs and application log groups are retained and must be separately reviewed/removed when no longer needed. Remove the GitHub OIDC provider only if it is not shared. NAT gateways, ALB and EC2 continue billing until destroyed. Deleting the Amplify app removes its hosted URL.
