# VPS Deployment (Cron)

Run the shared handler on any Linux host with cron (or systemd timers) using the helper script in this folder.

## Requirements
- Node.js 22+ and pnpm 10+ available on the host.
- Access to install packages under `/path/to/repo/app`.
- Ability to edit the user’s crontab (or create a systemd service/timer).

## Configure
1. Copy the env template and fill in the required variables (`DISCORD_WEBHOOK_URL`, `USERNAME`, etc.):
```bash
cp infra/vps/.env.example infra/vps/.env
```

2. Install app dependencies (one time per host):
```bash
cd /path/to/repo/app
pnpm install --prod
```

3. Make the runner executable:
```bash
chmod +x infra/vps/scripts/run-letterboxd.sh
```

4. Schedule it with cron (edit the template paths before applying):
```bash
crontab -l > /tmp/letterboxd.cron 2>/dev/null || true
cat infra/vps/cron/letterboxd-cron >> /tmp/letterboxd.cron
crontab /tmp/letterboxd.cron && rm /tmp/letterboxd.cron
```
The sample cron runs every 30 minutes and pipes stdout/stderr to `/var/log/letterboxd.log`. Adjust the cadence and log location to taste.

## Operate and Troubleshoot
- `STATE_FILE` defaults to `app/.lastSeen`; change it in `.env` if you prefer a different checkpoint location.
- Run the script manually for quick tests: `infra/vps/scripts/run-letterboxd.sh`.
- Prefer systemd? Point a service/timer at the same script and reuse `infra/vps/.env`.
- `FORCE_MOST_RECENT=true` plus `PERSIST_FORCED_STATE=false` replays the newest entry on every run—handy for troubleshooting, not for regular use.
