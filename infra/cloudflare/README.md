# Cloudflare Workers deployment

Deploy the same Letterboxd-to-Discord behavior using a scheduled Worker and Workers KV. This is an optional target; AWS remains the primary deployment.

## Requirements

- Node.js 22+, pnpm, and the Pulumi CLI.
- A Cloudflare account and account ID. No domain is required.
- A Cloudflare API token scoped to that account with Workers Scripts: Edit and Workers KV Storage: Edit permissions.
- A Discord webhook and one or more Letterboxd usernames.

## Deploy

From this directory:

```bash
pnpm install --frozen-lockfile
pulumi stack init main
export CLOUDFLARE_API_TOKEN='<your-api-token>'
pulumi config set accountId '<your-cloudflare-account-id>'
pulumi config set username 'user1:FilmFan,user2'
pulumi config set --secret discordWebhookUrl 'https://discord.com/api/webhooks/...'
pulumi preview
pulumi up
```

Pulumi creates the KV namespace, bundles the Worker directly from current source, uploads the module with its configuration and secret, and creates the Cron Trigger. You do not need Wrangler for deployment. The bundle contains the shared application logic and the Workers XML parser, without the Node adapter or other providers' SDKs. Both preview and update rebuild the bundle.

The default schedule is `*/30 * * * *`. Cloudflare cron expressions have five fields and run in UTC. Schedule changes can take several minutes to propagate. There is no HTTP endpoint for posting or replaying entries; HTTP requests return 404.

Pulumi exports `workerName`, `stateNamespaceId`, and `schedule`. Inspect scheduled invocations and logs in the Cloudflare dashboard under Workers & Pages → your Worker.

## Configuration

| Pulumi setting | Default | Purpose |
| --- | --- | --- |
| `accountId` | Required | Cloudflare account ID. |
| `username` | Required | Comma-separated accounts with optional `:DiscordLabel`; legacy `letterboxdUsername` is accepted. |
| `discordWebhookUrl` | Required secret | Discord webhook. |
| `workerName` | Stable project/stack/account-derived name | Worker name. |
| `scheduleExpression` | `*/30 * * * *` | Cron expression, UTC. |
| `stateKey` | `lastSeenId/{user}` | KV key template; must contain `{user}`, replaced with the normalized username. |
| `logLevel` | `info` | `debug`, `info`, `warn`, or `error`. |
| `maxPosts` | Unset | Maximum posts per account per invocation. |
| `dryRun` | `false` | Log candidate entries without posting or changing state. |
| `forceMostRecent` | `false` | Force a replay when there are no new candidates. |
| `scheduleForceMostRecent` | `false` | Apply forced replay to scheduled runs unless `forceMostRecent` explicitly overrides it. |
| `persistForcedState` | `true` | Whether forced replay posts update checkpoints. |
| `lastSeenOverride` | Unset | Temporary checkpoint override; prevents checkpoint writes. |

Boolean settings accept the same values as the Node implementation, including `true`, `1`, and `yes`.

To troubleshoot, set `dryRun` and optionally `forceMostRecent`, run `pulumi up`, and inspect the next scheduled invocation. Restore the settings afterward. The exported `createWorkerHandler(env)(event)` also accepts the same event options as the Node handler for local tests, including `dryRun`, `maxPosts`, `forceMostRecent`, `persistForcedState`, and `lastSeen`.

## Checkpoints and migration

Every account always gets its own KV key, even when only one account is configured. Adding another account preserves existing keys. First invocation initializes each account at the newest entry without posting history; forcing a replay posts the newest candidate. A stored checkpoint that no longer appears in the RSS feed causes the existing reset/backfill behavior.

KV is eventually consistent and does not provide a lock. Avoid running two deployments against the same Discord webhook and accounts at once unless duplicate posts are intentional. Discord posting and checkpoint writes are not atomic: a failure between them can cause a duplicate on a later invocation.

To migrate from another platform, stop its schedule before enabling this one. A fresh namespace initializes at the current newest entry; if you need continuity across the cutover, copy each existing checkpoint into its corresponding KV key before the first invocation. Renaming the Worker can replace the namespace; changing `stateKey` also starts a new set of checkpoints. `pulumi destroy` removes the Worker, trigger, and KV namespace, including its saved checkpoints.

Workers KV limits writes to the same key to one per second. The adapter spaces posts by at least 1.1 seconds so multi-post runs respect this limit.

## Local validation (no deployment)

From the repository root, install the shared app dependencies used by the parser comparison tests, then run the Cloudflare checks:

```bash
pnpm --dir app install --frozen-lockfile
pnpm --dir infra/cloudflare install --frozen-lockfile
pnpm --dir infra/cloudflare lint
pnpm --dir infra/cloudflare build
pnpm --dir infra/cloudflare test
```

Tests use in-memory state and mocked network requests; they do not send Discord messages or create cloud resources. The behavior suite compares the Workers RSS normalization and Discord payloads with the existing Node parser and shared handler. Run the repository's existing deployment regression checks as well. These commands require no Cloudflare credentials and deploy no resources.

The Cloudflare package pins `@opentelemetry/api` to 1.9.0, matching the other Pulumi projects, to satisfy the tracing SDK peer requirements. The local build works with dependency lifecycle scripts disabled; enabling those scripts is not required for these checks.

Workers and KV offer free allowances suitable for small deployments. CPU usage needs checking in real scheduled invocations; local tests do not establish production CPU consumption or prove that Letterboxd accepts requests from Cloudflare's network.

References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Pulumi WorkersScript](https://www.pulumi.com/registry/packages/cloudflare/api-docs/workersscript/).
