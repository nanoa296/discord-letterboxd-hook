import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import { createHash } from "node:crypto";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const username = config.get("username") ?? config.get("letterboxdUsername");
if (!username?.trim()) throw new Error("Set username via Pulumi config.");
const suffix = createHash("sha256")
    .update(`${accountId}:${pulumi.getProject()}:${pulumi.getStack()}`).digest("hex").slice(0, 10);
const scriptName = config.get("workerName") ?? `letterboxd-${suffix}`;
const stateKey = config.get("stateKey") ?? "lastSeenId/{user}";
if (!stateKey.includes("{user}")) throw new Error("stateKey must include {user}");

// Build during both preview and update so stale artifacts cannot be deployed.
const { bundle } = require("./build.cjs") as { bundle: () => string };
const namespace = new cloudflare.WorkersKvNamespace("letterboxdState", {
    accountId,
    title: `${scriptName}-state`,
});
const variables: Record<string, string> = {
    USERNAME: username.trim(),
    STATE_KEY: stateKey,
    LOG_LEVEL: config.get("logLevel") ?? "info",
    SCHEDULE_FORCE_MOST_RECENT: config.get("scheduleForceMostRecent") ?? "false",
    PERSIST_FORCED_STATE: config.get("persistForcedState") ?? "true",
};
for (const [setting, variable] of Object.entries({
    maxPosts: "MAX_POSTS", dryRun: "DRY_RUN", forceMostRecent: "FORCE_MOST_RECENT",
    lastSeenOverride: "LAST_SEEN_OVERRIDE",
})) {
    const value = config.get(setting);
    if (value !== undefined) variables[variable] = value;
}
const worker = new cloudflare.WorkersScript("letterboxdWorker", {
    accountId,
    scriptName,
    mainModule: "worker.mjs",
    compatibilityDate: "2026-10-22",
    files: {
        "worker.mjs": {
            contentBase64: Buffer.from(bundle()).toString("base64"),
            contentType: "application/javascript+module",
        },
    },
    bindings: [
        { name: "STATE", type: "kv_namespace", namespaceId: namespace.id },
        { name: "DISCORD_WEBHOOK_URL", type: "secret_text", text: config.requireSecret("discordWebhookUrl") },
        ...Object.entries(variables).map(([name, text]) => ({ name, type: "plain_text", text })),
    ],
});
const trigger = new cloudflare.WorkersCronTrigger("letterboxdSchedule", {
    accountId,
    scriptName: worker.scriptName,
    schedules: [{ cron: config.get("scheduleExpression") ?? "*/30 * * * *" }],
});
export const workerName = worker.scriptName;
export const stateNamespaceId = namespace.id;
export const schedule = trigger.schedules;
