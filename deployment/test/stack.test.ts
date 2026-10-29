import { execFileSync } from "node:child_process";
import { bootstrap } from "../lib/user-data";
import { test } from "node:test";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { EmployeeStack } from "../lib/employee-stack";
const app = new App({
  context: { githubRepository: "sakthisaravanan8531-hue/employee-app" },
});
const template = Template.fromStack(
  new EmployeeStack(app, "TestEmployee", {
    env: { account: "912010732788", region: "us-east-1" },
  }),
);
test("network spans two AZs with six exact subnets and two NAT gateways", () => {
  template.resourceCountIs("AWS::EC2::Subnet", 6);
  template.resourceCountIs("AWS::EC2::NatGateway", 2);
  for (const cidr of [
    "10.0.1.0/24",
    "10.0.2.0/24",
    "10.0.11.0/24",
    "10.0.12.0/24",
    "10.0.21.0/24",
    "10.0.22.0/24",
  ])
    template.hasResourceProperties("AWS::EC2::Subnet", { CidrBlock: cidr });
});
test("database is encrypted, private, multi-AZ and protected with backups", () => {
  template.hasResourceProperties("AWS::RDS::DBInstance", {
    MultiAZ: true,
    PubliclyAccessible: false,
    StorageEncrypted: true,
    BackupRetentionPeriod: 7,
    DeletionProtection: true,
    MasterUserPassword: Match.anyValue(),
  });
});
test("instances require IMDSv2, encrypted disks and no public IP", () => {
  template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
    LaunchTemplateData: Match.objectLike({
      MetadataOptions: { HttpTokens: "required" },
      NetworkInterfaces: Match.arrayWith([
        Match.objectLike({ AssociatePublicIpAddress: false }),
      ]),
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true }) }),
      ]),
    }),
  });
});
test("fleet maintains two instances behind a private ALB", () => {
  template.hasResourceProperties("AWS::AutoScaling::AutoScalingGroup", {
    MinSize: "2",
    DesiredCapacity: "2",
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    Scheme: "internal",
  });
});
test("database ingress is restricted to a security group", () => {
  template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
    FromPort: 5432,
    ToPort: 5432,
    IpProtocol: "tcp",
    SourceSecurityGroupId: Match.anyValue(),
    CidrIp: Match.absent(),
  });
});
test("Amplify routes API requests over HTTPS and has a main branch", () => {
  template.hasResourceProperties("AWS::Amplify::App", {
    Platform: "WEB",
    CustomRules: Match.arrayWith([
      Match.objectLike({ Source: "/api/<*>", Status: "200" }),
    ]),
  });
  template.hasResourceProperties("AWS::Amplify::Branch", {
    BranchName: "main",
    EnableAutoBuild: false,
  });
});
test("GitHub role uses production environment and OIDC audience", () => {
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
test("alarms notify SNS and dashboard is provisioned", () => {
  template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    Threshold: 10,
    AlarmActions: Match.anyValue(),
    EvaluationPeriods: 2,
  });
});

test("no security group exposes backend or database ports to the internet", () => {
  const resources = template.toJSON().Resources;
  for (const resource of Object.values(resources) as any[]) {
    const rules =
      resource.Type === "AWS::EC2::SecurityGroupIngress"
        ? [resource.Properties]
        : resource.Properties?.SecurityGroupIngress || [];
    for (const rule of rules) {
      if (rule.CidrIp === "0.0.0.0/0" || rule.CidrIpv6 === "::/0") {
        if (
          rule.IpProtocol === "-1" ||
          [5432, 8080, 22].some(
            (port) =>
              Number(rule.FromPort) <= port && Number(rule.ToPort) >= port,
          )
        )
          throw new Error("Unexpected internet ingress to a private service");
      }
    }
  }
});

test("generated instance bootstrap is valid bash", () => {
  execFileSync("bash", ["-n"], {
    input: bootstrap({
      releaseParameter: "/employee/release",
      dbSecret: "arn:db-secret",
      dbHost: "db.internal",
      adminSecret: "arn:admin-secret",
      sessionSecret: "arn:session-secret",
      logGroup: "employee/logs",
      region: "us-east-1",
    }),
  });
});
