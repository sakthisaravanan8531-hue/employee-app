# Expected AWS resource inventory

| Service         | Resources                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Amplify         | 1 manual-deploy hosting app, main branch, AWS default HTTPS domain/CDN                                    |
| API Gateway     | 1 HTTP API, default stage, VPC link, ALB integration                                                      |
| VPC             | 1 VPC, 6 subnets in 2 AZs, Internet Gateway, routes, flow logs                                            |
| NAT             | 2 NAT gateways and 2 Elastic IP addresses                                                                 |
| ALB             | 1 internal load balancer, listener and healthy API target group                                           |
| EC2 / ASG       | 1 launch template, 1 ASG, 2 desired instances (scale to 4)                                                |
| RDS             | 1 PostgreSQL instance configured Multi-AZ (primary plus AWS-managed standby)                              |
| Secrets Manager | DB credentials, administrator password, session key                                                       |
| S3              | Private release artifacts, ALB access logs; CDK bootstrap asset storage separately                        |
| IAM             | Runtime role, GitHub release role, monitoring/flow-log roles, GitHub OIDC provider if not already present |
| SSM             | Release pointer and managed EC2 session support                                                           |
| CloudWatch      | Dashboard, CPU/status/memory/API/target health/DB alarms, logs/metrics                                    |
| SNS             | 1 alerts topic; email subscription when alertEmail is supplied                                            |
| GitHub Actions  | Test/build/synthesize and OIDC application release                                                        |

Route 53 and user-managed ACM/CloudFront/frontend S3 resources are replaced by Amplify-managed default-domain hosting, following the updated request. There is no registered custom domain in this version.

After deployment, capture the actual stack inventory and outputs:

```sh
aws cloudformation list-stack-resources --stack-name EmployeeApp --region us-east-1
aws cloudformation describe-stacks --stack-name EmployeeApp --region us-east-1 --query 'Stacks[0].Outputs'
```

Do not treat this expected inventory as proof that resources have been created.
