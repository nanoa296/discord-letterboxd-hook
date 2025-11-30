# Google Cloud Deployment (Pulumi)

Ship the shared handler as a Cloud Functions (2nd gen) HTTP service with Cloud Scheduler and Cloud Storage-backed state. Everything here assumes the code lives in `../../app`.

## Requirements
- [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) installed.
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) authenticated (`gcloud auth login`) and pointed at your project (`gcloud config set project <id>`).
- Node.js 22+ and pnpm 10+.
- Enable these services once per project: `cloudfunctions.googleapis.com`, `cloudscheduler.googleapis.com`, `storage.googleapis.com`, `run.googleapis.com`.

## Configure
1. Install the Pulumi stack dependencies:
```bash
cd infra/gcp
pnpm install
```

2. Pick or create a stack, then set the required values (`--secret` for the webhook):
```bash
pulumi stack select main || pulumi stack init main
pulumi config set gcp:project your-project-id
pulumi config set discord-letterboxd-hook-gcp:username "letterboxd_user"
pulumi config set --secret discord-letterboxd-hook-gcp:discordWebhookUrl "https://discord.com/api/webhooks/..."
```

3. Apply any optional settings you need:
- `discord-letterboxd-hook-gcp:location=us-central1` to pick the region.
- `discord-letterboxd-hook-gcp:scheduleExpression="*/15 * * * *"` or `timeZone="America/Los_Angeles"` to control the scheduler.
- `discord-letterboxd-hook-gcp:logLevel=debug`, `maxPosts=1`, `persistForcedState=false`, etc. mirror the handler env vars.
- `discord-letterboxd-hook-gcp:stateBucketName` / `codeBucketName` to reuse existing buckets.
- `discord-letterboxd-hook-gcp:memory="256Mi"` or `timeoutSeconds=120` to tune resources.

## Deploy
```bash
pulumi up
```
Pulumi zips `../../app`, uploads it to the code bucket, deploys a Cloud Functions v2 service (Node.js 22 runtime), grants access to the state bucket, and creates a Cloud Scheduler job that hits the HTTPS endpoint with OIDC credentials.

## Operate and Troubleshoot
- State forces `STATE_BACKEND=gcp-storage`; checkpoints live in the managed bucket.
- Scheduler retries and failure emails follow the Cloud Scheduler defaults—edit the job if you need custom behavior.
- Run `pnpm install --prod` inside `app/` before deploying so the archive includes current dependencies.
- Logs flow through Cloud Logging; filter by the `functionNameOutput` shown below.
- Manual dry run: `cd infra/gcp/function`, copy or edit files as needed, run `npm install --package-lock-only`, then `gcloud functions deploy ...` if you want to test outside Pulumi.

## Outputs
- `functionNameOutput`: Cloud Function service name.
- `functionUri`: HTTPS endpoint Cloud Scheduler invokes.
- `schedulerName`: Cloud Scheduler job ID.
- `stateBucketNameOutput`: Bucket storing the checkpoint files.
