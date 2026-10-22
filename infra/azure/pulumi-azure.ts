import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure-native";
import * as path from "path";
import { createHash } from "crypto";

const config = new pulumi.Config();

const location = config.get("location") ?? "eastus";
const resourceGroupName = config.get("resourceGroupName") ?? "letterboxd-rg";
const nameSuffix = createHash("sha256").update(`${azure.config.subscriptionId}:${pulumi.getProject()}:${pulumi.getStack()}`).digest("hex").slice(0, 10);
const storageAccountName = config.get("storageAccountName") ?? `letterboxd${nameSuffix}`;
const functionAppName = config.get("functionAppName") ?? `letterboxd-func-${nameSuffix}`;
const scheduleExpression = config.get("scheduleExpression") ?? "0 */30 * * * *"; // every 30 minutes
const username = requireUsername(config);
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
    name: `letterboxd-plan-${nameSuffix}`,
    kind: "linux",
    reserved: true,
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

// Grant package access before creating the app so its first startup can fetch code.
const packageIdentity = new azure.managedidentity.UserAssignedIdentity("letterboxdPackageIdentity", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    resourceName: `letterboxd-package-${nameSuffix}`,
});
const clientConfig = azure.authorization.getClientConfigOutput({});
const packageReader = new azure.authorization.RoleAssignment("letterboxdPackageReader", {
    scope: codeContainer.id,
    principalId: packageIdentity.principalId,
    principalType: "ServicePrincipal",
    roleDefinitionId: pulumi.interpolate`/subscriptions/${clientConfig.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/2a2b9908-6ea1-4ae2-8e65-a410df84e7d1`,
});
const packageUrl = pulumi.interpolate`https://${storageAccount.name}.blob.core.windows.net/${codeContainer.name}/${codeBlob.name}`;

const appSettings = pulumi.all([storageConnectionString, discordWebhookUrl, packageUrl, packageIdentity.id]).apply(([connectionString, webhook, packageBlobUrl, packageIdentityId]) => ([
    { name: "AzureWebJobsStorage", value: connectionString },
    { name: "FUNCTIONS_WORKER_RUNTIME", value: "node" },
    { name: "FUNCTIONS_EXTENSION_VERSION", value: "~4" },
    { name: "NODE_ENV", value: "production" },
    { name: "DISCORD_WEBHOOK_URL", value: webhook },
    { name: "USERNAME", value: username },
    { name: "STATE_BACKEND", value: "azure-blob" },
    { name: "AZURE_STORAGE_CONNECTION_STRING", value: connectionString },
    { name: "AZURE_STATE_CONTAINER", value: stateContainerName },
    { name: "AZURE_STATE_BLOB", value: stateBlobName },
    { name: "LOG_LEVEL", value: logLevel },
    { name: "SCHEDULE_FORCE_MOST_RECENT", value: scheduleForceMostRecent },
    { name: "PERSIST_FORCED_STATE", value: persistForcedState },
    { name: "WEBSITE_RUN_FROM_PACKAGE", value: packageBlobUrl },
    { name: "WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID", value: packageIdentityId },
]));

const functionApp = new azure.web.WebApp("letterboxdFunction", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    name: functionAppName,
    serverFarmId: functionPlan.id,
    siteConfig: {
        appSettings,
        linuxFxVersion: "NODE|22",
        http20Enabled: true,
    },
    kind: "functionapp,linux",
    reserved: true,
    httpsOnly: true,
    identity: {
        type: "SystemAssigned, UserAssigned",
        userAssignedIdentities: [packageIdentity.id],
    },
}, { dependsOn: [packageReader] });

export const resourceGroupNameOutput = resourceGroup.name;
export const functionAppNameOutput = functionApp.name;
export const functionAppPrincipalId = functionApp.identity.apply((i) => i?.principalId);
export const timerSchedule = pulumi.output(scheduleExpression);

function requireUsername(config: pulumi.Config) {
    const direct = config.get("username");
    if (direct && direct.trim()) {
        return direct.trim();
    }
    const legacy = config.get("letterboxdUsername");
    if (legacy && legacy.trim()) {
        return legacy.trim();
    }
    throw new Error("Set 'discord-letterboxd-hook-azure:username' (legacy: letterboxdUsername) via Pulumi config.");
}
