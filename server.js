const { createServer } = require("http");
const { readFile } = require("fs/promises");
const path = require("path");
const https = require("https");
const http = require("http");
const dns = require("dns/promises");
const net = require("net");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// Optional HTTP basic auth. Leave both unset for local use; set both in Cloud Run
// (or put the service behind IAP) before exposing it beyond your network.
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";

const MAX_BODY_BYTES = 1_000_000; // JSON request bodies
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const RECORDS_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;

// Only these files are ever served. Anything else 404s, which closes the
// path-traversal hole the old resolvePath() had.
const STATIC_FILES = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/style.css", "text/css; charset=utf-8"],
  ["/script.js", "application/javascript; charset=utf-8"],
]);

const BASE_URLS = [
  "https://api.sleekflow.io",
  "https://sleekflow-core-app-eus-production.azurewebsites.net",
  "https://sleekflow-core-app-seas-production.azurewebsites.net",
  "https://sleekflow-core-app-weu-production.azurewebsites.net",
  "https://sleekflow-core-app-uaen-production.azurewebsites.net",
];

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

let pinnedBaseUrl = null;
// API keys are region-scoped: a key that works on SEAS 401s on the global host.
// Pin per key so each account lands on its home base and stays there.
const basePinsByKey = new Map();

createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // Health check stays open so Cloud Run probes work without credentials.
  if (pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Custom Object Extractor", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Authentication required\n");
    return;
  }

  try {
    if (pathname === "/api/records" && req.method === "POST") {
      return await handleRecords(req, res);
    }
    if (pathname === "/api/schema" && req.method === "POST") {
      return await handleSchema(req, res);
    }
    if (pathname === "/api/contact" && req.method === "POST") {
      return await handleContact(req, res);
    }
    if (pathname === "/api/contact/list" && req.method === "POST") {
      return await handleContactList(req, res);
    }
    if (pathname === "/proxy-image" && req.method === "GET") {
      return await handleProxyImage(req, res, url);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return await handleStatic(req, res, pathname);
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      return sendJson(res, err.status || 500, {
        error: err.status === 413 ? "Request body too large" : "Internal server error",
      });
    }
    res.end();
  }
}).listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

/* ------------------------------------------------------------------ routes */

async function handleRecords(req, res) {
  const { apiKey, objectKey, continuationToken = "" } = await readJsonBody(req);
  if (!apiKey || !objectKey) {
    return sendJson(res, 400, { error: "apiKey and objectKey are required" });
  }

  // The upstream expects GET with a JSON body; the continuation token is only
  // honoured there (passing it as a query param silently returns page 1).
  const upstream = await callApi({
    method: "GET",
    apiPath: `/api/customObjects/${encodeURIComponent(objectKey)}/records?limit=1000`,
    apiKey,
    body: { continuationToken: continuationToken || "" },
    timeoutMs: RECORDS_TIMEOUT_MS,
  });

  return sendUpstream(res, upstream);
}

async function handleSchema(req, res) {
  const { apiKey, objectKey } = await readJsonBody(req);
  if (!apiKey || !objectKey) {
    return sendJson(res, 400, { error: "apiKey and objectKey are required" });
  }

  const upstream = await callApi({
    method: "GET",
    apiPath: `/api/customObjects/${encodeURIComponent(objectKey)}`,
    apiKey,
  });

  return sendUpstream(res, upstream);
}

async function handleContact(req, res) {
  const { apiKey, userProfileId } = await readJsonBody(req);
  if (!apiKey || !userProfileId) {
    return sendJson(res, 400, {
      error: "apiKey and userProfileId are required",
    });
  }

  const upstream = await callApi({
    method: "GET",
    apiPath: `/api/contact/${encodeURIComponent(userProfileId)}`,
    apiKey,
  });

  return sendUpstream(res, upstream);
}

async function handleContactList(req, res) {
  const { apiKey, groupListName, userProfileIds } = await readJsonBody(req);
  if (!apiKey || !groupListName || !Array.isArray(userProfileIds)) {
    return sendJson(res, 400, {
      error: "apiKey, groupListName, and userProfileIds are required",
    });
  }

  const upstream = await callApi({
    method: "POST",
    apiPath: "/api/contact/list",
    apiKey,
    body: { groupListName, userProfileIds },
  });

  return sendUpstream(res, upstream);
}

async function handleStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Invalid path" });
  }

  const filePath = decoded === "/" ? "/index.html" : decoded;
  const contentType = STATIC_FILES.get(filePath);
  if (!contentType) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const fullPath = path.join(__dirname, filePath);
  // Defensive: STATIC_FILES is an allowlist, so this should always hold.
  if (!fullPath.startsWith(__dirname + path.sep)) {
    return sendJson(res, 404, { error: "Not found" });
  }

  try {
    const data = await readFile(fullPath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

/* ------------------------------------------------------------- image proxy */

async function handleProxyImage(req, res, requestUrl) {
  const raw = requestUrl.searchParams.get("url");
  if (!raw) return sendJson(res, 400, { error: "Missing url parameter" });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return sendJson(res, 400, { error: "Invalid url parameter" });
  }

  let upstream;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!["http:", "https:"].includes(target.protocol)) {
      return sendJson(res, 400, { error: "URL must use http or https" });
    }

    const blocked = await assertPublicHost(target);
    if (blocked) return sendJson(res, 400, { error: blocked });

    try {
      upstream = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        headers: { "User-Agent": "custom-object-extractor/1.0" },
      });
    } catch (err) {
      return sendJson(res, 502, { error: `File fetch failed: ${err.message}` });
    }

    if (![301, 302, 303, 307, 308].includes(upstream.status)) break;

    const location = upstream.headers.get("location");
    if (!location) {
      return sendJson(res, 502, { error: "Upstream redirect without location" });
    }
    target = new URL(location, target);
    if (hop === MAX_REDIRECTS) {
      return sendJson(res, 502, { error: "Too many redirects" });
    }
  }

  if (upstream.status < 200 || upstream.status >= 300) {
    return sendJson(res, 502, {
      error: `File fetch failed (${upstream.status})`,
    });
  }

  // Never let active content (HTML/SVG) run on this origin; the client only
  // ever consumes these as blobs, so force a download.
  const upstreamType = (upstream.headers.get("content-type") || "").toLowerCase();
  if (
    upstreamType.includes("text/html") ||
    upstreamType.includes("application/xhtml") ||
    upstreamType.includes("image/svg")
  ) {
    return sendJson(res, 415, { error: "Unsupported content type" });
  }

  const declared = Number(upstream.headers.get("content-length") || 0);
  if (declared && declared > MAX_IMAGE_BYTES) {
    return sendJson(res, 413, { error: "File is too large" });
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of upstream.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        return sendJson(res, 413, { error: "File is too large" });
      }
      chunks.push(chunk);
    }
  } catch (err) {
    return sendJson(res, 502, { error: `File fetch failed: ${err.message}` });
  }

  const filename = path.basename(target.pathname) || "file";
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": size,
    "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.\-]+/g, "_")}"`,
  });
  res.end(Buffer.concat(chunks));
}

// Returns an error string when the target resolves to a private/loopback/
// link-local address (cloud metadata, internal services) or does not resolve.
async function assertPublicHost(target) {
  const host = target.hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(host)) {
    return isPrivateIp(host) ? "URL resolves to a private address" : null;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return "URL host could not be resolved";
  }

  if (!addresses.length) return "URL host could not be resolved";
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    return "URL resolves to a private address";
  }
  return null;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) {
    return true;
  }
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return false;
}

/* ----------------------------------------------------------------- helpers */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendUpstream(res, upstream) {
  res.writeHead(upstream.status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(upstream.body || "{}");
}

function isAuthorized(req) {
  if (!AUTH_USER) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return false;

  return (
    safeEqual(decoded.slice(0, separator), AUTH_USER) &&
    safeEqual(decoded.slice(separator + 1), AUTH_PASS)
  );
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large"), { status: 413 });
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Calls a SleekFlow endpoint, failing over between base URLs.
 * - 2xx: success, pins the base.
 * - 400/404/429: returned as-is (request-level, same on every base).
 * - 401/403/5xx/network: try the next base.
 */
async function callApi({ method, apiPath, apiKey, body, timeoutMs }) {
  const attempts = [];
  const pinKey = keyFingerprint(apiKey);
  const pinned = basePinsByKey.get(pinKey) || pinnedBaseUrl;
  const bases = pinned
    ? [pinned, ...BASE_URLS.filter((base) => base !== pinned)]
    : BASE_URLS;

  let authFailure = null;

  for (const base of bases) {
    const url = `${base.replace(/\/+$/, "")}${apiPath}`;

    try {
      const response = await rawRequest(
        url,
        {
          method,
          headers: {
            Accept: "application/json",
            "X-Sleekflow-Api-Key": apiKey,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body,
        },
        timeoutMs || UPSTREAM_TIMEOUT_MS,
      );

      const status = response.status;

      if (status >= 200 && status < 300) {
        basePinsByKey.set(pinKey, base);
        pinnedBaseUrl = base;
        return response;
      }

      // Request-level failures are identical on every base: surface them
      // instead of burning the failover chain.
      if ([400, 404, 413, 429].includes(status)) {
        return response;
      }

      // 401/403 usually means "this key belongs to another region", so keep
      // trying bases. If every base rejects the key, it really is a bad key.
      if (status === 401 || status === 403) {
        authFailure = response;
        attempts.push({ base, status });
        continue;
      }

      attempts.push({ base, status, body: response.body.slice(0, 300) });
    } catch (err) {
      attempts.push({ base, error: err.message });
    }
  }

  if (authFailure) return authFailure;

  return {
    status: 502,
    body: JSON.stringify({ error: "All base URLs failed", attempts }),
  };
}

function keyFingerprint(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 16);
}

function rawRequest(urlString, { method, headers, body }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;
    const payload =
      body === undefined
        ? null
        : typeof body === "string"
          ? body
          : JSON.stringify(body);

    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (upstreamRes) => {
        const chunks = [];
        let size = 0;

        upstreamRes.on("data", (chunk) => {
          size += chunk.length;
          if (size > 50 * 1024 * 1024) {
            req.destroy(new Error("Upstream response too large"));
            return;
          }
          chunks.push(chunk);
        });

        upstreamRes.on("end", () => {
          resolve({
            status: upstreamRes.statusCode || 500,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Upstream timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);

    if (payload) req.write(payload);
    req.end();
  });
}
