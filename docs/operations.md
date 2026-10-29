# Security and operations

## Network and traffic

The VPC is `10.0.0.0/16` in two AZs. Public subnets `10.0.1.0/24` and `10.0.2.0/24` contain NAT gateways with Internet Gateway routes. Private app subnets `10.0.11.0/24` and `10.0.12.0/24` contain EC2, the internal ALB and API Gateway VPC-link ENIs. They use NAT for outbound software installation and AWS API calls. Private DB subnets `10.0.21.0/24` and `10.0.22.0/24` have no default internet route.

EC2 has no public IP because only the ALB should reach the API port. The ALB is private because API Gateway provides the public HTTPS origin without a custom domain. The API Gateway VPC-link security group may reach ALB port 80; ALB-SG alone may reach Backend-SG port 8080; Backend-SG alone may reach DB-SG port 5432. There is no SSH ingress, public ALB ingress or internet database rule. EC2 uses the DB endpoint's private DNS and verifies the RDS TLS certificate against AWS's official CA bundle.

Amplify serves static assets with managed HTTPS and proxies `/api/*` to the API Gateway HTTPS URL. A SPA rewrite serves `index.html` for extensionless browser routes. No public S3 website is created. S3 artifact and ALB log buckets block all public access and enforce TLS. Backend release objects are encrypted and versioned. The API Gateway origin is publicly addressable, but employee APIs require authentication even when called directly. The internal ALB and backend are not publicly addressable.

## Secrets and roles

CDK creates a generated database secret referenced by CloudFormation dynamic references, a separate administrator password secret and a separate session-signing secret. The API uses the AWS SDK and EC2 instance profile to retrieve secret values at runtime. Passwords never appear in source, AMIs, user data or CloudFormation outputs. Only secret ARNs and the DB endpoint are environment configuration. Passwords are never written to the runtime environment file. Production startup fails if required secrets cannot be read.

Secrets are read at process startup. After changing administrator/session secrets, restart or refresh instances. Database credential changes must update the database and its secret together; automatic database rotation is not configured. Avoid setting only the secret value and leaving the database password unchanged. Session-key changes invalidate sessions across the fleet; deploy them consistently.

The EC2 role can read exactly the application's three secrets, the initial CDK artifact, `backend/*` releases and the release pointer; write application logs and `EmployeeApp` metrics; and use the AWS-managed SSM core policy for inventory/session management. `ec2:DescribeTags` supports CloudWatch agent ASG dimension discovery. Some AWS APIs, including metric publishing and Describe calls, require wildcard resource scope; namespace conditions are applied where supported. Restrict who may initiate SSM sessions, since privileged operators can access application data.

The GitHub deployment role can publish release objects, update the single SSM release pointer, refresh the specific ASG and deploy the specific Amplify main branch. It cannot read database/admin secrets or create infrastructure. Its trust policy uses GitHub OIDC with an exact repository/environment subject. Protect the GitHub production environment and main branch: anyone able to release backend code can indirectly execute code with the runtime role. A separate operator identity bootstraps/updates infrastructure. Runtime and deployment roles differ because a running server should not gain the power to replace the environment or publish arbitrary applications.

## Runtime and database

Amazon Linux 2023 boots Node.js 22 and runs the backend as an unprivileged systemd user with IMDSv2 required, encrypted EBS, process restart and filesystem restrictions. CloudWatch agent reports memory and tails structured API logs. Logs omit request bodies, cookies, passwords and authorization headers. Installation is fail-fast with TLS verification enabled. The initial version has a single compatible schema migration guarded by a PostgreSQL transaction/advisory lock, so concurrent two-AZ startup is safe.

RDS PostgreSQL 17 is Multi-AZ, encrypted, private and protected from deletion, with seven-day automated backups, storage autoscaling, enhanced monitoring and PostgreSQL log export. Multi-AZ provides failover, not read scaling. Schema changes must use expand/contract migration patterns to allow old/new instances to coexist. Restore backups into a separate instance and test recovery before relying on them.

## Monitoring

CloudWatch dashboard includes EC2 CPU/status, agent memory, ALB request counts/4xx/5xx/healthy targets and RDS CPU/connections/free storage. Alarms notify SNS for high CPU/memory, failed status checks, fewer than two healthy targets, target/ALB 5xx, high DB connections and low storage. Database-unavailable health responses are counted by a log metric and alarmed. API Gateway access logs, API logs, ALB S3 access logs, VPC flow logs, RDS logs and enhanced monitoring provide diagnostics.

The 5xx alarm requires **more than 10 target 5xx per minute for two consecutive one-minute periods**. The health-count alarm requires fewer than two targets for two periods. Missing data is treated as nonbreaching to avoid creation-time noise; therefore missing telemetry alone will not alarm. Add an external synthetic canary and missing-agent detection for stricter uptime requirements. RDS operational state/failover should also be checked through the console/CLI during drills; the availability alarm measures the application's database connectivity, not every RDS control-plane state.

No email is delivered until an email address is configured and its SNS subscription is confirmed. Verify the actual subscription and inbox; do not infer delivery from the presence of an alarm resource. ALB/backend logs and employee records may contain personal data: scope operator access, set an appropriate retention policy and apply your organization's data-handling rules.

## Limitations

Local tests cannot establish AWS quotas, IAM authorization, Amplify reverse-proxy cookie behavior, instance bootstrap success, service failover or email receipt. Those remain explicit live checks. There is no blue/green implementation, WAF, organizational SSO, shared/distributed rate-limit store, automated secret rotation or database migration rollback. These are appropriate follow-up hardening tasks based on actual usage requirements, rather than unverified features of this version.
