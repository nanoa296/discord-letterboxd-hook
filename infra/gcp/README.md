# Google Cloud Deployment (Pulumi)

Deploy the Discord Letterboxd hook on Google Cloud Functions (2nd gen) with Cloud Scheduler using Pulumi. This stack provisions:
- State bucket (Cloud Storage)
- Source bucket for the function package
- Cloud Functions v2 HTTP function (Node.js 20)
- Cloud Scheduler job with OIDC authentication
- Service accounts and IAM bindings

## Prerequisites
- gcloud CLI authenticated (`gcloud auth login` and `gcloud config set project <project-id>`)
- Pulumi CLI
- Node.js 18+
- Enable required services: `cloudfunctions.googleapis.com`, `cloudscheduler.googleapis.com`, `storage.googleapis.com`, `run.googleapis.com`

## Install deps
```bash
cd infra/gcp
pnpm install
```

## Configure
```bash
pulumi stack select main || pulumi stack init main
pulumi config set gcp:project your-gcp-project-id
pulumi config set discord-letterboxd-hook-gcp:location us-central1           # optional region override
pulumi config set discord-letterboxd-hook-gcp:letterboxdUsername YOUR_USERNAME
pulumi config set --secret discord-letterboxd-hook-gcp:discordWebhookUrl "https://discord.com/api/webhooks/..."
pulumi config set discord-letterboxd-hook-gcp:scheduleExpression "*/30 * * * *"   # optional cadence
pulumi config set discord-letterboxd-hook-gcp:timeZone Etc/UTC                    # optional timezone
pulumi config set discord-letterboxd-hook-gcp:logLevel info                       # optional logging
pulumi config set discord-letterboxd-hook-gcp:persistForcedState true             # optional forced-post persistence
# pulumi config set discord-letterboxd-hook-gcp:stateBucketName letterboxd-state  # optional bucket override
# pulumi config set discord-letterboxd-hook-gcp:codeBucketName letterboxd-code    # optional source bucket override
# pulumi config set discord-letterboxd-hook-gcp:maxPosts 1                        # optional cap per run
```

## Deploy
```bash
pulumi up
```

## Runtime Notes
- The function uses `STATE_BACKEND=gcp-storage`; checkpoints live in the managed bucket.
- Cloud Scheduler hits the HTTPS trigger using a dedicated service account with OIDC tokens.
- The packaged archive includes the shared `app/` directory. Run `pnpm install --prod` in `app/` before `pulumi up` so dependencies are present.
- To adjust memory/timeout, set `discord-letterboxd-hook-gcp:memory` (e.g., `256Mi`) or `timeoutSeconds`.

## Local Testing
```bash
cd infra/gcp/function
npm install --package-lock-only   # creates package-lock.json for Cloud Functions build
gcloud functions deploy letterboxd --region=us-central1 --gen2 --runtime=nodejs24 --entry-point=letterboxd --trigger-http
```
(Replace the deploy command with your own parameters or rely on Pulumi to deploy.)

## Outputs
- `functionNameOutput`: Deployed Cloud Function name
- `functionUri`: HTTPS trigger URL
- `schedulerName`: Cloud Scheduler job name
- `stateBucketNameOutput`: Bucket storing the checkpoint state
