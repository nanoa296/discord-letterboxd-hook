const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadStack } = require("../../tests/pulumi-mocks.cjs");

test("Cloudflare deploys a bundled module with isolated KV, secret webhook, and UTC cron", async () => {
  await loadStack(path.resolve(__dirname, ".."), "pulumi-cloudflare.ts", {
    "test-project:accountId": "account-id",
    "test-project:username": "alice,bob",
    "test-project:discordWebhookUrl": "https://discord.invalid/secret",
  }, () => ({}), async resources => {
    const kv = resources.find(r => r.type === "cloudflare:index/workersKvNamespace:WorkersKvNamespace");
    const worker = resources.find(r => r.type === "cloudflare:index/workersScript:WorkersScript");
    const cron = resources.find(r => r.type === "cloudflare:index/workersCronTrigger:WorkersCronTrigger");
    assert.ok(kv);
    assert.ok(worker);
    assert.ok(cron);
    assert.equal(worker.inputs.mainModule, "worker.mjs");
    const bindings = worker.inputs.bindings;
    assert.equal(bindings.find(b => b.name === "STATE").namespaceId, `${kv.name}-id`);
    assert.equal(bindings.find(b => b.name === "DISCORD_WEBHOOK_URL").type, "secret_text");
    assert.equal(bindings.find(b => b.name === "USERNAME").text, "alice,bob");
    assert.equal(bindings.find(b => b.name === "STATE_KEY").text, "lastSeenId/{user}");
    const source = Buffer.from(worker.inputs.files["worker.mjs"].contentBase64, "base64").toString();
    assert.match(source, /scheduled/);
    assert.doesNotMatch(source, /@aws-sdk|@azure\/storage|@google-cloud\/storage|require\(["']https/);
    assert.equal(cron.inputs.scriptName, worker.inputs.scriptName);
    assert.deepEqual(cron.inputs.schedules, [{ cron: "*/30 * * * *" }]);
  });
});
