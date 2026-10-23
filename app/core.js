// Shared application logic; runtime services are supplied by deployment adapters.
function parseUserList(rawInput = "") {
  if (!rawInput) return [];
  if (/[\r\n]/.test(rawInput)) {
    throw new Error("USERNAME must be a comma-separated list (no newlines)");
  }
  const parts = rawInput
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const list = [];
  for (const part of parts) {
    const { letterboxd, discordTag } = splitDiscordTag(part);
    const withoutAt = letterboxd.replace(/^@+/, "");
    if (!withoutAt) continue;
    const canonical = withoutAt.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    list.push({
      username: withoutAt,
      canonical,
      stateKey: buildStateKey(withoutAt),
      discordTag,
    });
  }
  return list;
}

function splitDiscordTag(part = "") {
  const colonIndex = part.indexOf(":");
  if (colonIndex === -1) {
    return { letterboxd: part, discordTag: undefined };
  }
  const letterboxd = part.slice(0, colonIndex).trim();
  const discordRaw = part.slice(colonIndex + 1);
  const discordTag = discordRaw && discordRaw.trim() ? discordRaw.trim() : undefined;
  return { letterboxd, discordTag };
}

function formatDiscordMention(tag) {
  if (!tag) return "";
  const trimmed = tag.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<@") || trimmed.startsWith("@")) return trimmed;
  return `@${trimmed}`;
}

function buildStateKey(username) {
  const normalized = username
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]/g, "-");
  return normalized || "default";
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

exports.parseUserList = parseUserList;
exports.createHandler = function createHandler({ env, state, readFeed, postToDiscord, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const userEnvInput =
    env.USERNAME ||
    env.LETTERBOXD_USERNAME ||
    env.LETTERBOXD_USERNAMES ||
    "";
  const WEBHOOK = env.DISCORD_WEBHOOK_URL;
  const LOG_LEVEL = (env.LOG_LEVEL || "info").toLowerCase();
  const SCHEDULE_FORCE_MOST_RECENT = toBool(env.SCHEDULE_FORCE_MOST_RECENT);
  const DEFAULT_PERSIST_FORCED_STATE = env.PERSIST_FORCED_STATE === undefined
    ? true
    : toBool(env.PERSIST_FORCED_STATE);
  const FEED_USERS = parseUserList(userEnvInput);

  const readState = user => state.read(user);
  const writeState = (user, value) => state.write(user, value);
  function extractRating(text = "") {
    const stars = (text.match(/★/g) || []).length;
    const half = /½/.test(text) ? 0.5 : 0;
    return stars + half || null;
  }

  function extractPosterFromContent(html = "") {
    const match = html.match(/<img[^>]+src="([^"]+)"/i);
    return match ? match[1] : null;
  }

  function formatWatchedDate(isoDate) {
    const d = isoDate ? new Date(isoDate) : new Date();
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function isDiaryish(entry = {}) {
    const link = entry.link || "";
    const body = entry.content || entry.contentSnippet || "";
    if (/letterboxd\.com\/film\//i.test(link)) return true;
    if (/★|½/.test(body)) return true;
    if (/Watched on/i.test(body)) return true;
    return false;
  }

  function extractWatchedOn(html = "") {
    const m = html.match(/Watched on ([^<]+)/i);
    if (!m) return "";
    const normalized = m[1]
      .trim()
      .replace(/[.!?\s]+$/, "");
    return `Watched on ${normalized}.`;
  }

  const logStream = [];
  function log(level, ...args) {
    const order = ["debug", "info", "warn", "error"];
    if (order.indexOf(level) < order.indexOf(LOG_LEVEL)) return;
    const fn = level === "info" || level === "debug" ? "log" : level;
    const entry = { level, args };
    logStream.push(entry);
    console[fn]("[letterboxd]", ...args);
  }

  function flushLogs() {
    if (!logStream.length) return;
    console.log("[letterboxd]", "log summary", logStream.length, "entries");
  }

  function toDiscordPayload(entry, user) {
    const title = (entry.title || "").replace(/\s+-\s+★.*$/, "").trim() || "New diary entry";
    const url = entry.link;
    const watchedLine = extractWatchedOn(entry.content || entry.contentSnippet || "") ||
      `Watched on ${formatWatchedDate(entry.isoDate)}.`;
    const rating = extractRating(entry.content || entry.contentSnippet || "");
    const poster = extractPosterFromContent(entry.content || "");
    const descriptionParts = [watchedLine];
    if (rating) descriptionParts.push(`Rating: ${"★".repeat(Math.floor(rating))}${rating % 1 ? "½" : ""}`);
    const description = descriptionParts.join("\n");
    const profileName = user?.username || user?.canonical || "letterboxd";
    const profileSlug = user?.canonical || profileName.toLowerCase();
    const discordLabel = formatDiscordMention(user?.discordTag);
    const authorLabel = discordLabel ? `${profileName} (${discordLabel})` : profileName;

    const embed = {
      title,
      url,
      description,
      timestamp: entry.isoDate || new Date().toISOString(),
      author: {
        name: authorLabel,
        url: `https://letterboxd.com/${profileSlug}/`,
      },
      footer: {
        text: `${profileName} | letterboxd.com`,
      },
    };

    if (poster) embed.image = { url: poster };

    return {
      content: "",
      embeds: [embed],
    };
  }

  function normalizeId(entry = {}) {
    const link = entry.link || entry.guid || entry.isoDate || entry.title || String(Date.now());
    return link.toLowerCase();
  }

  function orderFeedItems(feedItems = []) {
    return [...feedItems]
      .filter(Boolean)
      .map((it) => ({ it, id: normalizeId(it) }))
      .filter((x) => x.id)
      .reverse(); // oldest -> newest
  }

  const handler = async (event = {}) => {
    logStream.length = 0;
    if (!WEBHOOK || !FEED_USERS.length)
      throw new Error("Missing DISCORD_WEBHOOK_URL or USERNAME/LETTERBOXD_USERNAME");

    const baseOptions = {
      dryRun: toBool(event.dryRun ?? env.DRY_RUN),
      forceMostRecent: toBool(event.forceMostRecent ?? env.FORCE_MOST_RECENT ?? (["aws.scheduler", "cloudflare.scheduler"].includes(event.source) && SCHEDULE_FORCE_MOST_RECENT)),
      maxPosts: Number(event.maxPosts ?? env.MAX_POSTS) || undefined,
      overrideLastSeen: event.lastSeen ?? env.LAST_SEEN_OVERRIDE ?? null,
      persistForcedState: toBool(event.persistForcedState ?? DEFAULT_PERSIST_FORCED_STATE),
    };

    const perUser = [];
    for (const user of FEED_USERS) {
      const result = await processFeedForUser(user, baseOptions);
      perUser.push({ user, result });
    }

    const summary = perUser.length === 1
      ? perUser[0].result
      : perUser.map(({ user, result }) => `${user.username}:${result}`).join(", ");
    flushLogs();
    return summary;
  };

  async function processFeedForUser(user, baseOptions) {
    const options = { ...baseOptions };
    const feedUrl = `https://letterboxd.com/${user.canonical}/rss/`;
    const feed = await readFeed(feedUrl);
    if (!feed?.items?.length) return "no items";

    const ordered = orderFeedItems(feed.items);
    if (!ordered.length) return "no items";

    const storedLastIdRaw = await readState(user);
    const storedLastId = storedLastIdRaw && storedLastIdRaw.trim() ? storedLastIdRaw.trim() : null;
    const normalizedStoredId = storedLastId ? storedLastId.toLowerCase() : null;
    let logicalLastId = options.overrideLastSeen || normalizedStoredId || null;
    log("info", `[${user.username}] storedLastId`, storedLastId, "override", options.overrideLastSeen);

    if (!storedLastId && !options.overrideLastSeen) {
      const newest = ordered[ordered.length - 1];
      if (newest && !options.forceMostRecent && !options.dryRun && !options.overrideLastSeen) await writeState(user, newest.id);
      if (!options.forceMostRecent) return "initialized";
      logicalLastId = newest?.id || null;
    }

    let checkpointReset = false;
    let candidates = [];
    const descending = [...feed.items]; // newest -> oldest
    const normalizedDescending = descending.map((it) => ({ it, id: normalizeId(it) }));
    for (const entry of normalizedDescending) {
      if (logicalLastId && entry.id === logicalLastId) break;
      const diaryish = isDiaryish(entry.it);
      log("debug", `[${user.username}] descending consider`, entry.id, { diaryish });
      if (diaryish) candidates.push(entry);
    }
    let encounteredLast = normalizedDescending.some((entry) => logicalLastId && entry.id === logicalLastId);
    const missingCheckpoint = logicalLastId && !encounteredLast;
    if (missingCheckpoint && storedLastId && !options.overrideLastSeen) {
      checkpointReset = true;
      options.forceMostRecent = true;
      log("warn", `[${user.username}] stored lastSeen not found in feed; will reset using newest entry`, storedLastId);
    }

    log("info", `[${user.username}] candidateCount`, candidates.length, "reset", checkpointReset, "stored", storedLastId, "encountered", encounteredLast);

    if ((options.forceMostRecent || checkpointReset) && !candidates.length) {
      const fallbackDiary = normalizedDescending.find((x) => isDiaryish(x.it));
      const fallbackAny = fallbackDiary || normalizedDescending[0];
      if (fallbackAny) {
        const reason = checkpointReset ? "reset" : fallbackDiary ? "diary" : "any";
        candidates = [{ ...fallbackAny, forced: true, reason }];
      }
      log("info", `[${user.username}] forceMostRecent triggered`, candidates[0]?.reason);
    }

    if (options.maxPosts && candidates.length > options.maxPosts) {
      candidates = candidates.slice(0, options.maxPosts);
    }
    candidates = candidates.reverse();

    let processed = 0;
    const persistState = !options.overrideLastSeen && !options.dryRun;
    const forcedFlag = candidates.some((c) => c.forced);

    for (const candidate of candidates) {
      const payload = toDiscordPayload(candidate.it, user);
      log("info", `[${user.username}] posting ${candidate.id}`, { forced: !!candidate.forced, diary: isDiaryish(candidate.it) });
      if (options.dryRun) {
        console.log(`[dryRun] Would post ${candidate.id}: ${payload.content}`);
      } else {
        await postToDiscord(payload);
        const forcedShouldPersist = candidate.reason === "reset" || options.persistForcedState;
        const shouldPersist = persistState && (!candidate.forced || forcedShouldPersist);
        if (shouldPersist) {
          await writeState(user, candidate.id);
        }
        await delay(800);
      }
      processed += 1;
    }

    if (!processed) {
      log("warn", `[${user.username}] no candidates posted`, { forceMostRecent: options.forceMostRecent || checkpointReset });
      return (options.forceMostRecent || checkpointReset) ? "forced 0" : "posted 0";
    }

    const prefix = options.dryRun ? "dryRun" : "posted";
    const forcedDetails = forcedFlag && candidates[0]?.reason === "any" ? " (forced any)" : forcedFlag ? " (forced)" : "";
    return `${prefix} ${processed}${forcedDetails}`;
  }

  return handler;
};
