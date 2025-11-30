# AWS Deployment (Pulumi)

Ship the shared Letterboxd handler as an AWS Lambda with its own IAM role, SSM parameter for state, and EventBridge schedule. Everything in this folder assumes the code lives in `../../app`.

## Requirements
- [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) installed and logged in.
- [AWS CLI](https://aws.amazon.com/cli/) credentials with permission to create Lambda, IAM, SSM, and EventBridge resources.
- Node.js 22+ and pnpm 10+

## Configure
1. Install the Pulumi stack dependencies:
```bash
cd infra/aws
pnpm install
```

2. Pick or create a stack (ex. `main`), then set the required values (use `--secret` to obscure and encrypt any variables you don't want public):
```bash
pulumi stack select main || pulumi stack init main
pulumi config set aws:region us-east-1
pulumi config set discord-letterboxd-hook:username "letterboxd_user"
pulumi config set --secret discord-letterboxd-hook:discordWebhookUrl "https://discord.com/api/webhooks/..."
```

3. Set any optional knobs, if you want:
- `discord-letterboxd-hook:enableSchedule=false` if you plan to trigger Lambda yourself.
- `discord-letterboxd-hook:scheduleExpression="cron(0/30 * * * ? *)"` to change the EventBridge cadence.
- `discord-letterboxd-hook:persistForcedState=false` when debugging repeated replays.
- `discord-letterboxd-hook:lambdaPath="../custom-app"` if your code sits somewhere other than `../../app`.

## Deploy
```bash
pulumi up
```
Pulumi zips `../../app`, uploads it to Lambda, wires the IAM role/permissions, writes the SSM Parameter Store checkpoint, and registers the EventBridge schedule (unless disabled).

## Operate and Troubleshoot
- CloudWatch Logs: `/aws/lambda/letterboxd-discord-hook`
- Sample test event for the Lambda console: `infra/aws/test-event.json`
- Stack sources: `aws-stack.ts`, `Pulumi.yaml`, and `Pulumi.<stack>.yaml`
- Runtime env vars map 1:1 with the root README. Turning on `SCHEDULE_FORCE_MOST_RECENT` will force-post the newest diary entry; keep `persistForcedState=true` so it only happens once.
