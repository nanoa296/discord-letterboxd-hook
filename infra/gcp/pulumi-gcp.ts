import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as path from "path";

const config = new pulumi.Config();

const location = config.get("location") ?? "us-central1";
const region = config.get("region") ?? location;
const scheduleExpression = config.get("scheduleExpression") ?? "*/30 * * * *";
const timeZone = config.get("timeZone") ?? "Etc/UTC";
const letterboxdUsername = config.require("letterboxdUsername");
const discordWebhookUrl = config.requireSecret("discordWebhookUrl");
const stateBucketNameConfig = config.get("stateBucketName");
const stateObjectName = config.get("stateObject") ?? "lastSeenId";
const codeBucketNameConfig = config.get("codeBucketName");
const functionNameConfig = config.get("functionName");
const logLevel = config.get("logLevel") ?? process.env.LOG_LEVEL ?? "info";
const scheduleForceMostRecent = (config.get("scheduleForceMostRecent") ?? process.env.SCHEDULE_FORCE_MOST_RECENT ?? "false").toString();
const persistForcedState = config.get("persistForcedState") ?? "true";
const maxPosts = config.get("maxPosts") ?? undefined;
const timeoutSeconds = config.getNumber("timeoutSeconds") ?? 30;
const memory = config.get("memory") ?? "128Mi";

const project = gcp.config.project ?? config.get("project");
if (!project) {
    throw new Error("GCP project not configured. Set gcp:project via Pulumi config.");
}

const projectInfo = pulumi.output(gcp.organizations.getProject({ projectId: project }));
const projectNumber = projectInfo.apply((info) => info.number);

const stateBucketName = stateBucketNameConfig ?? randomSuffix("letterboxd-state");
const codeBucketName = codeBucketNameConfig ?? randomSuffix("letterboxd-code");
const functionName = functionNameConfig ?? randomSuffix("letterboxd-fn");

const stateBucket = new gcp.storage.Bucket("letterboxdStateBucket", {
    name: stateBucketName,
    location: region,
    uniformBucketLevelAccess: true,
    versioning: {
        enabled: false,
    },
    forceDestroy: false,
});

const codeBucket = new gcp.storage.Bucket("letterboxdCodeBucket", {
    name: codeBucketName,
    location: region,
    uniformBucketLevelAccess: true,
    forceDestroy: true,
});

const functionServiceAccount = new gcp.serviceaccount.Account("letterboxdFunctionSa", {
    accountId: randomSuffix("letterboxdfnsa"),
    displayName: "Letterboxd Function Service Account",
});

const schedulerServiceAccount = new gcp.serviceaccount.Account("letterboxdSchedulerSa", {
    accountId: randomSuffix("letterboxdschedsa"),
    displayName: "Letterboxd Scheduler Service Account",
});

new gcp.storage.BucketIAMMember("stateBucketAccess", {
    bucket: stateBucket.name,
    role: "roles/storage.objectAdmin",
    member: functionServiceAccount.email.apply((email) => `serviceAccount:${email}`),
});

new gcp.projects.IAMMember("functionLogging", {
    project,
    role: "roles/logging.logWriter",
    member: functionServiceAccount.email.apply((email) => `serviceAccount:${email}`),
});

const functionArchive = createFunctionArchive();

const codeObject = new gcp.storage.BucketObject("letterboxdFunctionSource", {
    bucket: codeBucket.name,
    name: "function-source.zip",
    source: functionArchive,
});

const functionServiceAgentMember = projectNumber.apply((number) => `serviceAccount:service-${number}@gcf-admin-robot.iam.gserviceaccount.com`);
const cloudBuildServiceAccountMember = projectNumber.apply((number) => `serviceAccount:service-${number}@gcp-sa-cloudbuild.iam.gserviceaccount.com`);

new gcp.storage.BucketIAMMember("codeBucketFunctionAccess", {
    bucket: codeBucket.name,
    role: "roles/storage.objectViewer",
    member: functionServiceAgentMember,
});

new gcp.storage.BucketIAMMember("codeBucketBuildAccess", {
    bucket: codeBucket.name,
    role: "roles/storage.objectViewer",
    member: cloudBuildServiceAccountMember,
});

const serviceEnv = pulumi.all([stateBucket.name, discordWebhookUrl, letterboxdUsername]).apply(([bucket, webhook, username]) => {
    const env: Record<string, string> = {
        DISCORD_WEBHOOK_URL: webhook,
        USERNAME: username,
        LETTERBOXD_USERNAME: username,
        STATE_BACKEND: "gcp-storage",
        GCP_STATE_BUCKET: bucket,
        GCP_STATE_OBJECT: stateObjectName,
        LOG_LEVEL: logLevel,
        SCHEDULE_FORCE_MOST_RECENT: scheduleForceMostRecent,
        PERSIST_FORCED_STATE: persistForcedState,
    };
    if (maxPosts !== undefined) env.MAX_POSTS = String(maxPosts);
    return env;
});

const cloudFunction = new gcp.cloudfunctionsv2.Function("letterboxdFunction", {
    name: functionName,
    location,
    buildConfig: {
        runtime: "nodejs24",
        entryPoint: "letterboxd",
        source: {
            storageSource: {
                bucket: codeBucket.name,
                object: codeObject.name,
            },
        },
    },
    serviceConfig: {
        maxInstanceCount: 1,
        minInstanceCount: 0,
        availableMemory: memory,
        timeoutSeconds,
        environmentVariables: serviceEnv,
        serviceAccountEmail: functionServiceAccount.email,
        ingressSettings: "ALLOW_ALL",
    },
});

const invokerBinding = new gcp.cloudfunctionsv2.FunctionIamMember("schedulerInvoker", {
    project,
    location,
    cloudFunction: cloudFunction.name,
    role: "roles/cloudfunctions.invoker",
    member: schedulerServiceAccount.email.apply((email) => `serviceAccount:${email}`),
});

const schedulerRoleBinding = new gcp.projects.IAMMember("schedulerLogs", {
    project,
    role: "roles/logging.logWriter",
    member: schedulerServiceAccount.email.apply((email) => `serviceAccount:${email}`),
});

const schedulerJob = new gcp.cloudscheduler.Job("letterboxdScheduler", {
    name: randomSuffix("letterboxd-job"),
    region,
    schedule: scheduleExpression,
    timeZone,
    description: "Invoke Letterboxd Discord hook",
    httpTarget: {
        httpMethod: "POST",
        uri: cloudFunction.serviceConfig.apply((cfg) => cfg?.uri ?? ""),
        oidcToken: {
            serviceAccountEmail: schedulerServiceAccount.email,
        },
        headers: {
            "Content-Type": "application/json",
        },
        body: Buffer.from(JSON.stringify({ source: "gcp.scheduler" })).toString("base64"),
    },
}, { dependsOn: [invokerBinding] });

export const functionNameOutput = cloudFunction.name;
export const functionUri = cloudFunction.serviceConfig.apply((cfg) => cfg?.uri ?? "");
export const schedulerName = schedulerJob.name;
export const stateBucketNameOutput = stateBucket.name;

function createFunctionArchive() {
    const functionDir = path.resolve(__dirname, "function");
    const appDir = path.resolve(__dirname, "..", "..", "app");

    return new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.FileAsset(path.join(functionDir, "index.js")),
        "package.json": new pulumi.asset.FileAsset(path.join(functionDir, "package.json")),
        ".gcloudignore": new pulumi.asset.FileAsset(path.join(functionDir, ".gcloudignore")),
        "package-lock.json": new pulumi.asset.FileAsset(path.join(functionDir, "package-lock.json")),
        "app": new pulumi.asset.FileArchive(appDir),
    });
}

function randomSuffix(prefix: string) {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${random}`.slice(0, 63);
}
