import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as path from "node:path";
export class EmployeeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const email =
      this.node.tryGetContext("alertEmail") || process.env.ALERT_EMAIL;
    const table = new dynamodb.Table(this, "Employees", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      maxReadRequestUnits: 10,
      maxWriteRequestUnits: 10,
      encryption: dynamodb.TableEncryption.DEFAULT,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const password = new secrets.Secret(this, "AdminPassword", {
      description:
        "Employee administrator; signing key derived from this random password at runtime",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "admin" }),
        generateStringKey: "password",
        passwordLength: 32,
        excludePunctuation: true,
      },
    });
    const runtimeLogs = new logs.LogGroup(this, "RuntimeLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, "Backend", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.resolve(__dirname, "../../.local/lambda"),
      ),
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      logGroup: runtimeLogs,
      environment: {
        NODE_ENV: "production",
        TABLE_NAME: table.tableName,
        AUTH_SECRET_ARN: password.secretArn,
      },
    });
    table.grantReadWriteData(fn);
    password.grantRead(fn);
    const version = fn.currentVersion;
    const live = new lambda.Alias(this, "Live", { aliasName: "live", version });
    const api = new apigw.HttpApi(this, "HttpsApi", {
      description: "Low-traffic serverless employee API",
      defaultIntegration: new integrations.HttpLambdaIntegration(
        "Lambda",
        live,
      ),
    });
    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.accessLogSettings = {
      destinationArn: apiLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        status: "$context.status",
        path: "$context.path",
        latency: "$context.responseLatency",
      }),
    };
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 5,
      throttlingRateLimit: 2,
      detailedMetricsEnabled: false,
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
      maxSessionDuration: cdk.Duration.hours(1),
      description:
        "Release only: update this Lambda and Amplify app; no secret or employee-data read access",
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetFunctionConcurrency",
          "lambda:PutFunctionConcurrency",
          "lambda:DeleteFunctionConcurrency",
          "lambda:UpdateFunctionCode",
          "lambda:PublishVersion",
        ],
        resources: [fn.functionArn],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:GetAlias", "lambda:UpdateAlias"],
        resources: [`${fn.functionArn}:live`],
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
    const topic = new sns.Topic(this, "Alerts", {
      displayName: "Employee app alerts",
      enforceSSL: true,
    });
    if (email)
      topic.addSubscription(new subscriptions.EmailSubscription(email));
    // Two basic alarms, no paid dashboard or detailed API metrics.
    const backendErrors = new logs.MetricFilter(this, "HttpErrors", {
      logGroup: runtimeLogs,
      filterPattern: logs.FilterPattern.literal("{ $.status >= 500 }"),
      metricNamespace: "EmployeeApp",
      metricName: "Http5xx",
      metricValue: "1",
      defaultValue: 0,
    });
    const errors = new cw.Alarm(this, "BackendErrors", {
      metric: backendErrors.metric({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 5,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    errors.addAlarmAction(new actions.SnsAction(topic));
    const runtimeErrors = new cw.Alarm(this, "LambdaErrors", {
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    runtimeErrors.addAlarmAction(new actions.SnsAction(topic));
    if (email) {
      const amount = Number(this.node.tryGetContext("monthlyBudgetUsd") || 5);
      if (!Number.isFinite(amount) || amount <= 0)
        throw new Error("monthlyBudgetUsd must be positive");
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: "employee-app-account-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount, unit: "USD" },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: email }],
          },
          {
            notification: {
              notificationType: "FORECASTED",
              comparisonOperator: "GREATER_THAN",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: email }],
          },
        ],
      });
    }
    for (const [name, value] of Object.entries({
      AppUrl: `https://main.${app.attrDefaultDomain}`,
      AmplifyAppId: app.attrAppId,
      ApiUrl: api.apiEndpoint,
      FunctionName: fn.functionName,
      DeploymentRoleArn: deployRole.roleArn,
      AdminSecretArn: password.secretArn,
      TableName: table.tableName,
      AlertsTopicArn: topic.topicArn,
    }))
      new cdk.CfnOutput(this, name, { value });
  }
}
