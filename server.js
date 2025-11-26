const { createServer } = require("http");
const { readFile, stat } = require("fs/promises");
const path = require("path");
const PORT = process.env.PORT || 3000;

const BASE_URLS = [
  "https://api.sleekflow.io",
  "https://sleekflow-core-app-eus-production.azurewebsites.net",
  "https://sleekflow-core-app-seas-production.azurewebsites.net",
  "https://sleekflow-core-app-weu-production.azurewebsites.net",
  "https://sleekflow-core-app-uaen-production.azurewebsites.net"
];

let pinnedBaseUrl = null;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

createServer(async (req, res) => {
  // Basic CORS to allow local dev from same origin/file.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/api/records" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { apiKey, objectKey, continuationToken = "" } = body || {};

      if (!apiKey || !objectKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "apiKey and objectKey are required" }));
        return;
      }

      const upstreamResponse = await fetchViaAvailableBase({
        apiKey,
        objectKey,
        continuationToken
      });

      res.writeHead(upstreamResponse.status, { "Content-Type": "application/json" });
      res.end(upstreamResponse.body || "{}");
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  // Serve static assets (index.html, style.css, script.js)
  if (req.method === "GET") {
    const resolvedPath = resolvePath(req.url);
    try {
      const fileStat = await stat(resolvedPath);
      if (fileStat.isFile()) {
        const data = await readFile(resolvedPath);
        const ext = path.extname(resolvedPath);
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
        res.end(data);
        return;
      }
    } catch {
      // fall through to 404
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}).listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolvePath(urlPath = "/") {
  let filePath = urlPath.split("?")[0];
  if (filePath === "/") filePath = "/index.html";
  const fullPath = path.join(__dirname, filePath);
  return fullPath;
}

async function fetchViaAvailableBase({ apiKey, objectKey, continuationToken }) {
  const basesToTry = pinnedBaseUrl ? [pinnedBaseUrl] : BASE_URLS;
  const errors = [];

  for (const base of basesToTry) {
    const upstreamUrl = `${base.replace(/\/+$/, "")}/api/customObjects/${encodeURIComponent(objectKey)}/records?limit=1000`;

    try {
      const resp = await proxyGetWithBody(upstreamUrl, {
        Accept: "application/json",
        "X-Sleekflow-Api-Key": apiKey,
        "Content-Type": "application/json"
      }, { continuationToken });

      if (resp.status === 200) {
        pinnedBaseUrl = base;
        return resp;
      }

      errors.push({ base, status: resp.status, body: resp.body });
      // If we had a pinned base and it failed, break to avoid cycling.
      if (pinnedBaseUrl) break;
    } catch (err) {
      errors.push({ base, error: err.message });
      if (pinnedBaseUrl) break;
    }
  }

  const message = {
    error: "All base URLs failed",
    attempts: errors
  };

  return {
    status: 502,
    body: JSON.stringify(message)
  };
}

// The upstream expects GET with a JSON body; native fetch disallows GET bodies,
// so we drop to the https module to send the body with method GET.
function proxyGetWithBody(urlString, headers = {}, bodyObj = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj || {});
    const url = new URL(urlString);
    const options = {
      method: "GET",
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      protocol: url.protocol,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = require(url.protocol.slice(0, -1)).request(options, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", chunk => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({
          status: upstreamRes.statusCode || 500,
          body
        });
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
