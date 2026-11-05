// End to end for the live lab: real dev.html, app.js, worker and engine in Chromium; fake Google and Gmail; real live-lab.js.
// Proves a second round reads nothing from Gmail and asks for no click, and that nothing reaches disk or the wrong caller.
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const SITE = path.join(__dirname, "../site");
const PYO = path.join(__dirname, "node_modules/pyodide");
const ORIGIN = "https://y66907-collab.github.io";
const ME = "owner@example.com";
const TOKEN = "secret-token-value";

const rows = [];
function add(daysAgo, from, subject) {
  const ts = Date.now() - daysAgo * 864e5 - rows.length * 1000;
  const id = (BigInt(ts) << 20n).toString(16);
  rows.push({ id, thread: id, ts, from, subject });
}
for (let m = 0; m < 24; m++) add(30 * m + 5, "billing@bezeq.co.il", "החשבונית החודשית שלך");
for (let m = 0; m < 6; m++) add(9 * m + 2, "notify@facebookmail.com", "יש לך התראה חדשה");
for (let m = 0; m < 5; m++) add(4 * m + 1, "person@unknown-example.co.il", "שלום");

const hits = { gmail: 0, clicks: 0, feedback: 0 };
let revoked = "";
const revokeServer = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => { revoked = new URLSearchParams(b).get("token"); res.end("{}"); });
});

const GSI = `window.google={accounts:{oauth2:{
  initTokenClient:(o)=>({requestAccessToken:()=>{window.__clicks=(window.__clicks||0)+1;fetch("https://count.test/click",{mode:"no-cors"}).catch(()=>{});setTimeout(()=>o.callback({access_token:${JSON.stringify(TOKEN)}}),20)}}),
  hasGrantedAllScopes:()=>true, revoke:()=>{throw new Error("the page must not revoke in the lab")}}}};`;

function matches(x, q) {
  for (const [, field, val] of q.matchAll(/(?<!-)(from|subject):("[^"]*"|\([^)]*\)|\S+)/g)) {
    const v = val.replace(/^["(]|[")]$/g, "").toLowerCase();
    if (field === "from" && !x.from.includes(v)) return false;
    if (field === "subject" && !v.split(" or ").some((w) => x.subject.toLowerCase().includes(w.trim().replace(/"/g, "")))) return false;
  }
  return !q.includes("in:sent");
}

async function main() {
  await new Promise((r) => revokeServer.listen(0, "127.0.0.1", r));
  const lab = spawn(process.execPath, [path.join(__dirname, "live-lab.js"), "--hint=owner@example.com"], {
    env: { ...process.env, LAB_NO_OPEN: "1", LAB_REVOKE_URL: `http://127.0.0.1:${revokeServer.address().port}/revoke` },
  });
  let out = "";
  lab.stdout.on("data", (d) => (out += d));
  lab.stderr.on("data", (d) => (out += d));
  process.on("exit", () => lab.kill());
  while (!/URL \S+/.test(out)) await new Promise((r) => setTimeout(r, 50));
  const [, port, code] = /ADMIN (\d+) (\w+)/.exec(out);
  const url = /URL (\S+)/.exec(out)[1];
  const admin = (p, method = "GET") => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "x-code": code } });
  const adminJson = async (p) => (await admin(p)).json();

  // who may talk to it
  const raw = (p, headers, method = "GET") => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (x) => { x.resume(); resolve(x.statusCode); });
    r.end();
  });
  assert.equal(await raw("/admin/payload", {}), 403, "admin without the code");
  assert.equal(await raw("/admin/payload", { "x-code": code, origin: "https://evil.example" }), 403, "admin from a web page");
  assert.equal(await raw("/admin/stop", { "x-code": "x".repeat(code.length) }, "POST"), 403, "stop with a wrong code");
  assert.equal(await raw("/state", { origin: "https://evil.example", "x-code": code }), 403, "the page route from another site");
  assert.equal(await raw("/state", { origin: ORIGIN, "x-code": "wrong" }), 403, "the page route with a wrong code");
  assert.equal(await raw("/site/../../secret", { origin: ORIGIN, "x-code": code }), 404, "a path outside the site");

  const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] }); // stands in for the owner allowing the prompt
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1200, height: 900 } });
  const errors = [];
  await ctx.route(`${ORIGIN}/**`, (r) => {
    const p = new URL(r.request().url()).pathname.replace("/trust-profile/", "");
    const f = path.join(SITE, p);
    if (!fs.existsSync(f)) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(f), contentType: { html: "text/html", js: "text/javascript" }[p.split(".").pop()] || "application/octet-stream" });
  });
  await ctx.route("https://accounts.google.com/**", (r) => r.fulfill({ body: GSI, contentType: "text/javascript" }));
  await ctx.route("https://count.test/**", (r) => { hits.clicks++; r.fulfill({ body: "" }); });
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  await ctx.route("https://data.gov.il/**", (r) => r.fulfill({ body: '{"result":{"records":[]}}', contentType: "application/json", headers: { "access-control-allow-origin": "*" } }));
  await ctx.route("https://cdn.jsdelivr.net/npm/pyodide@0.29.3/**", (r) => {
    const f = path.join(PYO, new URL(r.request().url()).pathname.split("/").pop());
    const type = f.endsWith(".wasm") ? "application/wasm" : /\.m?js$/.test(f) ? "text/javascript" : "application/octet-stream";
    r.fulfill({ body: fs.readFileSync(f), contentType: type, headers: { "access-control-allow-origin": "*" } });
  });
  await ctx.route("https://script.google.com/**", (r) => {
    const body = JSON.parse(r.request().postData());
    if (body.kind === "imtrustme-pilot-feedback") hits.feedback++;
    r.fulfill({ body: JSON.stringify({ ok: true, results: [], summary: [], sentences: [] }), contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
  });
  await ctx.route("https://gmail.googleapis.com/**", (r) => {
    hits.gmail++;
    assert.equal(r.request().headers().authorization, `Bearer ${TOKEN}`);
    const u = new URL(r.request().url());
    const json = (o) => r.fulfill({ body: JSON.stringify(o), contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: ME, messagesTotal: rows.length });
    if (u.pathname.endsWith("/messages")) {
      const q = u.searchParams.get("q"), label = u.searchParams.get("labelIds");
      const found = label ? [] : rows.filter((x) => !q || matches(x, q));
      return json({ messages: found.map((x) => ({ id: x.id, threadId: x.thread })) });
    }
    const x = rows.find((m) => m.id === u.pathname.split("/").pop());
    if (u.searchParams.get("format") === "full") return json({ id: x.id, threadId: x.thread, labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: x.from }, { name: "Subject", value: x.subject }], body: { data: Buffer.from("גוף").toString("base64url") } } });
    return json({ id: x.id, threadId: x.thread, internalDate: String(x.ts), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: x.from }, { name: "To", value: ME }, { name: "Subject", value: x.subject }] } });
  });

  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  assert(!page.url().includes("#"), "the code stays out of the address bar");
  await page.waitForSelector("#s-welcome.on", { timeout: 20000 });
  assert.equal(await page.evaluate(() => /משכיר|שכירת|שכר דירה|דירה/.test(document.title)), false, "purpose word in the title");
  assert.equal(hits.gmail, 0, "nothing is read before the click");

  // round 1: the owner fills the details and approves
  await page.click('[data-go="s-details"]');
  await page.fill("#name-he", "דנה כהן");
  await page.fill("#name-en", "Dana Cohen");
  await page.click("#details-next");
  await page.click("#connect");
  const waitFor = async (check, what, ms = 180000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await adminJson("/admin/summary");
      if (check(s)) return s;
      if (Date.now() > end) throw new Error(`timed out on ${what}: ${JSON.stringify(s).slice(0, 400)} | ${await page.textContent("#run-err").catch(() => "")}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const first = await waitFor((s) => s.reports.includes("final") && s.trace.finished, "round 1");
  const firstGmail = hits.gmail;
  assert(firstGmail > 0, "gmail was read");
  assert.equal(hits.clicks, 1, "one approval");
  assert.equal(first.payloadRows, rows.length, "the engine got every message");
  assert.equal(first.trace.errors, 0, "errors: " + JSON.stringify(await adminJson("/admin/trace?k=pageerror")));

  const trace = await adminJson("/admin/trace");
  const stages = trace.filter((e) => e.k === "stage").map((e) => e.args[0]);
  assert(stages.includes("read") && stages.includes("engine"), "stages in the trace: " + stages);
  const lists = trace.filter((e) => e.k === "gmail" && e.what === "list");
  assert(lists.some((e) => e.q && e.ids?.length), "a search and its ids are in the trace");
  assert(trace.some((e) => e.k === "gmail" && e.what === "message" && e.id), "a read and its id are in the trace");
  // A search query is the page's own wording, so it may share a word with a subject. Anything else may not.
  const leaks = trace.filter((e) => { const { q, ...rest } = e; const t = JSON.stringify(rest); return t.includes(TOKEN) || t.includes("גוף") || t.includes("החשבונית"); });
  assert.deepStrictEqual(leaks, [], "token or mail text in the trace");
  assert(!JSON.stringify(trace).includes(TOKEN), "token in a query");

  const report = await adminJson("/admin/report?stage=final");
  assert(report.result.groups.length > 0, "the report has rows");
  assert.equal(report.run.complete, true);

  // quick engine rerun gives what the browser engine gave, without Gmail
  const payload = await (await admin("/admin/payload")).text();
  const rerun = spawnSync("python", [path.join(__dirname, "engine_rerun.py")], { input: payload, encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(rerun.status, 0, rerun.stderr);
  const browserEngine = await adminJson("/admin/engine-result");
  assert.deepStrictEqual(JSON.parse(rerun.stdout).groups, browserEngine.groups, "python and pyodide agree");

  // a work address names the workplace while its domain still sends mail, and stops naming it once the domain went quiet
  const employerWith = (daysAgo) => {
    const p = JSON.parse(payload);
    const ts = Date.now() - daysAgo * 864e5;
    for (let i = 0; i < 3; i++) {
      const id = (BigInt(ts - i * 31 * 864e5) << 20n).toString(16);
      p.rows.push({ thread: id, id, ts: ts - i * 31 * 864e5, from: "x@workplace-example.co.il", to: "", subject: "", sent: false });
    }
    p.work_address = { domain: "workplace-example.co.il", mails: 1 };
    const out = spawnSync("python", [path.join(__dirname, "engine_rerun.py")], { input: JSON.stringify(p), encoding: "utf8", maxBuffer: 1 << 28 });
    assert.equal(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    return { row: result.groups.flatMap((g) => g.params).find((x) => x.key === "employer"), said: result.portrait.map((x) => x.text) };
  };
  const working = employerWith(20), left = employerWith(500);
  assert.equal(working.row.v, "workplace-example.co.il", "the workplace from a work address");
  assert.equal(working.row.n, 3);
  assert(working.row.note.includes("כתובת על שמך"), "the row says what it rests on");
  assert(working.said.includes("עבודה ב-workplace-example.co.il."), "the workplace in the summary: " + working.said);
  assert.equal(left.row.v, null, "a former workplace is not the current one");

  // round 2: no click, nothing from Gmail
  assert.equal((await (await admin("/admin/round", "POST")).json()).round, 2);
  const second = await waitFor((s) => s.reports.includes("final") && s.trace.finished, "round 2");
  assert.equal(hits.gmail, firstGmail, "round 2 reads nothing from Gmail");
  assert.equal(hits.clicks, 1, "round 2 asks for no approval");
  assert.equal(second.trace.gmailReal, 0);
  assert(second.trace.gmailCalls > 0, "round 2 still went through the cache");
  assert.equal(second.trace.errors, 0, "round 2 errors: " + JSON.stringify(await adminJson("/admin/trace?k=pageerror")));
  const secondReport = await adminJson("/admin/report?stage=final");
  assert.deepStrictEqual(secondReport.result.groups, report.result.groups, "the same mail gives the same report");

  assert.equal(hits.feedback, 0, "no feedback goes out");
  assert.deepStrictEqual(errors, [], "page errors");

  await admin("/admin/stop", "POST");
  await new Promise((r) => lab.on("exit", r));
  assert.equal(revoked, TOKEN, "access is revoked on stop");
  assert(!out.includes(TOKEN), "the token never reaches the log");
  await browser.close();
  revokeServer.close();
  console.log("PASS", JSON.stringify({ rows: rows.length, gmailFirstRound: firstGmail, gmailSecondRound: hits.gmail - firstGmail, clicks: hits.clicks, cacheHits: second.cache.hits }));
}

main().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
