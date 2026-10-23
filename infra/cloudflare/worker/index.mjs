import { XMLParser, XMLValidator } from "fast-xml-parser";
import core from "../../../app/core.js";

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

export function parseFeed(xml) {
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid RSS XML");
  const channel = parser.parse(xml)?.rss?.channel;
  if (!channel) throw new Error("Expected an RSS channel");
  const raw = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
  return { items: raw.map(item => {
    const date = item.pubDate ? new Date(item.pubDate) : null;
    return {
      title: item.title,
      link: item.link,
      guid: typeof item.guid === "object" ? item.guid["#text"] : item.guid,
      content: item.description || "",
      isoDate: date && !Number.isNaN(date.valueOf()) ? date.toISOString() : undefined,
    };
  }) };
}

export function createWorkerHandler(env, { fetcher = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!env.STATE) throw new Error("Missing STATE KV namespace binding");
  const key = user => (env.STATE_KEY || "lastSeenId/{user}").replace(/\{user\}/g, user.stateKey);
  if (env.STATE_KEY && !env.STATE_KEY.includes("{user}")) {
    throw new Error("STATE_KEY must include {user} to isolate account checkpoints");
  }
  return core.createHandler({
    env,
    // KV permits one write per second to a key; pace multi-post backfills accordingly.
    delay: ms => delay(Math.max(ms, 1100)),
    state: {
      read: user => env.STATE.get(key(user)),
      write: (user, value) => env.STATE.put(key(user), value),
    },
    readFeed: async url => {
      const response = await fetcher(url, {
        headers: { Accept: "application/rss+xml", "User-Agent": "rss-parser" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Letterboxd HTTP ${response.status}`);
      return parseFeed(await response.text());
    },
    postToDiscord: async payload => {
      for (;;) {
        const response = await fetcher(env.DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after") || 2);
          await response.text();
          await delay((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000);
          continue;
        }
        if (!response.ok) throw new Error(`Discord ${response.status}: ${await response.text()}`);
        await response.text();
        return;
      }
    },
  });
}

export default {
  async scheduled(controller, env, ctx) {
    const result = createWorkerHandler(env)({
      source: "cloudflare.scheduler",
    });
    ctx.waitUntil(result);
    await result;
  },
  // Scheduling is the only production entry point; no public replay endpoint.
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
