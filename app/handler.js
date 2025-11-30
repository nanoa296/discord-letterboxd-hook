// handler.js — Lambda that relays Letterboxd diary entries to Discord
const Parser = require("rss-parser");
const https = require("https");
const fs = require("fs/promises");
const path = require("path");
const { SSMClient, GetParameterCommand, PutParameterCommand } = require("@aws-sdk/client-ssm");

let BlobServiceClient;
let GcpStorage;

const parser = new Parser({ timeout: 15000 });
let ssm;

const userEnvInput =
  process.env.USERNAME ||
  process.env.LETTERBOXD_USERNAME ||
  process.env.LETTERBOXD_USERNAMES ||
  "";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PARAM_NAME = process.env.PARAM_NAME || "/letterboxd/lastSeenId";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const SCHEDULE_FORCE_MOST_RECENT = toBool(process.env.SCHEDULE_FORCE_MOST_RECENT);
const STATE_FILE = process.env.STATE_FILE;
const STATE_BACKEND = (process.env.STATE_BACKEND || "auto").toLowerCase();
const AZURE_CONN_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_CONTAINER = process.env.AZURE_STATE_CONTAINER || "letterboxd-state";
const AZURE_BLOB = process.env.AZURE_STATE_BLOB || "lastSeenId";
const GCP_BUCKET = process.env.GCP_STATE_BUCKET || process.env.GCS_STATE_BUCKET;
const GCP_OBJECT = process.env.GCP_STATE_OBJECT || "lastSeenId";
const useFileState = Boolean(STATE_FILE);
const DEFAULT_PERSIST_FORCED_STATE = process.env.PERSIST_FORCED_STATE === undefined
  ? true
  : toBool(process.env.PERSIST_FORCED_STATE);
const FEED_USERS = parseUserList(userEnvInput);
const MULTI_USER_MODE = FEED_USERS.length > 1;

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

async function ssmGet(name) {
  const client = ensureSsm();
  try {
    const r = await client.send(new GetParameterCommand({ Name: name }));
    return r?.Parameter?.Value || null;
  } catch {
    return null;
  }
}

async function ssmPut(name, value) {
  const client = ensureSsm();
  await client.send(new PutParameterCommand({
    Name: name,
    Value: value,
    Overwrite: true,
    Type: "String",
  }));
}

function ensureSsm() {
  if (!ssm) {
    ssm = new SSMClient();
  }
  return ssm;
}
const stateBackend = resolveStateBackend();

async function readState(user) {
  return stateBackend.read(user);
}

async function writeState(user, value) {
  await stateBackend.write(user, value);
}

function resolveStateBackend() {
  const map = {
    "aws-ssm": createSsmBackend,
    aws: createSsmBackend,
    ssm: createSsmBackend,
    file: createFileBackend,
    "azure-blob": createAzureBlobBackend,
    azure: createAzureBlobBackend,
    "gcp-storage": createGcpStorageBackend,
    gcp: createGcpStorageBackend,
  };

  if (STATE_BACKEND && STATE_BACKEND !== "auto") {
    const factory = map[STATE_BACKEND];
    if (!factory) throw new Error(`Unsupported STATE_BACKEND: ${STATE_BACKEND}`);
    return factory();
  }

  if (useFileState) return createFileBackend();
  if (AZURE_CONN_STRING) return createAzureBlobBackend();
  if (GCP_BUCKET) return createGcpStorageBackend();
  return createSsmBackend();
}

function createFileBackend() {
  async function readRaw() {
    if (!STATE_FILE) return null;
    try {
      const data = await fs.readFile(STATE_FILE, "utf8");
      return data;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function shouldNamespace(user) {
    return MULTI_USER_MODE && !!user;
  }

  return {
    async read(user) {
      const data = await readRaw();
      if (!data) return null;
      const trimmed = data.trim();
      if (!trimmed) return null;
      if (!shouldNamespace(user)) return trimmed;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed[user.stateKey] || null;
        }
      } catch {
        // legacy single-user state stored as plain text
      }
      return trimmed;
    },
    async write(user, value) {
      if (!value || !STATE_FILE) return;
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      if (!shouldNamespace(user)) {
        await fs.writeFile(STATE_FILE, value, "utf8");
        return;
      }
      let map = {};
      const data = await readRaw();
      if (data) {
        try {
          const parsed = JSON.parse(data.trim());
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            map = parsed;
          }
        } catch {
          map = {};
        }
      }
      map[user.stateKey] = value;
      await fs.writeFile(STATE_FILE, JSON.stringify(map), "utf8");
    },
  };
}

function createSsmBackend() {
  return {
    read: (user) => ssmGet(resolveParamName(user)),
    write: async (user, value) => {
      if (!value) return;
      await ssmPut(resolveParamName(user), value);
    },
  };
}

function resolveParamName(user) {
  if (!user) return PARAM_NAME;
  if (PARAM_NAME.includes("{user}")) {
    return PARAM_NAME.replace(/\{user\}/g, user.username);
  }
  if (!MULTI_USER_MODE) return PARAM_NAME;
  const suffix = PARAM_NAME.endsWith("/") ? "" : "/";
  return `${PARAM_NAME}${suffix}${user.stateKey}`;
}

function ensureAzureClient() {
  if (!AZURE_CONN_STRING)
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required for azure blob state");
  if (!BlobServiceClient) {
    try {
      BlobServiceClient = require("@azure/storage-blob").BlobServiceClient;
    } catch (err) {
      throw new Error("@azure/storage-blob dependency missing. Install it to use azure state backend.");
    }
  }
  return BlobServiceClient.fromConnectionString(AZURE_CONN_STRING);
}

function createAzureBlobBackend() {
  const client = () => ensureAzureClient();
  return {
    async read(user) {
      const service = client();
      const container = service.getContainerClient(AZURE_CONTAINER);
      const blob = container.getBlobClient(resolveAzureBlobName(user));
      try {
        const exists = await blob.exists();
        if (!exists) return null;
        const buffer = await blob.downloadToBuffer();
        const text = buffer.toString("utf8").trim();
        return text || null;
      } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
      }
    },
    async write(user, value) {
      if (!value) return;
      const service = client();
      const container = service.getContainerClient(AZURE_CONTAINER);
      await container.createIfNotExists();
      const blockBlob = container.getBlockBlobClient(resolveAzureBlobName(user));
      await blockBlob.upload(value, Buffer.byteLength(value), {
        blobHTTPHeaders: { blobContentType: "text/plain" },
      });
    },
  };
}

function resolveAzureBlobName(user) {
  if (!user) return AZURE_BLOB;
  if (AZURE_BLOB.includes("{user}")) {
    return AZURE_BLOB.replace(/\{user\}/g, user.username);
  }
  if (!MULTI_USER_MODE) return AZURE_BLOB;
  return `${AZURE_BLOB}-${user.stateKey}`;
}

function ensureGcpClient() {
  if (!GCP_BUCKET)
    throw new Error("GCP_STATE_BUCKET (or GCS_STATE_BUCKET) is required for GCP storage state");
  if (!GcpStorage) {
    try {
      GcpStorage = require("@google-cloud/storage").Storage;
    } catch (err) {
      throw new Error("@google-cloud/storage dependency missing. Install it to use GCP state backend.");
    }
  }
  return new GcpStorage();
}

function createGcpStorageBackend() {
  const storage = () => ensureGcpClient();
  return {
    async read(user) {
      const client = storage();
      const bucket = client.bucket(GCP_BUCKET);
      const file = bucket.file(resolveGcpObjectName(user));
      try {
        const [exists] = await file.exists();
        if (!exists) return null;
        const [data] = await file.download();
        const text = data.toString("utf8").trim();
        return text || null;
      } catch (err) {
        if (err.code === 404) return null;
        throw err;
      }
    },
    async write(user, value) {
      if (!value) return;
      const client = storage();
      const bucket = client.bucket(GCP_BUCKET);
      const file = bucket.file(resolveGcpObjectName(user));
      await file.save(value, { contentType: "text/plain" });
    },
  };
}

function resolveGcpObjectName(user) {
  if (!user) return GCP_OBJECT;
  if (GCP_OBJECT.includes("{user}")) {
    return GCP_OBJECT.replace(/\{user\}/g, user.username);
  }
  if (!MULTI_USER_MODE) return GCP_OBJECT;
  return `${GCP_OBJECT}-${user.stateKey}`;
}

function postToDiscord(payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const url = new URL(WEBHOOK);
    const opts = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode === 429) {
        res.resume();
        const retryAfter = Number(res.headers["retry-after"] || 2);
        setTimeout(() => postToDiscord(payload).then(resolve).catch(reject), retryAfter * 1000);
        return;
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        res.resume();
        resolve();
      } else {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => reject(new Error(`Discord ${res.statusCode}: ${body}`)));
      }
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async (event = {}) => {
  if (!WEBHOOK || !FEED_USERS.length)
    throw new Error("Missing DISCORD_WEBHOOK_URL or USERNAME/LETTERBOXD_USERNAME");

  const baseOptions = {
    dryRun: toBool(event.dryRun ?? process.env.DRY_RUN),
    forceMostRecent: toBool(event.forceMostRecent ?? process.env.FORCE_MOST_RECENT ?? (event.source === "aws.scheduler" && SCHEDULE_FORCE_MOST_RECENT)),
    maxPosts: Number(event.maxPosts ?? process.env.MAX_POSTS) || undefined,
    overrideLastSeen: event.lastSeen ?? process.env.LAST_SEEN_OVERRIDE ?? null,
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
  const feed = await parser.parseURL(feedUrl);
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
    if (newest) await writeState(user, newest.id);
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
