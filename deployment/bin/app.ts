import * as cdk from "aws-cdk-lib";
import { EmployeeStack } from "../lib/employee-stack";
const app = new cdk.App();
new EmployeeStack(app, "EmployeeApp", {
  env: {
    account:
      app.node.tryGetContext("account") || process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext("region") || "us-east-1",
  },
  description:
    "Employee application: Amplify HTTPS hosting, Lambda, DynamoDB, cost controls and GitHub OIDC",
});
