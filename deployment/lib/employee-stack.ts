import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as asg from "aws-cdk-lib/aws-autoscaling";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as path from "node:path";
import { bootstrap } from "./user-data";
export class EmployeeStack extends cdk.Stack {
  // Pin the two deployment AZs so synthesis never needs an AWS lookup.
  public get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 2,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "app",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "database",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    // Exact assignment CIDRs, independent of CDK's automatic subnet allocator.
    for (const [subnets, cidrs] of [
      [vpc.publicSubnets, ["10.0.1.0/24", "10.0.2.0/24"]],
      [vpc.privateSubnets, ["10.0.11.0/24", "10.0.12.0/24"]],
      [vpc.isolatedSubnets, ["10.0.21.0/24", "10.0.22.0/24"]],
    ] as const) {
      subnets.forEach((subnet, i) => {
        (subnet.node.defaultChild as ec2.CfnSubnet).cidrBlock = cidrs[i];
      });
    }
    vpc.addFlowLog("FlowLogs", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogGroup", {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
    });
    const linkSg = new ec2.SecurityGroup(this, "ApiLinkSg", {
      vpc,
      description: "API Gateway VPC link only",
    });
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "Private ALB from API Gateway VPC link",
    });
    const backendSg = new ec2.SecurityGroup(this, "BackendSg", {
      vpc,
      description: "Backend from ALB on 8080",
    });
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "PostgreSQL from backend only",
      allowAllOutbound: false,
    });
    albSg.addIngressRule(linkSg, ec2.Port.tcp(80));
    backendSg.addIngressRule(albSg, ec2.Port.tcp(8080));
    dbSg.addIngressRule(backendSg, ec2.Port.tcp(5432));
    const db = new rds.DatabaseInstance(this, "Database", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      databaseName: "employee",
      credentials: rds.Credentials.fromGeneratedSecret("employee_admin"),
      multiAz: true,
      publiclyAccessible: false,
      storageEncrypted: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: false,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ["postgresql", "upgrade"],
      monitoringInterval: cdk.Duration.seconds(60),
      parameters: { "rds.force_ssl": "1" },
      autoMinorVersionUpgrade: true,
    });
    const password = new secrets.Secret(this, "AdminPassword", {
      description:
        "Employee administrator password (never output or committed)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "admin" }),
        generateStringKey: "password",
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    const sessionSecret = new secrets.Secret(this, "SessionKey", {
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const instanceLogs = new logs.LogGroup(this, "InstanceLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const topic = new sns.Topic(this, "Alerts", {
      displayName: "Employee application operational alerts",
      enforceSSL: true,
    });
    const email =
      this.node.tryGetContext("alertEmail") || process.env.ALERT_EMAIL;
    if (email)
      topic.addSubscription(new subscriptions.EmailSubscription(email));
    const artifactBucket = new s3.Bucket(this, "Artifacts", {
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
    });
    const bundle = new assets.Asset(this, "InitialBackend", {
      path: path.resolve(__dirname, "../../backend"),
      exclude: ["node_modules", "test", "*.log"],
    });
    const release = new ssm.StringParameter(this, "Release", {
      parameterName: "/employee-app/backend-release",
      stringValue: `${bundle.s3BucketName}/${bundle.s3ObjectKey}`,
      description:
        "Immutable backend bundle: bucket/key. Deployment role updates this pointer.",
    });
    const role = new iam.Role(this, "BackendRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description:
        "Runtime only: app secrets, artifacts, logs and SSM; no infrastructure deployment",
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMManagedInstanceCore",
      ),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeTags"],
        resources: ["*"],
      }),
    );
    db.secret!.grantRead(role);
    password.grantRead(role);
    sessionSecret.grantRead(role);
    bundle.grantRead(role);
    artifactBucket.grantRead(role, "backend/*");
    release.grantRead(role);
    instanceLogs.grantWrite(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "EmployeeApp" } },
      }),
    );
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      bootstrap({
        releaseParameter: release.parameterName,
        dbSecret: db.secret!.secretArn,
        dbHost: db.dbInstanceEndpointAddress,
        adminSecret: password.secretArn,
        sessionSecret: sessionSecret.secretArn,
        logGroup: instanceLogs.logGroupName,
        region: this.region,
      }),
    );
    const template = new ec2.LaunchTemplate(this, "BackendTemplate", {
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      role,
      securityGroup: backendSg,
      userData,
      requireImdsv2: true,
      detailedMonitoring: true,
      associatePublicIpAddress: false,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(12, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    const group = new asg.AutoScalingGroup(this, "BackendFleet", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplate: template,
      minCapacity: 2,
      maxCapacity: 4,
      desiredCapacity: 2,
      healthChecks: asg.HealthChecks.withAdditionalChecks({
        additionalTypes: [asg.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.minutes(10),
      }),
      updatePolicy: asg.UpdatePolicy.rollingUpdate({
        minInstancesInService: 2,
        maxBatchSize: 1,
        pauseTime: cdk.Duration.minutes(6),
        waitOnResourceSignals: false,
      }),
    });
    cdk.Tags.of(group).add("Application", "employee-app");
    group.node.addDependency(db);
    group.scaleOnCpuUtilization("CpuScaling", { targetUtilizationPercent: 60 });
    const accessLogs = new s3.Bucket(this, "AlbAccessLogs", {
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const alb = new elb.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      dropInvalidHeaderFields: true,
    });
    alb.logAccessLogs(accessLogs);
    const listener = alb.addListener("Http", {
      port: 80,
      open: false,
      defaultAction: elb.ListenerAction.fixedResponse(404, {
        contentType: "application/json",
        messageBody: '{"error":"Not found"}',
      }),
    });
    const target = listener.addTargets("Api", {
      port: 8080,
      targets: [group],
      conditions: [elb.ListenerCondition.pathPatterns(["/api/*"])],
      priority: 1,
      healthCheck: {
        path: "/api/health",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const link = new apigw.VpcLink(this, "VpcLink", {
      vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [linkSg],
    });
    const api = new apigw.HttpApi(this, "HttpsApi", {
      description: "Default AWS HTTPS endpoint; no custom domain needed",
      defaultIntegration: new integrations.HttpAlbIntegration(
        "PrivateAlb",
        listener,
        {
          vpcLink: link,
          parameterMapping: new apigw.ParameterMapping().overwritePath(
            apigw.MappingValue.requestPath(),
          ),
        },
      ),
    });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.accessLogSettings = {
      destinationArn: apiLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        status: "$context.status",
        path: "$context.path",
        integrationError: "$context.integrationErrorMessage",
        latency: "$context.responseLatency",
      }),
    };
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
      detailedMetricsEnabled: true,
    };
    const app = new amplify.CfnApp(this, "Frontend", {
      name: "employee-app",
      platform: "WEB",
      customRules: [
        {
          source: "/api/<*>",
          target: `${api.apiEndpoint}/api/<*>`,
          status: "200",
        },
        {
          source:
            "</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
          target: "/index.html",
          status: "200",
        },
      ],
      customHeaders: JSON.stringify({
        customHeaders: [
          {
            pattern: "**/*",
            headers: [
              { key: "X-Content-Type-Options", value: "nosniff" },
              {
                key: "Referrer-Policy",
                value: "strict-origin-when-cross-origin",
              },
              { key: "X-Frame-Options", value: "DENY" },
              {
                key: "Content-Security-Policy",
                value:
                  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
              },
            ],
          },
        ],
      }),
    });
    new amplify.CfnBranch(this, "MainBranch", {
      appId: app.attrAppId,
      branchName: "main",
      stage: "PRODUCTION",
      enableAutoBuild: false,
    });
    const oidcArn = this.node.tryGetContext("githubOidcProviderArn");
    const provider = oidcArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GitHubProvider",
          oidcArn,
        )
      : new iam.OpenIdConnectProvider(this, "GitHubProvider", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });
    const repo =
      this.node.tryGetContext("githubRepository") ||
      "sakthisaravanan8531-hue/employee-app";
    const deployRole = new iam.Role(this, "DeploymentRole", {
      assumedBy: new iam.WebIdentityPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `repo:${repo}:environment:production`,
          },
        },
      ),
      maxSessionDuration: cdk.Duration.hours(2),
      description:
        "GitHub production app releases only; infrastructure bootstrap uses a separate operator identity",
    });
    artifactBucket.grantPut(deployRole, "backend/*");
    release.grantRead(deployRole);
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [release.parameterArn],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "autoscaling:StartInstanceRefresh",
          "autoscaling:CancelInstanceRefresh",
          "autoscaling:RollbackInstanceRefresh",
        ],
        resources: [group.autoScalingGroupArn],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "autoscaling:DescribeInstanceRefreshes",
          "autoscaling:DescribeAutoScalingGroups",
        ],
        resources: ["*"],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "amplify:CreateDeployment",
          "amplify:StartDeployment",
          "amplify:GetJob",
        ],
        resources: [
          `arn:${this.partition}:amplify:${this.region}:${this.account}:apps/${app.attrAppId}/branches/main`,
          `arn:${this.partition}:amplify:${this.region}:${this.account}:apps/${app.attrAppId}/branches/main/jobs/*`,
        ],
      }),
    );
    const alarmAction = new actions.SnsAction(topic);
    const alarm = (
      name: string,
      metric: cw.IMetric,
      threshold: number,
      comparison = cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    ) => {
      const a = new cw.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: comparison,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      return a;
    };
    const cpu = new cw.Metric({
      namespace: "AWS/EC2",
      metricName: "CPUUtilization",
      dimensionsMap: { AutoScalingGroupName: group.autoScalingGroupName },
      statistic: "Average",
      period: cdk.Duration.minutes(1),
    });
    alarm("HighCpu", cpu, 80);
    const memory = new cw.Metric({
      namespace: "EmployeeApp",
      metricName: "mem_used_percent",
      dimensionsMap: { AutoScalingGroupName: group.autoScalingGroupName },
      statistic: "Average",
      period: cdk.Duration.minutes(1),
    });
    alarm("HighMemory", memory, 85);
    const status = new cw.Metric({
      namespace: "AWS/EC2",
      metricName: "StatusCheckFailed",
      dimensionsMap: { AutoScalingGroupName: group.autoScalingGroupName },
      statistic: "Maximum",
      period: cdk.Duration.minutes(1),
    });
    alarm("InstanceStatus", status, 0);
    const errors = target.metrics.httpCodeTarget(
      elb.HttpCodeTarget.TARGET_5XX_COUNT,
      { period: cdk.Duration.minutes(1), statistic: "Sum" },
    );
    alarm("Backend5xx", errors, 10);
    alarm(
      "Alb5xx",
      alb.metrics.httpCodeElb(elb.HttpCodeElb.ELB_5XX_COUNT, {
        period: cdk.Duration.minutes(1),
        statistic: "Sum",
      }),
      10,
    );
    alarm(
      "HealthyTargets",
      target.metrics.healthyHostCount({
        period: cdk.Duration.minutes(1),
        statistic: "Minimum",
      }),
      2,
      cw.ComparisonOperator.LESS_THAN_THRESHOLD,
    );
    alarm(
      "DatabaseCpu",
      db.metricCPUUtilization({ period: cdk.Duration.minutes(1) }),
      80,
    );
    alarm(
      "DatabaseStorage",
      db.metricFreeStorageSpace({ period: cdk.Duration.minutes(1) }),
      5 * 1024 ** 3,
      cw.ComparisonOperator.LESS_THAN_THRESHOLD,
    );
    alarm(
      "DatabaseConnections",
      db.metricDatabaseConnections({ period: cdk.Duration.minutes(1) }),
      70,
    );
    const unavailable = new logs.MetricFilter(this, "DbUnavailableMetric", {
      logGroup: instanceLogs,
      filterPattern: logs.FilterPattern.literal("{ $.status = 503 }"),
      metricNamespace: "EmployeeApp",
      metricName: "DatabaseUnavailable",
      metricValue: "1",
      defaultValue: 0,
    });
    alarm(
      "DatabaseAvailability",
      unavailable.metric({ period: cdk.Duration.minutes(1), statistic: "Sum" }),
      0,
    );
    const dashboard = new cw.Dashboard(this, "Dashboard", {
      dashboardName: `employee-app-${this.region}`,
    });
    dashboard.addWidgets(
      new cw.GraphWidget({ title: "Compute", left: [cpu, memory, status] }),
      new cw.GraphWidget({
        title: "HTTP traffic",
        left: [
          alb.metrics.requestCount(),
          alb.metrics.httpCodeTarget(elb.HttpCodeTarget.TARGET_4XX_COUNT),
          errors,
          target.metrics.healthyHostCount(),
        ],
      }),
      new cw.GraphWidget({
        title: "Database",
        left: [db.metricCPUUtilization(), db.metricDatabaseConnections()],
        right: [db.metricFreeStorageSpace()],
      }),
    );
    const outputs: Record<string, string> = {
      AppUrl: `https://main.${app.attrDefaultDomain}`,
      AmplifyAppId: app.attrAppId,
      ApiUrl: api.apiEndpoint,
      ArtifactBucket: artifactBucket.bucketName,
      ReleaseParameter: release.parameterName,
      AutoScalingGroup: group.autoScalingGroupName,
      DeploymentRoleArn: deployRole.roleArn,
      AdminSecretArn: password.secretArn,
      AlertsTopicArn: topic.topicArn,
      DatabaseIdentifier: db.instanceIdentifier,
      LoadBalancerArn: alb.loadBalancerArn,
      DashboardName: dashboard.dashboardName,
    };
    for (const [name, value] of Object.entries(outputs))
      new cdk.CfnOutput(this, name, { value });
  }
}
