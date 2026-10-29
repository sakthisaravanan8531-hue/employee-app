import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { EmployeeStack } from "../lib/employee-stack";
const app = new App({ context: { alertEmail: "alerts@example.test" } });
const template = Template.fromStack(
  new EmployeeStack(app, "TestEmployee", {
    env: { account: "912010732788", region: "us-east-1" },
  }),
);
test("no always-running infrastructure or paid dashboards is created", () => {
  for (const type of [
    "AWS::EC2::VPC",
    "AWS::EC2::Instance",
    "AWS::EC2::NatGateway",
    "AWS::RDS::DBInstance",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::AutoScaling::AutoScalingGroup",
    "AWS::CloudWatch::Dashboard",
  ])
    template.resourceCountIs(type, 0);
});
test("DynamoDB is on-demand, retained, protected and capacity limited", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
    DeletionProtectionEnabled: true,
    OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 10 },
  });
  template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
});
test("Lambda is ARM, small, concurrency limited and outside a VPC", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs22.x",
    Architectures: ["arm64"],
    MemorySize: 256,
    Timeout: 15,
    ReservedConcurrentExecutions: 2,
    VpcConfig: Match.absent(),
  });
});
test("live alias is used for safe versioned releases", () => {
  template.hasResourceProperties("AWS::Lambda::Alias", { Name: "live" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
    IntegrationType: "AWS_PROXY",
    PayloadFormatVersion: "2.0",
  });
});
test("API is throttled and detailed metrics are disabled", () => {
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: {
      ThrottlingBurstLimit: 5,
      ThrottlingRateLimit: 2,
      DetailedMetricsEnabled: false,
    },
  });
});
test("one generated secret and short-retention logs reduce fixed costs", () => {
  template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
});
test("Amplify provides hosting with HTTPS API proxy", () => {
  template.hasResourceProperties("AWS::Amplify::App", {
    Platform: "WEB",
    CustomRules: Match.arrayWith([
      Match.objectLike({ Source: "/api/<*>", Status: "200" }),
    ]),
  });
});
test("GitHub deploy role trusts only the production environment", () => {
  template.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:sakthisaravanan8531-hue/employee-app:environment:production",
            },
          },
        }),
      ]),
    }),
  });
});
test("monthly budget notifies email without automated paid actions", () => {
  template.hasResourceProperties("AWS::Budgets::Budget", {
    Budget: Match.objectLike({
      BudgetLimit: { Amount: 5, Unit: "USD" },
      BudgetType: "COST",
      TimeUnit: "MONTHLY",
    }),
    NotificationsWithSubscribers: Match.arrayWith([
      Match.objectLike({
        Subscribers: [
          { SubscriptionType: "EMAIL", Address: "alerts@example.test" },
        ],
      }),
    ]),
  });
});
test("release role cannot read application secrets or employee records", () => {
  const resources = template.toJSON().Resources;
  const policy = Object.values(resources).find(
    (r: any) =>
      r.Type === "AWS::IAM::Policy" &&
      JSON.stringify(r.Properties.Roles).includes("DeploymentRole"),
  ) as any;
  assert.ok(policy);
  const actions = policy.Properties.PolicyDocument.Statement.flatMap(
    (s: any) => s.Action,
  );
  assert.ok(
    !actions.some(
      (a: string) =>
        a.startsWith("secretsmanager:") || a.startsWith("dynamodb:"),
    ),
  );
});

test("release role can pause only the application Lambda", () => {
  const resources = template.toJSON().Resources;
  const policy = Object.values(resources).find(
    (r: any) =>
      r.Type === "AWS::IAM::Policy" &&
      JSON.stringify(r.Properties.Roles).includes("DeploymentRole"),
  ) as any;
  const statement = policy.Properties.PolicyDocument.Statement.find((s: any) =>
    s.Action.includes("lambda:PutFunctionConcurrency"),
  );
  assert.ok(statement);
  assert.notEqual(statement.Resource, "*");
});
