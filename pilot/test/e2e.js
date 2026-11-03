// End-to-end run of the pilot page in Chromium, Google sign-in and the Gmail API mocked.
// Envelopes: test/rows.json if present (git-ignored; build it with tools/tsv_to_rows.py), otherwise a synthetic fixture.
// Runs both sharing modes and fails if a report value reaches the file in the private mode, or the purpose reaches the page.
// Names come from env: ME, OWNER_HE, OWNER_EN, HH_NAME.
const { chromium } = require("playwright");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "../site");
const PYO = path.join(__dirname, "node_modules/pyodide");
const ME = process.env.ME || "owner@example.com";
const OWNER_HE = process.env.OWNER_HE || "דנה כהן";
const HH_NAME = process.env.HH_NAME || "אבי כהן";
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

function fixture() {
  const out = [];
  const add = (daysAgo, from, subject, sent = false) => {
    const ts = Date.now() - daysAgo * 864e5 - out.length * 1000;
    const id = (BigInt(ts) << 20n).toString(16);
    out.push({ thread: id, id, ts, from: sent ? ME : from, to: sent ? "friend@example.com" : ME, subject, sent });
  };
  for (let m = 0; m < 30; m++) add(30 * m + 5, "billing@bezeq.co.il", "החשבונית החודשית שלך");
  for (let m = 0; m < 3; m++) add(10 * m + 3, "news@shop-example.co.il", "עדכון על ההזמנה שלך");
  for (let m = 0; m < 6; m++) add(9 * m + 2, "notify@facebookmail.com", "יש לך התראה חדשה");
  add(40, "office@court-example.co.il", "הודעה על הליך הוצאה לפועל");
  add(2, "", "שלום", true);
  return out;
}
const rowsFile = path.join(__dirname, "rows.json");
const rows = fs.existsSync(rowsFile) ? JSON.parse(fs.readFileSync(rowsFile, "utf8")) : fixture();
const byId = new Map(rows.map((r) => [r.id, r]));
const enc = (s) => "=?UTF-8?B?" + Buffer.from(s).toString("base64") + "?=";

const GSI = `window.google={accounts:{oauth2:{
  initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:"tok",scope:"https://www.googleapis.com/auth/gmail.metadata"}),50)}),
  hasGrantedAllScopes:()=>true, revoke:(t,cb)=>{window.__revoked=t;cb&&cb()}}}};`;

async function run(browser, mode) {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.W || 1200), height: 900 }, acceptDownloads: true, locale: "he-IL" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await ctx.route("https://site.test/**", (route) => {
    const p = new URL(route.request().url()).pathname.slice(1) || "index.html";
    if (p === "config.js")
      return route.fulfill({ body: 'window.IMTRUSTME={googleClientId:"test.apps.googleusercontent.com",appName:"imtrustme",sendUrl:"https://script.google.com/macros/s/test/exec",feedbackTo:"יהודית",years:3};', contentType: "text/javascript" });
    const f = path.join(SITE, p);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404 });
    const type = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", py: "text/plain", png: "image/png" }[p.split(".").pop()];
    route.fulfill({ body: fs.readFileSync(f), contentType: type + "; charset=utf-8" });
  });
  await ctx.route("https://accounts.google.com/**", (r) => r.fulfill({ body: GSI, contentType: "text/javascript" }));
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  await ctx.route("https://cdn.jsdelivr.net/npm/pyodide@0.29.3/**", (r) => {
    const f = path.join(PYO, new URL(r.request().url()).pathname.split("/").pop());
    const type = f.endsWith(".wasm") ? "application/wasm" : f.endsWith(".js") || f.endsWith(".mjs") ? "text/javascript" : "application/octet-stream";
    r.fulfill({ body: fs.readFileSync(f), contentType: type, headers: { "access-control-allow-origin": "*" } });
  });
  // the mail script: the full mode fails once first, to prove the answers survive a failed send
  const posts = [];
  let failNext = mode === "full";
  await ctx.route("https://script.google.com/**", (r) => {
    const headers = { "access-control-allow-origin": "*" };
    if (failNext) { failNext = false; return r.fulfill({ status: 500, body: "{}", headers }); }
    posts.push(r.request().postData());
    r.fulfill({ body: '{"ok":true}', contentType: "application/json", headers });
  });
  let gets = 0;
  await ctx.route("https://gmail.googleapis.com/**", (r) => {
    const u = new URL(r.request().url());
    const json = (o) => r.fulfill({ body: JSON.stringify(o), contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: ME, messagesTotal: rows.length });
    if (u.pathname.endsWith("/messages")) {
      const start = Number(u.searchParams.get("pageToken") || 0);
      const sorted = [...rows].sort((a, b) => b.ts - a.ts);
      const old = [{ id: "16d0c7e0a0000000", threadId: "16d0c7e0a0000000" }]; // a 2019 message, outside the 3 years
      const all = sorted.map((x) => ({ id: x.id, threadId: x.thread })).concat(old);
      return json({ messages: all.slice(start, start + 500), nextPageToken: start + 500 < all.length ? String(start + 500) : undefined });
    }
    const id = u.pathname.split("/").pop();
    const x = byId.get(id);
    gets++;
    if (gets === 7) return r.fulfill({ status: 429, body: "{}", headers: { "access-control-allow-origin": "*" } }); // one rate-limit hit
    const from = x.sent ? `${enc(OWNER_HE)} <${ME}>` : x.from;
    return json({ id, threadId: x.thread, internalDate: String(x.ts), labelIds: x.sent ? ["SENT"] : ["INBOX"],
      payload: { headers: [{ name: "From", value: from }, { name: "To", value: x.to }, { name: "Subject", value: x.subject }] } });
  });

  const shot = (n) => page.screenshot({ path: `${SHOTS}/${mode}-${n}.png`, fullPage: true });
  await page.goto("https://site.test/index.html");
  await shot("1-welcome");
  assert(await page.evaluate(() => document.querySelector(".logo").naturalWidth > 0), "logo did not load");

  // the purpose stays out of everything a participant can read, on the page and in the engine's rows
  const FORBIDDEN = /משכיר|שכירת|שכר דירה|דירה|פרופיל/;
  assert(!FORBIDDEN.test(await page.evaluate(() => document.body.textContent + document.title)), "purpose word in the page");

  await page.click("text=להתחיל");
  await page.fill("#name-he", OWNER_HE);
  await page.fill("#name-en", process.env.OWNER_EN || "Dana Cohen");
  await page.check("#has-hh");
  await page.fill("#hh-name", HH_NAME);
  await page.click("#details-next");
  await page.click("#connect");
  await page.waitForSelector("#s-report.on", { timeout: 180000 });
  assert.strictEqual(await page.evaluate(() => window.__revoked), "tok", "access was not revoked");
  await shot("2-report");
  assert(!FORBIDDEN.test(await page.evaluate(() => JSON.stringify(S.result.groups) + document.body.textContent)), "purpose word in the report");

  await page.click('#s-report [data-go="s-choose"]');
  await shot("3-choose");
  await page.click(`[data-mode="${mode}"]`);

  // answer: "city" wrong with a kind, "legal" wrong, one row skipped, everything else correct
  const total = await page.evaluate(() => S.checkList.length);
  for (let i = 0; i < total; i++) {
    const key = await page.evaluate(() => param(S.checkList[S.checkAt]).key);
    if (i === 0) await shot("4-check");
    if (key === "city") {
      await page.click('[data-verdict="wrong"]');
      await shot("5-check-wrong");
      await page.click('[data-kind="inaccurate"]');
      if (mode === "full") { await page.fill("#chk-note", "הערה לבדיקה"); await page.click("#chk-next"); }
    } else if (key === "legal") {
      await page.click('[data-verdict="wrong"]');
      if (mode === "full") { await page.click('[data-kind="invented"]'); await page.click("#chk-next"); }
    } else if (key === "loans") {
      await page.click("#chk-skip");
    } else {
      await page.click('[data-verdict="correct"]');
    }
  }
  await page.waitForSelector("#s-questions.on");
  await page.click("text=רוב הדברים");
  await page.click("#to-feedback");
  await shot("6-preview");
  assert.strictEqual(posts.length, 0, "something was sent before the send button");
  await page.click("#fb-send");
  if (mode === "full") {
    await page.waitForSelector("#fb-send-err:not([hidden])");
    assert(await page.isVisible("#fb-download"), "no fallback after a failed send");
    await page.click("#fb-send");
  }
  await page.waitForSelector("#s-done.on");
  await shot("7-done");
  assert.strictEqual(posts.length, 1, "expected exactly one delivered send");

  const text = posts[0];
  const fb = JSON.parse(text);
  const result = await page.evaluate(() => S.result);
  assert.strictEqual(fb.mode, mode);
  assert.strictEqual(fb.verdicts.find((v) => v.key === "loans"), undefined, "skipped row was sent");
  const city = fb.verdicts.find((v) => v.key === "city");
  const legal = fb.verdicts.find((v) => v.key === "legal");
  assert.strictEqual(city.kind, "inaccurate");

  if (mode === "private") {
    // exact field allow-list, then a search of the whole file for anything taken from the report
    for (const v of fb.verdicts) {
      assert(!("value" in v) && !("note" in v), "value or note in a private verdict: " + v.key);
      assert(!["household_accounts"].includes(v.key) && !v.key.startsWith("platform_"), "conditional row sent: " + v.key);
    }
    assert.deepStrictEqual(Object.keys(legal).sort(), ["key", "label", "verdict"], "a sensitive row carries more than the answer");
    assert.strictEqual(fb.unknown_senders.length, 0, "unknown senders must start unticked");
    assert(!("findings_rows" in fb.stats), "findings count in a private file");
    const secrets = [OWNER_HE, HH_NAME, ME];
    for (const g of result.groups) for (const p of g.params)
      if (typeof p.v === "string" && p.v.length > 2 && !p.v.startsWith("לא ")) secrets.push(p.v);
    assert(secrets.length > 3, "no report values to look for");
    // row labels are fixed text and may share words with a value ("על שמך"), so the search skips them
    const searched = JSON.stringify({ ...fb, verdicts: fb.verdicts.map(({ label, ...rest }) => rest) });
    for (const s of secrets) assert(!searched.includes(s), "report value in the private file: " + s);
    for (const v of fb.verdicts) assert.strictEqual(v.label, result.groups.flatMap((g) => g.params).find((p) => p.key === v.key).fb_label, "label is not the fixed one");
    fs.writeFileSync(path.join(SHOTS, "feedback-private.json"), text);
    console.log(`private: ${fb.verdicts.length} answers of ${total} rows, searched the file for ${secrets.length} report values, none found`);
  } else {
    assert.strictEqual(legal.kind, "invented");
    assert.ok("value" in legal, "wrong row should carry the value");
    assert.strictEqual(city.note, "הערה לבדיקה");
    assert(!fb.verdicts.find((v) => v.verdict === "correct" && "value" in v), "value on a correct row");
    assert(!text.includes(HH_NAME) || fb.verdicts.some((v) => v.value?.includes(HH_NAME)), "household name in the file");
    fs.writeFileSync(path.join(SHOTS, "feedback-full.json"), text);
    console.log(`full: ${fb.verdicts.length} answers of ${total} rows, values only on ${fb.verdicts.filter((v) => v.value !== undefined).length} wrong rows`);
  }
  assert.deepStrictEqual(errors.filter((e) => !/429|500/.test(e)), [], "browser errors");
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await run(browser, "private");
    await run(browser, "full");
    console.log("PASS");
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
