const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../../../app/core");
const Parser = require("../../../app/node_modules/rss-parser");
const load = () => import("../worker/index.mjs");
const link = n => `https://letterboxd.com/test/film/film-${n}/`;
const item = n => `<item><title>Film ${n} - ★★★½</title><link>${link(n)}</link><guid isPermaLink="false">entry-${n}</guid><pubDate>Thu, 22 Oct 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Watched on October 22, 2026.</p><img src="https://example.com/poster.jpg"> ★★★½]]></description></item>`;
const xml = `<rss version="2.0"><channel><title>Diary</title><link>https://letterboxd.com/test/</link><description>Diary</description>${item(3)}${item(2)}${item(1)}</channel></rss>`;

async function fixture(options = {}) {
  const { createWorkerHandler } = await load();
  const state = new Map(options.state || [["lastSeenId/test", link(1)]]);
  const posts = [], writes = [], waits = [];
  const env = {
    USERNAME: "test:FilmFan", DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    LOG_LEVEL: "error",
    STATE: { get: async key => state.get(key) ?? null, put: async (key, value) => { writes.push([key, value]); state.set(key, value); } },
    ...options.env,
  };
  let discordCalls = 0;
  const fetcher = async (url, init) => {
    if (url.includes("letterboxd.com")) return new Response(xml);
    discordCalls++;
    if (options.fail) return new Response("failed", { status: 500 });
    if (options.retry && discordCalls === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
    posts.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  const handler = createWorkerHandler(env, { fetcher, delay: async ms => waits.push(ms) });
  return { handler, state, posts, writes, waits, env };
}

test("Workers RSS normalization matches the Node parser's application fields", async () => {
  const { parseFeed } = await load();
  const expected = await new Parser().parseString(xml);
  for (const [i, actual] of parseFeed(xml).items.entries()) {
    for (const key of ["title", "link", "guid", "content", "isoDate"]) {
      assert.equal(actual[key], expected.items[i][key], key);
    }
  }
  assert.throws(() => parseFeed("<rss>"), /Invalid/);
  assert.throws(() => parseFeed("<html></html>"), /RSS/);
});

test("posts oldest first, preserves embeds, checkpoints, and skips unchanged entries", async () => {
  const f = await fixture({ retry: true });
  assert.equal(await f.handler(), "posted 2");
  assert.deepEqual(f.posts.map(p => p.embeds[0].url), [link(2), link(3)]);
  const embed = f.posts[0].embeds[0];
  assert.equal(embed.author.name, "test (@FilmFan)");
  assert.equal(embed.image.url, "https://example.com/poster.jpg");
  assert.match(embed.description, /Rating: ★★★½/);
  assert.equal(f.state.get("lastSeenId/test"), link(3));
  assert.equal(await f.handler(), "posted 0");
  assert.ok(f.waits.includes(2000));
  assert.ok(f.waits.every(ms => ms >= 1000));
});

test("initialization, dry run, forced replay and overrides preserve state semantics", async () => {
  const initial = await fixture({ state: [] });
  assert.equal(await initial.handler(), "initialized");
  assert.equal(initial.posts.length, 0);
  assert.equal(initial.writes.length, 1);
  const dry = await fixture({ state: [] });
  await dry.handler({ dryRun: true, forceMostRecent: true });
  assert.equal(dry.writes.length, 0);
  const forced = await fixture({ state: [] });
  await forced.handler({ forceMostRecent: true, persistForcedState: false });
  assert.equal(forced.posts.length, 1);
  assert.equal(forced.writes.length, 0);
  const replay = await fixture();
  await replay.handler({ lastSeen: link(2) });
  assert.equal(replay.posts.length, 1);
  assert.equal(replay.writes.length, 0);
});

test("maxPosts, missing checkpoints and per-account keys retain existing behavior", async () => {
  const limited = await fixture();
  await limited.handler({ maxPosts: 1 });
  assert.equal(limited.posts.length, 1);
  const reset = await fixture({ state: [["lastSeenId/test", "missing"]] });
  await reset.handler();
  assert.equal(reset.state.get("lastSeenId/test"), link(3));
  const multi = await fixture({ state: [], env: { USERNAME: "test,other" } });
  await multi.handler();
  assert.deepEqual([...multi.state.keys()], ["lastSeenId/test", "lastSeenId/other"]);
});

test("Discord failures do not advance the checkpoint", async () => {
  const f = await fixture({ fail: true });
  await assert.rejects(f.handler(), /Discord 500/);
  assert.equal(f.writes.length, 0);
});

test("shared Node and Workers logic produce identical payloads and results", async () => {
  const worker = await fixture();
  const posts = [];
  const handler = createHandler({
    env: { USERNAME: "test:FilmFan", DISCORD_WEBHOOK_URL: "test", LOG_LEVEL: "error" },
    state: { read: async () => link(1), write: async () => {} },
    readFeed: async () => new Parser().parseString(xml),
    postToDiscord: async p => posts.push(p),
    delay: async () => {},
  });
  assert.equal(await handler(), await worker.handler());
  assert.deepEqual(posts, worker.posts);
});

test("scheduled entry point forwards forced replay settings and propagates failures", async t => {
  const { default: worker } = await load();
  const f = await fixture({ state: [] });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return url.includes("letterboxd.com") ? new Response(xml) : new Response("failed", { status: 500 });
  });
  const pending = [];
  f.env.SCHEDULE_FORCE_MOST_RECENT = "true";
  await assert.rejects(worker.scheduled({}, f.env, { waitUntil: p => pending.push(p) }), /Discord 500/);
  await assert.rejects(pending[0], /Discord 500/);
  assert.equal(requests.length, 2);
  assert.equal(f.writes.length, 0);
  assert.equal(worker.fetch().status, 404);
});

test("RSS description wins over content:encoded as in the existing parser", async () => {
  const { parseFeed } = await load();
  const extended = xml.replace('<rss version="2.0">', '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">')
    .replace("</item>", "<content:encoded>Different content</content:encoded></item>");
  assert.equal(parseFeed(extended).items[0].content, (await new Parser().parseString(extended)).items[0].content);
});

test("built module runs without Node services and initializes a KV checkpoint", async t => {
  const { bundle } = require("../build.cjs");
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle()).toString("base64")}`);
  const state = new Map();
  t.mock.method(globalThis, "fetch", async url => {
    assert.match(url, /^https:\/\/letterboxd.com\/test\/rss\/$/);
    return new Response(xml);
  });
  const pending = [];
  await module.default.scheduled({}, {
    USERNAME: "test",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    LOG_LEVEL: "error",
    STATE: {
      get: async key => state.get(key) ?? null,
      put: async (key, value) => state.set(key, value),
    },
  }, { waitUntil: promise => pending.push(promise) });
  await pending[0];
  assert.equal(state.get("lastSeenId/test"), link(3));
  assert.equal(module.default.fetch().status, 404);
});
