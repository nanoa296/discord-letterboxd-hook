# Azure Deployment (Pulumi)

Deploy the Discord Letterboxd hook on Azure Functions using Pulumi. This stack provisions:
- Resource group
- Storage account + blob container (state persistence)
- Consumption-tier Function App (Node.js 24, currently in preview)
- Timer trigger matching the provided cron expression

## Prerequisites
- Azure CLI logged in (`az login`)
- Pulumi CLI
- Node.js 18+

## Install deps
```bash
cd infra/azure
pnpm install
```

## Configure
```bash
pulumi stack select main || pulumi stack init main
pulumi config set azure-native:location eastus         # optional region override
pulumi config set discord-letterboxd-hook-azure:username YOUR_USERNAME
pulumi config set --secret discord-letterboxd-hook-azure:discordWebhookUrl "https://discord.com/api/webhooks/..."
pulumi config set discord-letterboxd-hook-azure:scheduleExpression "0 */30 * * * *"   # optional
pulumi config set discord-letterboxd-hook-azure:logLevel info                           # optional
pulumi config set discord-letterboxd-hook-azure:persistForcedState true                 # optional
# pulumi config set discord-letterboxd-hook-azure:stateContainer letterboxd-state       # optional container name override
# pulumi config set discord-letterboxd-hook-azure:codeContainer letterboxd-code         # optional package container name
```

## Deploy
```bash
pulumi up
```

## Runtime Notes
- `STATE_BACKEND` is forced to `azure-blob`; the Function app stores checkpoints in the provisioned blob container.
- The timer trigger defaults to every 30 minutes; adjust via `scheduleExpression`.
- Logs are available in Application Insights (created automatically for consumption plans).
- The deployment packages the shared `app/` directory (including `node_modules`). Run `pnpm install --prod` in `app/` before `pulumi up` so the archive reflects your latest code and dependencies.

## Local Testing
```bash
cd infra/azure/functionapp
cp local.settings.json.example local.settings.json
pnpm install
func start
```

## Outputs
- `functionAppNameOutput`: Deployed Function App name
- `functionAppPrincipalId`: Managed identity principal ID
- `timerSchedule`: The active cron expression
