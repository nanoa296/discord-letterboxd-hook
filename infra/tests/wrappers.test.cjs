const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'letterboxd deployment '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('packaged Azure timer resolves the shared handler and propagates failures', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'TimerTrigger'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.copyFileSync(path.resolve(__dirname, '../azure/functionapp/TimerTrigger/index.js'), path.join(root, 'TimerTrigger/index.js'));
  fs.writeFileSync(path.join(root, 'app/handler.js'), `exports.handler = async event => {
    if (event.source !== 'azure.timer') throw new Error('wrong source');
    return 'posted 0';
  };`);
  const timer = require(path.join(root, 'TimerTrigger/index.js'));
  const messages = [];
  const log = (...values) => messages.push(values);
  log.error = value => messages.push(value);
  await timer({ log }, {});
  assert.deepEqual(messages, [['[letterboxd]', 'posted 0']]);
  require(path.join(root, 'app/handler.js')).handler = async () => { throw new Error('unavailable'); };
  delete require.cache[require.resolve(path.join(root, 'TimerTrigger/index.js'))];
  const failingTimer = require(path.join(root, 'TimerTrigger/index.js'));
  await assert.rejects(failingTimer({ log }, {}), /unavailable/);
});

test('VPS runner finds repository and env file from an unrelated working directory', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'infra/vps/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'bin'));
  const runner = path.join(root, 'infra/vps/scripts/run-letterboxd.sh');
  fs.copyFileSync(path.resolve(__dirname, '../vps/scripts/run-letterboxd.sh'), runner);
  fs.writeFileSync(path.join(root, 'infra/vps/.env'), 'USERNAME=test-user\nDISCORD_WEBHOOK_URL=https://example.invalid/webhook\n');
  fs.writeFileSync(path.join(root, 'bin/node'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$USERNAME" "$STATE_FILE"\n', { mode: 0o755 });
  const result = spawnSync('bash', [runner], {
    cwd: os.tmpdir(), encoding: 'utf8',
    env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [path.join(root, 'app'), 'test-user', path.join(root, 'app/.lastSeen')]);
});

test('GCP HTTP wrapper invokes the shared handler and returns success or failure', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'app'));
  fs.copyFileSync(path.resolve(__dirname, '../gcp/function/index.js'), path.join(root, 'index.js'));
  fs.writeFileSync(path.join(root, 'app/handler.js'), `exports.handler = async event => {
    if (event.fail) throw new Error('test failure');
    if (event.source !== 'gcp.scheduler') throw new Error('wrong source');
    return 'posted 0';
  };`);
  const { letterboxd } = require(path.join(root, 'index.js'));
  const response = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
  await letterboxd({ body: {} }, response);
  assert.equal(response.code, 200);
  assert.equal(response.body, 'posted 0');
  const errorLog = t.mock.method(console, "error", () => {});
  await letterboxd({ body: { fail: true } }, response);
  assert.equal(response.code, 500);
  assert.equal(response.body, 'test failure');
  assert.equal(errorLog.mock.calls.length, 1);
});
