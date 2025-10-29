import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as path from "path";

const config = new pulumi.Config();

const letterboxdUsername = config.require("letterboxdUsername");
const discordWebhookUrl = config.requireSecret("discordWebhookUrl");
const parameterNameInput = config.get("parameterName") ?? "/letterboxd/lastSeenId";
const scheduleExpression = config.get("scheduleExpression") ?? "rate(30 minutes)";
const scheduleName = config.get("scheduleName") ?? "letterboxd-every-30m";
const memorySize = config.getNumber("memorySize") ?? 128;
const timeoutSeconds = config.getNumber("timeoutSeconds") ?? 10;
const createParameter = config.getBoolean("createParameter") ?? false;
const parameterInitialValue = config.get("parameterInitialValue") ?? "";
const lambdaPathConfig = config.get("lambdaPath");
const enableScheduleConfig = config.getBoolean("enableSchedule");
const scheduleEnabled = enableScheduleConfig ?? true;
const persistForcedState = config.get("persistForcedState");

const lambdaSourcePath = lambdaPathConfig
  ? path.resolve(lambdaPathConfig)
  : path.resolve(__dirname, "..", "..", "app");

const lambdaArchive = new pulumi.asset.FileArchive(lambdaSourcePath);

const normalizedParamName = parameterNameInput.startsWith("/")
  ? parameterNameInput
  : `/${parameterNameInput}`;

const partition = aws.getPartitionOutput({});
const region = aws.getRegionOutput({});
const caller = aws.getCallerIdentityOutput({});

const parameterArn = pulumi
  .all([partition.partition, region.name, caller.accountId])
  .apply(([partitionName, regionName, accountId]) =>
    `arn:${partitionName}:ssm:${regionName}:${accountId}:parameter${normalizedParamName}`
  );

let ssmParameter: aws.ssm.Parameter | undefined;
if (createParameter) {
  ssmParameter = new aws.ssm.Parameter("letterboxdLastSeen", {
    name: normalizedParamName,
    type: "String",
    value: parameterInitialValue,
  }, {
    ignoreChanges: ["value"],
  });
}

const lambdaRole = new aws.iam.Role("letterboxdLambdaRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "lambda.amazonaws.com",
  }),
});

new aws.iam.RolePolicyAttachment("lambdaBasicExecution", {
  role: lambdaRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicy("lambdaParameterAccess", {
  role: lambdaRole.id,
  policy: parameterArn.apply((arn) => JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:PutParameter"],
        Resource: arn,
      },
    ],
  })),
});

const lambdaEnv: Record<string, pulumi.Input<string>> = {
  DISCORD_WEBHOOK_URL: discordWebhookUrl,
  LETTERBOXD_USERNAME: letterboxdUsername,
  PARAM_NAME: normalizedParamName,
  LOG_LEVEL: config.get("logLevel") ?? process.env.LOG_LEVEL ?? "info",
  SCHEDULE_FORCE_MOST_RECENT: (config.get("scheduleForceMostRecent") ?? process.env.SCHEDULE_FORCE_MOST_RECENT ?? "false").toString(),
};

if (persistForcedState !== undefined) {
  lambdaEnv.PERSIST_FORCED_STATE = persistForcedState;
}

const lambdaFunction = new aws.lambda.Function("letterboxdDiscordHook", {
  runtime: "nodejs20.x",
  role: lambdaRole.arn,
  handler: "handler.handler",
  architectures: ["x86_64"],
  memorySize,
  timeout: timeoutSeconds,
  code: lambdaArchive,
  environment: {
    variables: lambdaEnv,
  },
});

let scheduleArnOutput: pulumi.Output<string> | undefined;
if (scheduleEnabled) {
  const schedulerRole = new aws.iam.Role("letterboxdSchedulerRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "scheduler.amazonaws.com",
    }),
  });

  new aws.iam.RolePolicy("schedulerInvokeLambda", {
    role: schedulerRole.id,
    policy: pulumi.all([lambdaFunction.arn]).apply(([lambdaArn]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "lambda:InvokeFunction",
          Resource: lambdaArn,
        },
      ],
    })),
  });

  const schedule = new aws.scheduler.Schedule("letterboxdSchedule", {
    name: scheduleName,
    description: "Invoke the Letterboxd to Discord Lambda on a fixed cadence.",
    flexibleTimeWindow: { mode: "OFF" },
    scheduleExpression,
    target: {
      arn: lambdaFunction.arn,
      roleArn: schedulerRole.arn,
    },
  });

  new aws.lambda.Permission("allowSchedulerInvoke", {
    action: "lambda:InvokeFunction",
    function: lambdaFunction.name,
    principal: "scheduler.amazonaws.com",
    sourceArn: schedule.arn,
  });

  scheduleArnOutput = schedule.arn;
}

export const lambdaName = lambdaFunction.name;
export const lambdaArn = lambdaFunction.arn;
export const scheduleArn = scheduleArnOutput ?? pulumi.output<string | undefined>(undefined);
export const parameterName = ssmParameter?.name ?? pulumi.output<string | undefined>(undefined);
