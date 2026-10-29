# Expected low-cost resource inventory

| Service         | Resources                                                                  |
| --------------- | -------------------------------------------------------------------------- |
| Amplify         | 1 static hosting app and main branch; managed default HTTPS domain/CDN     |
| API Gateway     | 1 HTTP API, Lambda integration and throttled default stage                 |
| Lambda          | 1 ARM64 Node.js function, published versions and live alias; concurrency 2 |
| DynamoDB        | 1 encrypted on-demand table with read/write ceilings                       |
| Secrets Manager | 1 generated administrator secret                                           |
| IAM             | Runtime role, GitHub OIDC release role and provider (or reuse existing)    |
| CloudWatch      | 7-day runtime/API logs, 1 log metric and 2 alarms; no dashboard            |
| SNS             | Alerts topic; email subscription if alert email supplied                   |
| AWS Budgets     | Account-wide monthly email budget if alert email supplied                  |
| GitHub Actions  | Verification, Lambda version/alias release and Amplify publication         |
| CDK bootstrap   | Asset storage and deployment roles, possibly shared                        |

There are no VPCs/subnets, NAT gateways, EC2 instances, ASGs, ALBs, RDS instances, VPC links, custom Route 53 zones or user-managed ACM certificates in the application stack. Amplify's managed hosting is not a separately declared frontend bucket/CloudFront distribution.

After deployment, capture actual resources rather than treating this expected list as proof:

```sh
aws cloudformation list-stack-resources --stack-name EmployeeApp --region us-east-1
aws cloudformation describe-stacks --stack-name EmployeeApp --region us-east-1 --query 'Stacks[0].Outputs'
```

Resources from any earlier separately deployed EC2/RDS version must be inventoried and cleaned up deliberately; retained data may keep billing.
