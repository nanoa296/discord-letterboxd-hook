# Azure Deployment (Pulumi)

Ship the shared Letterboxd handler as an Azure Functions timer app with Blob Storage state. Everything in this folder assumes the code lives in `../../app`.

> **Hosting plan retirement: September 30, 2028.** This stack keeps Azure Functions v4 with Node.js 22 on the existing Linux Consumption plan; it does not migrate to Flex Consumption. Plan a migration to a supported hosting plan before the retirement date. See [Microsoft’s runtime and hosting-plan support guidance](https://learn.microsoft.com/azure/azure-functions/functions-versions).

## Requirements
- [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) installed.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) logged in (`az login`) with rights to create resource groups, storage, and Functions.
- Node.js 22 and pnpm 10+ for this target.
- Deployment credentials must be able to assign Azure roles to the package identity.

## Configure
1. Install the Pulumi stack dependencies:
```bash
cd infra/azure
pnpm install
```

2. Pick or create a stack, then set the required values (use `--secret` for the webhook):
```bash
pulumi stack select main || pulumi stack init main
pulumi config set discord-letterboxd-hook-azure:username "letterboxd_user"
pulumi config set --secret discord-letterboxd-hook-azure:discordWebhookUrl "https://discord.com/api/webhooks/..."
```

3. Add optional settings as needed:
- `azure-native:location=eastus` (or another region) to control placement.
- `discord-letterboxd-hook-azure:scheduleExpression="0 */30 * * * *"` to change the timer cadence.
- `discord-letterboxd-hook-azure:logLevel=debug`, `persistForcedState=false`, etc. to mirror the handler env vars.
- `discord-letterboxd-hook-azure:stateContainer` / `codeContainer` to override storage names.

## Deploy
```bash
cd ../../app && pnpm install --prod --frozen-lockfile
cd ../infra/azure
pulumi preview
pulumi up
```
Pulumi zips `../../app`, uploads it to the storage account, and deploys a Linux Consumption Function App with a timer trigger. A user-assigned managed identity gets Storage Blob Data Reader access to the private code container, so the deployment URL has no expiring SAS token. The system-assigned identity remains available for other integrations.

After deploying or replacing the package, restart the app and synchronize its triggers (the external package URL stays the same):
```bash
RESOURCE_GROUP=$(pulumi stack output resourceGroupNameOutput)
FUNCTION_APP=$(pulumi stack output functionAppNameOutput)
az functionapp restart --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP"
FUNCTION_ID=$(az functionapp show --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP" --query id --output tsv)
az rest --method post --url "https://management.azure.com${FUNCTION_ID}/syncfunctiontriggers?api-version=2022-03-01"
```
Azure role assignments can take a few minutes to propagate on the first deployment; retry the restart and trigger synchronization if package access initially fails.

## Operate and Troubleshoot
- State forces `STATE_BACKEND=azure-blob`; checkpoints live in the provisioned storage account.
- Use the Azure Portal to inspect execution status. Application Insights is not provisioned by this stack; configure it separately if you want centralized telemetry.
- Default timer runs every 30 minutes. Adjust `scheduleExpression` for faster/slower runs.
- Run `pnpm install --prod --frozen-lockfile` inside `app/` before deploying so the package contains current dependencies.
- For local testing, install the shared app dependencies, copy `local.settings.json.example` to `local.settings.json` under `infra/azure/functionapp`, and make the shared handler available at `functionapp/app` (for example, `ln -s ../../../app app` from that directory). Set `DRY_RUN=true`, use a local state backend or a separate test storage container, then run Azure Functions Core Tools v4 with `func start`. Do not use production checkpoints for a test.
- Before redeploying this target, verify the current supported `linuxFxVersion` and hosting plan guidance in Azure Functions docs.

## Outputs
- `resourceGroupNameOutput`: Resource group used by the deployment.
- `functionAppNameOutput`: Function App name for quick portal access.
- `functionAppPrincipalId`: Managed identity ID (useful if you grant other roles).
- `timerSchedule`: Cron expression Pulumi applied.

## Updating an existing stack

Default resource names are now derived from the project, stack, and subscription rather than fresh random values. Review `pulumi preview` before applying changes. If reusing an existing deployment, set `storageAccountName` and `functionAppName` to its existing names before updating; other resources may still require replacement. Preserve the state container and checkpoints before accepting any replacement.

## Local validation

After installing this stack's dependencies, run `pnpm lint` and `node --test tests/deployment.test.cjs ../tests/wrappers.test.cjs`. These use mocks and temporary files, with no Azure or Discord calls.

The infrastructure dependency override pins OpenTelemetry API 1.9.0 to satisfy the tracing SDK peer requirements used by Pulumi. Recheck this pin when upgrading Pulumi.
