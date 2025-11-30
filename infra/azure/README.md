# Azure Deployment (Pulumi)

Ship the shared Letterboxd handler as an Azure Functions timer app with Blob Storage state. Everything in this folder assumes the code lives in `../../app`.

## Requirements
- [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) installed.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) logged in (`az login`) with rights to create resource groups, storage, and Functions.
- Node.js 22+ and pnpm 10+.

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
pulumi up
```
Pulumi zips `../../app`, uploads it to the storage account, and deploys a consumption-tier Function App (Node.js 24 runtime) with a managed identity and timer trigger (unless you override the schedule).

## Operate and Troubleshoot
- State forces `STATE_BACKEND=azure-blob`; checkpoints live in the provisioned storage account.
- Logs flow to Application Insights. Use `func azure functionapp logstream <appName>` or the Azure Portal to watch them.
- Default timer runs every 30 minutes. Adjust `scheduleExpression` for faster/slower runs.
- Run `pnpm install --prod` inside `app/` before deploying so the package contains current dependencies.
- Local dry-run: duplicate `local.settings.json.example` -> `local.settings.json` under `infra/azure/functionapp`, run `pnpm install`, then `func start`.

## Outputs
- `functionAppNameOutput`: Function App name for quick portal access.
- `functionAppPrincipalId`: Managed identity ID (useful if you grant other roles).
- `timerSchedule`: Cron expression Pulumi applied.
