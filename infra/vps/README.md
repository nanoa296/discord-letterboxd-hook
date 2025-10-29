# VPS Deployment (Cron)

Run the same Letterboxd → Discord script on any Linux host with cron.

## Quick Steps
1. **Copy env template**
   ```bash
   cp infra/vps/.env.example infra/vps/.env
   ```
   Edit `infra/vps/.env` to suit your deployment (optional overrides like `PERSIST_FORCED_STATE=false` or `FORCE_MOST_RECENT=true` are included and commented out).
2. **Install deps** (one time)
   ```bash
   cd /path/to/repo/app
   pnpm install --prod
   ```
3. **Make runner executable**
   ```bash
   chmod +x infra/vps/scripts/run-letterboxd.sh
   ```
4. **Add cron entry** (adjust path first)
   ```bash
   crontab -l > /tmp/letterboxd.cron 2>/dev/null || true
   cat infra/vps/cron/letterboxd-cron >> /tmp/letterboxd.cron
   crontab /tmp/letterboxd.cron && rm /tmp/letterboxd.cron
   ```

## Notes
- Logs go to stdout/stderr; cron redirects to `/var/log/syslog` or the logfile you choose.
- `STATE_FILE` defaults to `app/.lastSeen`. Change it in `.env` if you prefer another location or shared storage.
- `infra/vps/.env.example` lists optional overrides such as `PERSIST_FORCED_STATE=false` and `FORCE_MOST_RECENT=true`. Enabling both makes the same entry repost on each run—use that combo only for troubleshooting.
- To test immediately:
  ```bash
  infra/vps/scripts/run-letterboxd.sh
  ```
- Prefer systemd timers? Point a service unit at the same script; no changes needed.
