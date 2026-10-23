const { createHandler, parseUserList } = require("./core");
// Node adapter for Lambda, Azure, GCP, and VPS deployments.
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
const STATE_FILE = process.env.STATE_FILE;
const STATE_BACKEND = (process.env.STATE_BACKEND || "auto").toLowerCase();
const AZURE_CONN_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_CONTAINER = process.env.AZURE_STATE_CONTAINER || "letterboxd-state";
const AZURE_BLOB = process.env.AZURE_STATE_BLOB || "lastSeenId";
const GCP_BUCKET = process.env.GCP_STATE_BUCKET || process.env.GCS_STATE_BUCKET;
const GCP_OBJECT = process.env.GCP_STATE_OBJECT || "lastSeenId";
const useFileState = Boolean(STATE_FILE);
const FEED_USERS = parseUserList(userEnvInput);
const MULTI_USER_MODE = FEED_USERS.length > 1;

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


exports.handler = createHandler({
  env: process.env,
  state: stateBackend,
  readFeed: url => parser.parseURL(url),
  postToDiscord,
});
