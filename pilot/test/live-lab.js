// Local server for development rounds on the owner's real mailbox. See site/dev.html.
// Mail, reports and the Gmail token live in this process's memory only: nothing is written to disk,
// and everything is gone when it stops. It listens on 127.0.0.1 and answers only the dev page or its one-time code.
// Usage: node live-lab.js [--hint=<account to preselect>]
// Prints an admin line with the port and code. Admin: GET /admin/summary, /admin/report?stage=first|final,
// /admin/trace?from=N&k=kind, /admin/payload. POST /admin/round reloads the page, /admin/stop revokes access and exits.
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const SITE_ORIGIN = "https://y66907-collab.github.io";
const PAGE = `${SITE_ORIGIN}/trust-profile/dev.html`;
const REVOKE = process.env.LAB_REVOKE_URL || "https://oauth2.googleapis.com/revoke";
const SITE_DIR = path.join(__dirname, "..", "site");
const SITE_FILES = new Set(["index.html", "app.js", "worker.js", "style.css", "engine/engine.py", "engine/pilot.py",
  "engine/senders.json", "engine/orgs.json", "engine/labels.json", "engine/rules.json", "engine/excluded_hashes.json"]);
const TOKEN_LIFE_MS = 50 * 60 * 1000;
const MAX_BODY = 512 * 1024 * 1024;
const CONTENT_TYPES = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", py: "text/plain" };

const code = crypto.randomBytes(24).toString("hex");
const hint = process.argv.slice(2).find((a) => a.startsWith("--hint="))?.slice(7);

const cache = new Map();
let cacheBytes = 0, cacheHits = 0, cacheMisses = 0;
let token = "", tokenAt = 0, details = null, round = 1;
let traceLog = [], payload = null, engineResult = null, reports = {};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function revokeAccess() {
  if (!token) return "no access held";
  const ok = await fetch(REVOKE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) })
    .then((r) => r.ok).catch(() => false);
  token = "";
  return ok ? "access revoked" : "revoke failed: remove access at myaccount.google.com";
}

async function stop(signal) {
  console.log(await revokeAccess());
  process.exit(signal ? 1 : 0);
}

const freshToken = () => (token && Date.now() - tokenAt < TOKEN_LIFE_MS ? token : "");

function summary() {
  const count = (k) => traceLog.filter((e) => e.k === k).length;
  const gmail = traceLog.filter((e) => e.k === "gmail");
  return {
    round,
    tokenFresh: !!freshToken(),
    tokenAgeMin: token ? Math.round((Date.now() - tokenAt) / 60000) : null,
    cache: { entries: cache.size, mb: Math.round(cacheBytes / 1e6), hits: cacheHits, misses: cacheMisses },
    trace: { entries: traceLog.length, gmailCalls: gmail.length, gmailReal: gmail.filter((e) => !e.cached).length, errors: count("pageerror") + traceLog.filter((e) => e.k === "console" && e.level === "error").length, warnings: traceLog.filter((e) => e.k === "console" && e.level === "warn").length, finished: count("finished") > 0 },
    lastStage: traceLog.filter((e) => e.k === "stage").slice(-1)[0]?.args || null,
    payloadRows: payload?.rows?.length ?? null,
    reports: Object.keys(reports),
    run: reports.final?.run || reports.first?.run || null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const isAdmin = url.pathname.startsWith("/admin/");
  const origin = req.headers.origin;
  // the dev page comes from the site's origin; the admin routes take no browser origin at all
  if (isAdmin ? origin !== undefined : origin !== SITE_ORIGIN) { res.writeHead(403); return res.end(); }
  const cors = isAdmin ? {} : {
    "access-control-allow-origin": SITE_ORIGIN,
    "access-control-allow-headers": "x-code, content-type",
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
    vary: "origin",
  };
  if (req.method === "OPTIONS") { res.writeHead(isAdmin ? 403 : 204, cors); return res.end(); }
  const given = req.headers["x-code"] || "";
  const same = given.length === code.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(code));
  if (!same) { res.writeHead(403, cors); return res.end(); }

  const json = (value, status = 200) => { res.writeHead(status, { ...cors, "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
  const empty = (status = 204) => { res.writeHead(status, cors); res.end(); };

  try {
    if (req.method === "GET") {
      if (url.pathname === "/state") return json({ round, token: freshToken(), details });
      if (url.pathname.startsWith("/site/")) {
        const name = url.pathname.slice(6);
        if (!SITE_FILES.has(name)) return empty(404);
        res.writeHead(200, { ...cors, "content-type": `${CONTENT_TYPES[name.split(".").pop()]}; charset=utf-8` });
        return res.end(fs.readFileSync(path.join(SITE_DIR, name)));
      }
      if (url.pathname === "/admin/summary") return json(summary());
      if (url.pathname === "/admin/report") return json(reports[url.searchParams.get("stage") || "final"] || reports.first || null);
      if (url.pathname === "/admin/engine-result") return json(engineResult);
      if (url.pathname === "/admin/payload") return json(payload);
      if (url.pathname === "/admin/trace") {
        const k = url.searchParams.get("k");
        const from = Number(url.searchParams.get("from") || 0);
        return json((k ? traceLog.filter((e) => e.k === k) : traceLog).slice(from));
      }
      return empty(404);
    }
    if (req.method !== "POST") return empty(405);
    if (url.pathname === "/admin/round") {
      traceLog = [];
      reports = {};
      engineResult = null;
      round++;
      return json({ round });
    }
    if (url.pathname === "/admin/stop") {
      json({ stopping: true });
      return stop();
    }
    const body = await readBody(req);
    if (url.pathname === "/cache/get") {
      const key = JSON.parse(body).key;
      if (!cache.has(key)) { cacheMisses++; return empty(404); }
      cacheHits++;
      res.writeHead(200, { ...cors, "content-type": "text/plain; charset=utf-8" });
      return res.end(cache.get(key));
    }
    if (url.pathname === "/cache/put") {
      const { key, value } = JSON.parse(body);
      if (!cache.has(key)) cacheBytes += value.length;
      cache.set(key, value);
      return empty();
    }
    if (url.pathname === "/token") {
      const value = JSON.parse(body).token;
      if (typeof value !== "string" || !value) return empty(400);
      token = value;
      tokenAt = Date.now();
      console.log("signed in");
      return empty();
    }
    if (url.pathname === "/token/clear") { tokenAt = 0; return empty(); }
    if (url.pathname === "/trace") { traceLog.push(...JSON.parse(body)); return empty(); }
    if (url.pathname === "/details") { details = JSON.parse(body); return empty(); }
    if (url.pathname === "/capture/payload") { payload = JSON.parse(body); return empty(); }
    if (url.pathname === "/capture/result") { engineResult = JSON.parse(body); return empty(); }
    if (url.pathname === "/capture/report") {
      const report = JSON.parse(body);
      reports[report.stage] = report;
      console.log(`report ready: ${report.stage}`);
      return empty();
    }
    return empty(404);
  } catch (e) {
    console.log(`request failed: ${url.pathname} ${String(e.message).slice(0, 80)}`);
    return empty(400);
  }
});

process.on("SIGINT", () => stop(true));
process.on("SIGTERM", () => stop(true));

server.listen(Number(process.env.LAB_PORT || 0), "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`ADMIN ${port} ${code}`);
  const fragment = new URLSearchParams({ port, code, ...(hint ? { hint } : {}) });
  const url = `${PAGE}#${fragment}`;
  if (process.env.LAB_NO_OPEN) console.log(`URL ${url}`);
  else spawn("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true }).unref();
});
