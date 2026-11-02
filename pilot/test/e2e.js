// End-to-end run of the pilot page in Chromium, Google sign-in and the Gmail API mocked from test/rows.json (git-ignored;
// build it with tools/tsv_to_rows.py). Names come from env: ME, OWNER_HE, OWNER_EN, HH_NAME.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "../site");
const PYO = path.join(__dirname, "node_modules/pyodide");
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "rows.json"), "utf8"));
const ME = process.env.ME || "owner@example.com";
const byId = new Map(rows.map((r) => [r.id, r]));
const enc = (s) => "=?UTF-8?B?" + Buffer.from(s).toString("base64") + "?=";
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const GSI = `window.google={accounts:{oauth2:{
  initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:"tok",scope:"${"https://www.googleapis.com/auth/gmail.metadata"}"}),50)}),
  hasGrantedAllScopes:()=>true, revoke:(t,cb)=>{window.__revoked=t;cb&&cb()}}}};`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.W || 1200), height: 900 }, acceptDownloads: true, locale: "he-IL" });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
  page.on("worker",w=>w.on("console",m=>console.log("W:",m.text().slice(0,400))));
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  await ctx.route("https://site.test/**", (route) => {
    let p = new URL(route.request().url()).pathname.slice(1) || "index.html";
    if (p === "config.js")
      return route.fulfill({ body: 'window.IMTRUSTME={googleClientId:"test.apps.googleusercontent.com",feedbackTo:"יהודית",years:3};', contentType: "text/javascript" });
    const f = path.join(SITE, p);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404 });
    const type = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", py: "text/plain" }[p.split(".").pop()];
    route.fulfill({ body: fs.readFileSync(f), contentType: type + "; charset=utf-8" });
  });
  await ctx.route("https://accounts.google.com/**", (r) => r.fulfill({ body: GSI, contentType: "text/javascript" }));
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  await ctx.route("https://cdn.jsdelivr.net/npm/pyodide@0.29.3/**", (r) => {
    const f = path.join(PYO, new URL(r.request().url()).pathname.split("/").pop());
    const type = f.endsWith(".wasm") ? "application/wasm" : f.endsWith(".js") || f.endsWith(".mjs") ? "text/javascript" : "application/octet-stream";
    r.fulfill({ body: fs.readFileSync(f), contentType: type, headers: { "access-control-allow-origin": "*" } });
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
      const page = all.slice(start, start + 500);
      return json({ messages: page, nextPageToken: start + 500 < all.length ? String(start + 500) : undefined });
    }
    const id = u.pathname.split("/").pop();
    const x = byId.get(id);
    gets++;
    if (gets === 7) return r.fulfill({ status: 429, body: "{}", headers: { "access-control-allow-origin": "*" } }); // one rate-limit hit
    const from = x.sent ? `${enc(process.env.HH_NAME || "אבי כהן")} <${ME}>` : x.from;
    return json({ id, threadId: x.thread, internalDate: String(x.ts), labelIds: x.sent ? ["SENT"] : ["INBOX"],
      payload: { headers: [{ name: "From", value: from }, { name: "To", value: x.to }, { name: "Subject", value: x.subject }] } });
  });

  await page.goto("https://site.test/index.html");
  await page.screenshot({ path: `${SHOTS}/1-welcome.png`, fullPage: true });
  await page.click("text=להתחיל");
  await page.click("#details-next");
  await page.fill("#name-he", process.env.OWNER_HE || "דנה כהן");
  await page.fill("#name-en", process.env.OWNER_EN || "Dana Cohen");
  await page.check("#has-hh");
  await page.fill("#hh-name", process.env.HH_NAME || "אבי כהן");
  await page.screenshot({ path: `${SHOTS}/2-details.png`, fullPage: true });
  await page.click("#details-next");
  await page.screenshot({ path: `${SHOTS}/3-connect.png`, fullPage: true });
  const t0 = Date.now();
  await page.click("#connect");
  await page.waitForSelector("#connect-run:not([hidden])");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/4-reading.png`, fullPage: true });
  await page.waitForSelector("#s-report.on", { timeout: 180000 });
  console.log("report after", ((Date.now() - t0) / 1000).toFixed(1), "s; revoked:", await page.evaluate(() => window.__revoked));
  await page.screenshot({ path: `${SHOTS}/5-report.png`, fullPage: true });

  // mark rows: hide one, comment one, flag one wrong
  const rowsEl = await page.$$(".row");
  await (await rowsEl[3].$('[data-act="hide"]')).click();
  await (await rowsEl[0].$('[data-act="comment"]')).click();
  await page.keyboard.type("גרה כאן מ-2021, לא מ-2023");
  await (await rowsEl[8].$('[data-act="wrong"]')).click();
  await page.keyboard.type("אין לי שום בנק כזה");
  await page.screenshot({ path: `${SHOTS}/6-report-marked.png`, fullPage: true });
  await page.pdf({ path: `${SHOTS}/report.pdf`, format: "A4", printBackground: true }).catch(() => {});

  await page.click("text=המשך: כמה שאלות");
  await page.fill("#q-feel", "מעניין, לא ידעתי שרואים כל כך הרבה");
  await page.click("text=עוד לא, אבל ארצה");
  await page.click("text=כן, אחרי שאסתיר שורות");
  await page.click("text=30 עד 80 ש״ח");
  await page.click("#to-feedback");
  await page.click("#fb-unknown .fb-item input"); // remove the first unknown sender
  await page.screenshot({ path: `${SHOTS}/7-feedback.png`, fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#fb-make")]);
  const out = path.join(SHOTS, dl.suggestedFilename());
  await dl.saveAs(out);
  await page.screenshot({ path: `${SHOTS}/8-done.png`, fullPage: true });
  const fb = JSON.parse(fs.readFileSync(out, "utf8"));
  console.log("file:", dl.suggestedFilename(), "answers:", Object.keys(fb.answers).length, "marks:", JSON.stringify(fb.marks),
    "unknown:", fb.unknown_senders.length, "stats:", JSON.stringify(fb.stats));
  fs.writeFileSync(path.join(SHOTS, "result.json"), JSON.stringify(await page.evaluate(() => S.result), null, 1));
  await browser.close();
})();
