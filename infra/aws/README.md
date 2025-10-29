# AWS Deployment (Pulumi)

Pulumi provisions the Lambda function, IAM role, SSM parameter, and EventBridge schedule. The function code lives in `../../app`.

## Steps
1. Install deps
   ```bash
   cd infra/aws
   pnpm install
   ```
2. Choose a stack
   ```bash
   pulumi stack select main || pulumi stack init main
   ```
3. Configure (use `--secret` for sensitive values)
   ```bash
   pulumi config set aws:region us-east-1
   pulumi config set --secret discord-letterboxd-hook:discordWebhookUrl "https://discord.com/api/webhooks/..."
   pulumi config set discord-letterboxd-hook:letterboxdUsername "YOUR_USERNAME_HERE"
   # Optional: turn off the managed EventBridge schedule
   pulumi config set discord-letterboxd-hook:enableSchedule false
   # Optional: disable checkpoint persistence for troubleshooting replays
   pulumi config set discord-letterboxd-hook:persistForcedState false
   ```
4. Deploy
   ```bash
   pulumi up
   ```

To change the polling cadence, set `discord-letterboxd-hook:scheduleExpression`. To point at a different source directory, set `discord-letterboxd-hook:lambdaPath`.

## References
- Logs: `/aws/lambda/letterboxd-discord-hook`
- Test payload: `test-event.json`
- Stack files: `aws-stack.ts`, `Pulumi.yaml`, `Pulumi.main.yaml`

## Useful Notes
- Code source: Pulumi archives ../../app. To override this path, set discord-letterboxd-hook:lambdaPath.
- Logs: CloudWatch → /aws/lambda/letterboxd-discord-hook
- Sample payload: infra/aws/test-event.json works well for console tests.
- Stack files: aws-stack.ts, Pulumi.yaml, and Pulumi.<stack>.yaml
- The EventBridge schedule deploys by default. Set `discord-letterboxd-hook:enableSchedule=false` if you plan to manage triggers yourself.
- When you enable `SCHEDULE_FORCE_MOST_RECENT`, the Lambda will force-post the newest diary entry if no new items appear. Pair it with `discord-letterboxd-hook:persistForcedState=true` (default) so the checkpoint advances and the entry only posts once; flip the flag to `false` only for short troubleshooting sessions where you want repeated replays.
