# Live acceptance and failure-testing runbook

Run these tests only after a successful AWS deployment, with the production operator's authorization and a maintenance window. Local passing tests do not establish that these drills passed. Record UTC timestamps, Git SHA, resource IDs and observed responses in a demo report; do not include secret values or session cookies.

## 1. Baseline functionality

Open the Amplify AppUrl, sign in using the generated administrator credentials, view the dashboard, add an employee, edit its title, reload, verify persistence and delete it. Run `deployment/scripts/smoke.py` with credentials supplied securely via environment variables. Record the health endpoint's build SHA and verify two healthy ALB targets across different AZs before a fault drill.

## 2. Lose one instance

Use the EC2 console or the following operator command to stop **one verified backend instance**, after recording the ASG's two instance IDs and AZs:

```sh
aws ec2 stop-instances --instance-ids VERIFIED_BACKEND_INSTANCE_ID --region us-east-1
```

Continuously request the Amplify `/api/health` endpoint and run authenticated CRUD from another shell. The ALB removes the failed target; the other instance should continue serving requests and the ASG replaces the stopped instance. Brief failures before ALB failure detection are possible and should be recorded, not hidden. Confirm the ASG returns to two healthy targets and repeat CRUD. Do not stop both instances or the database. This is active fault injection and is not part of normal CI.

## 3. Real HTTP 500 → CloudWatch → SNS

`POST /api/ops/fault` is disabled by default. An operator can temporarily set a random `FAULT_TEST_TOKEN` on both instances using an SSM session and a protected systemd environment override, then restart each service one at a time while preserving a healthy target. Do not put the token in committed files, user data, CI logs or shell history.

Using an authenticated session and the matching `x-fault-token` header, POST JSON to `/api/ops/fault` through Amplify at least 12 times per minute for at least three minutes. The controlled endpoint returns 500, is included in ALB target 5xx and should put the `Backend5xx` alarm in ALARM after two breaching periods. Confirm the SNS subscription is confirmed and the email is received. Then remove the override/token from both instances, restart one at a time and verify the endpoint returns 404 again, the API is healthy and the alarm recovers. A manual `set-alarm-state` is not equivalent to demonstrating real HTTP-500 monitoring.

## 4. Automated release and rollback

Push a harmless application change to `main`. Verify the GitHub verify/deploy jobs succeed, the ASG completes its refresh and `/api/health` returns the new Git SHA through Amplify. Verify the UI change in a browser and repeat CRUD.

For rollback testing, use a reviewed deliberately unhealthy release in a nonproduction copy of the stack. Confirm the script restores the previous SSM pointer and replaces unhealthy instances with the previous bundle, then fails the job visibly. Validate the old version and CRUD. For frontend rollback, revert to a known-good commit on main and redeploy. Do not introduce destructive schema migrations for this drill.

## 5. Internet isolation

Inspect all backend instances and verify no public IP associations. Verify the ALB scheme is `internal`. Verify RDS `PubliclyAccessible=false` and DB-SG only permits Backend-SG on 5432. From an external machine, attempt TCP access to the DB endpoint on 5432 and to the instance private addresses on 8080; it must fail. A failure caused only by the tester's firewall is not proof, so retain security-group, route-table and public-IP evidence as well. Test from a network without private VPC access. Do not temporarily add public ingress to demonstrate the opposite.

## Acceptance record

| Check                                      | Status before AWS deployment     |
| ------------------------------------------ | -------------------------------- |
| Local PostgreSQL-backed API tests          | See current CI/local test report |
| React interaction tests / production build | See current CI/local test report |
| CDK assertions / synthesis                 | See current CI/local test report |
| Public Amplify login and live CRUD         | Not run                          |
| EC2 loss and recovery                      | Not run                          |
| Real 500 alarm and confirmed email         | Not run                          |
| GitHub → AWS application release           | Not run                          |
| Internet isolation external probes         | Not run                          |
| Backend rollback in AWS                    | Not run                          |

The optional blue/green bonus is not implemented; rolling ASG release/rollback is the delivered strategy.
