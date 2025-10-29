import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure-native";
import * as path from "path";

const config = new pulumi.Config();

const location = config.get("location") ?? "eastus";
const resourceGroupName = config.get("resourceGroupName") ?? "letterboxd-rg";
const storageAccountName = config.get("storageAccountName") ?? randomSuffix("letterboxdstorage");
const functionAppName = config.get("functionAppName") ?? randomSuffix("letterboxd-func");
const scheduleExpression = config.get("scheduleExpression") ?? "0 */30 * * * *"; // every 30 minutes
const letterboxdUsername = config.require("letterboxdUsername");
const discordWebhookUrl = config.requireSecret("discordWebhookUrl");
const stateContainerName = config.get("stateContainer") ?? "letterboxd-state";
const stateBlobName = config.get("stateBlob") ?? "lastSeenId";
const codeContainerName = config.get("codeContainer") ?? "function-code";
const logLevel = config.get("logLevel") ?? process.env.LOG_LEVEL ?? "info";
const scheduleForceMostRecent = (config.get("scheduleForceMostRecent") ?? process.env.SCHEDULE_FORCE_MOST_RECENT ?? "false").toString();
const persistForcedState = config.get("persistForcedState") ?? "true";

const resourceGroup = new azure.resources.ResourceGroup("letterboxdResourceGroup", {
    resourceGroupName,
    location,
});

const storageAccount = new azure.storage.StorageAccount("letterboxdStorage", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    accountName: storageAccountName,
    kind: "StorageV2",
    sku: {
        name: "Standard_LRS",
    },
});

const stateContainer = new azure.storage.BlobContainer("letterboxdStateContainer", {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    containerName: stateContainerName,
    publicAccess: "None",
});

const codeContainer = new azure.storage.BlobContainer("letterboxdCodeContainer", {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    containerName: codeContainerName,
    publicAccess: "None",
});

const storageAccountKeys = azure.storage.listStorageAccountKeysOutput({
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
});

const storageConnectionString = storageAccountKeys.keys.apply((keys) =>
    pulumi.interpolate`DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${keys[0].value};EndpointSuffix=core.windows.net`
);

const functionPlan = new azure.web.AppServicePlan("letterboxdPlan", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    name: randomSuffix("letterboxd-plan"),
    sku: {
        capacity: 1,
        tier: "Dynamic",
        name: "Y1",
    },
});

const functionAppDir = path.resolve(__dirname, "functionapp");
const appSourceDir = path.resolve(__dirname, "..", "..", "app");

const functionArchive = new pulumi.asset.AssetArchive({
    "host.json": new pulumi.asset.FileAsset(path.join(functionAppDir, "host.json")),
    ".funcignore": new pulumi.asset.FileAsset(path.join(functionAppDir, ".funcignore")),
    "package.json": new pulumi.asset.FileAsset(path.join(functionAppDir, "package.json")),
    "TimerTrigger/index.js": new pulumi.asset.FileAsset(path.join(functionAppDir, "TimerTrigger", "index.js")),
    "TimerTrigger/function.json": new pulumi.asset.StringAsset(JSON.stringify({
        scriptFile: "index.js",
        bindings: [
            {
                name: "timer",
                type: "timerTrigger",
                direction: "in",
                schedule: scheduleExpression,
            },
        ],
    }, null, 2)),
    "app": new pulumi.asset.FileArchive(appSourceDir),
});

const codeBlob = new azure.storage.Blob("letterboxdFunctionCode", {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    containerName: codeContainer.name,
    blobName: "functionapp.zip",
    type: "Block",
    source: functionArchive,
});

const codeBlobSas = azure.storage.listStorageAccountServiceSASOutput({
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
    protocols: azure.storage.HttpProtocol.Https,
    sharedAccessStartTime: pulumi.output(new Date()).apply((d) => d.toISOString()),
    sharedAccessExpiryTime: pulumi.output(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)).apply((d) => d.toISOString()),
    resource: azure.storage.SignedResource.C,
    permissions: azure.storage.Permissions.R,
    canonicalizedResource: pulumi.interpolate`/blob/${storageAccount.name}/${codeContainer.name}`,
    contentType: "application/zip",
});

const packageUrl = pulumi.interpolate`https://${storageAccount.name}.blob.core.windows.net/${codeContainer.name}/${codeBlob.name}?${codeBlobSas.serviceSasToken}`;

const appSettings = pulumi.all([storageConnectionString, discordWebhookUrl, packageUrl]).apply(([connectionString, webhook, packageSasUrl]) => ([
    { name: "AzureWebJobsStorage", value: connectionString },
    { name: "FUNCTIONS_WORKER_RUNTIME", value: "node" },
    { name: "NODE_ENV", value: "production" },
    { name: "DISCORD_WEBHOOK_URL", value: webhook },
    { name: "LETTERBOXD_USERNAME", value: letterboxdUsername },
    { name: "STATE_BACKEND", value: "azure-blob" },
    { name: "AZURE_STORAGE_CONNECTION_STRING", value: connectionString },
    { name: "AZURE_STATE_CONTAINER", value: stateContainerName },
    { name: "AZURE_STATE_BLOB", value: stateBlobName },
    { name: "LOG_LEVEL", value: logLevel },
    { name: "SCHEDULE_FORCE_MOST_RECENT", value: scheduleForceMostRecent },
    { name: "PERSIST_FORCED_STATE", value: persistForcedState },
    { name: "WEBSITE_RUN_FROM_PACKAGE", value: packageSasUrl },
]));

const functionApp = new azure.web.WebApp("letterboxdFunction", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    name: functionAppName,
    serverFarmId: functionPlan.id,
    siteConfig: {
        appSettings,
        linuxFxVersion: "NODE|20",
        http20Enabled: true,
    },
    kind: "functionapp",
    httpsOnly: true,
    identity: {
        type: "SystemAssigned",
    },
});

export const functionAppNameOutput = functionApp.name;
export const functionAppPrincipalId = functionApp.identity.apply((i) => i?.principalId);
export const timerSchedule = pulumi.output(scheduleExpression);

function randomSuffix(prefix: string) {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${random}`.slice(0, 24);
}
