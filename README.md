# Discord Letterboxd Hook

![Example Discord embed showing a Letterboxd diary entry mirrored into Discord](discord-letterboxd-post.png)

Poll a Letterboxd diary feed and mirror new entries into a Discord channel. The codebase shares one Node.js script (`app/handler.js`) and includes ready-to-deploy stacks for VPS cron jobs/Pulumi programs for AWS Lambda, Azure Functions, and Google Cloud Functions under `infra`. See `CHANGELOG.md` for version history and upgrades.

## What the Script Does
- Treats RSS entries that link to `letterboxd.com/film/...`, show a star rating, or contain “Watched on …” as diary items.
- Posts new entries oldest → newest with posters, watched date, and star rating in a Discord embed.
- Persists the last seen entry in the configured state backend (SSM, file, Azure Blob, or GCS) and auto-resyncs if the checkpoint disappears.
- Accepts multiple Letterboxd usernames in one comma-separated environment variable and iterates through each feed during a scheduled run.

## Requirements
- Node.js 20+ (development + local tests)
- pnpm 8+
- At least one deployment target (VPS, AWS, Azure, or GCP)

## Deploy It
Pick the workflow that matches your hosting style. Each README walks through the full configuration (`pulumi config` or `.env` values) and deploy command.

| Target | Highlights | Notes |
| --- | --- | --- |
| Linux VPS / cron | Simple shell script + `node` | Ideal for a self-managed box; cron entry includes logging guidance. |
| AWS Lambda (Pulumi) | EventBridge Scheduler + SSM | Uses AWS SSM for state by default; toggle `enableSchedule`/`persistForcedState` via config. |
| Azure Functions (Pulumi) | Consumption plan + Blob storage | Packages `app/` into a timer-triggered Function App; state lives in Azure Storage. |
| Google Cloud Functions (Pulumi) | Cloud Scheduler + Cloud Storage | Cloud Functions v2 with OIDC-auth Scheduler and GCS-backed state. |

> Tip: run `pnpm install --prod` inside `app/` before deploying any cloud stack so the packaged archive includes current dependencies.

## State Persistence
The handler auto-detects where to store the last processed diary entry:
- **AWS SSM Parameter Store** (default when running under Lambda).
- **Local file** when `STATE_FILE` is set (used by the VPS helper).
- **Azure Blob Storage** when `AZURE_STORAGE_CONNECTION_STRING` is present or `STATE_BACKEND=azure-blob`.
- **Google Cloud Storage** when `GCP_STATE_BUCKET`/`STATE_BACKEND=gcp-storage` are defined.

Force a specific backend with `STATE_BACKEND` if you need to override the detection logic.

When you list multiple usernames, the handler maintains a separate checkpoint per account. SSM Parameter names, blob/object names, or the local file automatically gain a sanitized username suffix unless you include `{user}` in `PARAM_NAME`, `AZURE_STATE_BLOB`, or `GCP_STATE_OBJECT` to control the exact naming.

## Environment Variables
All deployment targets rely on the same env vars (Pulumi stacks map them to cloud config; the VPS `.env` template sets them locally):

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | ✅ | Discord webhook that receives the diary updates. |
| `LETTERBOXD_USERNAME` | ✅ | One or more Letterboxd usernames separated by commas (e.g. `name1,name2`). |
| `PARAM_NAME` | ➖ | Optional SSM parameter name used to store the last processed entry id. Defaults to `/letterboxd/lastSeenId`. |
| `DRY_RUN` | ➖ | When set to `true`, logs the would-be Discord payloads without posting. |
| `FORCE_MOST_RECENT` | ➖ | When set to `true`, posts the newest diary entry even if nothing is newer than the stored checkpoint—useful for manual tests. |
| `SCHEDULE_FORCE_MOST_RECENT` | ➖ | If `true`, scheduled invocations (EventBridge) automatically force-post the newest entry when no new diary entries are detected. With persistence enabled this will only happen once; if you disable persistence it will repost the same entry each run. Default is `false`. |
| `LOG_LEVEL` | ➖ | Set to `debug`, `info` (default), `warn`, or `error` to control logging verbosity. |
| `MAX_POSTS` | ➖ | Caps how many entries are posted in a single invocation. |
| `LAST_SEEN_OVERRIDE` | ➖ | Temporarily replace the value read from Parameter Store without updating it (handy for ad-hoc replays). |
| `STATE_FILE` | ➖ | When set, the script stores its last-seen ID in a local file instead of AWS SSM (defaults to `app/.lastSeen` when using the VPS helper). |
| `STATE_BACKEND` | ➖ | Force a specific state store (`aws-ssm`, `file`, `azure-blob`, `gcp-storage`). Defaults to auto-detect based on the env vars below. |
| `AZURE_STORAGE_CONNECTION_STRING` | ➖ | Enables Azure Blob storage for state by pointing at an existing storage account. Combine with `AZURE_STATE_CONTAINER`/`AZURE_STATE_BLOB` if you need custom names. |
| `AZURE_STATE_CONTAINER` | ➖ | Container name used when `AZURE_STORAGE_CONNECTION_STRING` is set (default `letterboxd-state`). |
| `AZURE_STATE_BLOB` | ➖ | Blob name used when `AZURE_STORAGE_CONNECTION_STRING` is set (default `lastSeenId`). |
| `GCP_STATE_BUCKET` | ➖ | Google Cloud Storage bucket for state persistence. Alias: `GCS_STATE_BUCKET`. |
| `GCP_STATE_OBJECT` | ➖ | Object/key name inside the bucket (default `lastSeenId`). |
| `PERSIST_FORCED_STATE` | ➖ | Controls whether forced posts update the stored checkpoint. Defaults to `true`; set to `false` when you intentionally want to replay the most recent entry repeatedly for troubleshooting. |

Enabling `SCHEDULE_FORCE_MOST_RECENT` while `PERSIST_FORCED_STATE` is `false` keeps reposting the same diary entry until new activity shows up, so reserve that combination for short-lived diagnostics.

## Manual Test
```bash
cd app
pnpm install
node -e 'require("./handler").handler({ forceMostRecent: true, maxPosts: 1 }).then(console.log).catch(console.error)'
```
