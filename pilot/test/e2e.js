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
  for (let m = 0; m < 4; m++) { add(20 * m + 6, "deals@booking.com", "ההזמנה שלך"); if (m > 1) out[out.length - 1].promo = true; }
  for (let m = 0; m < 5; m++) { add(4 * m + 1, "sale@promo-example.co.il", "מבצע"); out[out.length - 1].promo = true; }
  add(2, "", "שלום", true);
  // replies half an hour later, a job interview, and a monthly receipt from a sender the engine doesn't know
  for (let m = 0; m < 6; m++) {
    add(60 + m, "partner@example.com", "שאלה");
    const q = out[out.length - 1];
    add(60 + m, "", "תשובה", true);
    const a = out[out.length - 1];
    a.ts = q.ts + 30 * 60000; a.id = (BigInt(a.ts) << 20n).toString(16); a.thread = q.thread;
  }
  add(100, "hr@acme-example.com", "זימון לראיון עבודה");
  // mail that is read: a contract in two mails and a PDF, an excluded sender, payslips, a flight, and network mail
  const last = () => out[out.length - 1];
  for (let m = 0; m < 2; m++) { add(15 + m, "office@lawyer-example.co.il", "חוזה לחתימה"); last().body = "כתובת הנכס: רחוב הרצל 5, המושכר נמצא בעיר חיפה"; }
  add(19, "office@lawyer-example.co.il", "הסכם שנתי"); last().pdf = true;
  add(21, "care@maccabi4u.co.il", "הסכם טיפול"); last().body = "המושכר בעיר אילת";
  for (let m = 0; m < 2; m++) { add(30 * m + 11, "hr@payroll-example.co.il", "תלוש שכר"); last().body = "שם המעסיק: חברת דוגמה\nהיקף משרה: 80%\nשכר ברוטו 12345"; }
  add(25, "tickets@air-example.com", "כרטיס טיסה"); last().body = "TLV to Athens, seat 12A";
  for (let m = 0; m < 5; m++) { add(3 + m, "messages-noreply@linkedin.com", "הודעה חדשה"); last().html = '<a href="https://il.linkedin.com/comm/in/test-owner?midToken=secrettoken&amp;trk=eml-header-0-profile_glimmer">me</a><a href="https://il.linkedin.com/comm/in/other-person?trk=eml-ProfileCard-0-profile_name">them</a>'; }
  for (let m = 0; m < 4; m++) add(30 * m + 8, "billing@saasco.io", "קבלה על התשלום");
  // the paragraph: an academic sender, a standing order, and contracts the participant wrote about
  for (let m = 0; m < 3; m++) add(50 + m, "office@campus-example.ac.il", "מערכת שעות");
  add(70, "billing@bezeq.co.il", "אישור הוראת קבע");
  for (let m = 0; m < 2; m++) add(80 + m, "", "הערות לחוזה", true);
  add(90, "donotreply@gov.il", "שינוי כתובת מגורים (מען) - 12345");
  add(91, "", "פרטי משכנתא", true);
  add(92, "", "תיאום טכנאי אחרי מעבר דירה", true);
  add(93, "office@lawyer-example.co.il", "נסח טאבו");
  for (let m = 0; m < 3; m++) add(100 + 30 * m, "billing@sender.netfree.link", "החשבונית החודשית שלך");
  add(94, "office@lawyer-example.co.il", `נסח טאבו של ${OWNER_HE} ת.ז. 123456789 me@x.com`);
  // a mailbox in weekly use: more mails sent than weeks in the period
  for (let d = 0; d < 200; d++) add(5 * d + 1, "", "עדכון", true);
  return out;
}
const TEST_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 58>>stream\nBT /F1 12 Tf 72 720 Td (property address Tel Aviv) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
const rowsFile = path.join(__dirname, "rows.json");
const rows = fs.existsSync(rowsFile) ? JSON.parse(fs.readFileSync(rowsFile, "utf8")) : fixture();
const byId = new Map(rows.map((r) => [r.id, r]));
const enc = (s) => "=?UTF-8?B?" + Buffer.from(s).toString("base64") + "?=";

// the part of Gmail's search language the page uses
function matches(x, q) {
  const subj = x.subject.toLowerCase();
  for (const [, field, val] of q.matchAll(/(?<!-)(from|to|subject):("[^"]*"|\([^)]*\)|\S+)/g)) {
    const v = val.replace(/^["(]|[")]$/g, "").toLowerCase();
    if (field === "from" && !x.from.toLowerCase().includes(v)) return false;
    if (field === "to" && !x.to.toLowerCase().includes(v)) return false;
    if (field === "subject" && !v.split(" or ").some((w) => subj.includes(w.trim().replace(/"/g, "")))) return false;
  }
  return !q.includes("in:sent") || x.sent;
}

const GSI = `window.google={accounts:{oauth2:{
  initTokenClient:(o)=>({requestAccessToken:()=>setTimeout(()=>o.callback({access_token:"tok",scope:"https://www.googleapis.com/auth/gmail.readonly"}),50)}),
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
    const type = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", py: "text/plain", png: "image/png", svg: "image/svg+xml" }[p.split(".").pop()];
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
  const posts = [], searches = [], registryCalls = [], aiCalls = [], employerSearches = [];
  await ctx.route("https://data.gov.il/**", (r) => {
    registryCalls.push(r.request().url());
    const url = decodeURIComponent(r.request().url());
    if (url.includes("f004176c") && url.includes("חברת דוגמה")) {
      return r.fulfill({ body: JSON.stringify({ result: { records: [{ "שם חברה": 'חברת דוגמה בע"מ', "מספר חברה": "512", "סטטוס חברה": "פעילה", "תאריך התאגדות": "01/02/2005", "שם עיר": "תל אביב" }] } }), contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
    }
    const own = r.request().url().includes("f004176c"); // the company registry
    const [first, ...rest] = OWNER_HE.split(" ");
    const records = own ? [{ "שם חברה": `${first} ${rest.join(" ")} בע"מ`, "מספר חברה": "515", "סטטוס חברה": "פעילה", "שם עיר": "חיפה" }] : [];
    r.fulfill({ body: JSON.stringify({ result: { records } }), contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
  });
  let failNext = mode === "full";
  await ctx.route("https://script.google.com/**", (r) => {
    const headers = { "access-control-allow-origin": "*" };
    if (JSON.parse(r.request().postData()).kind === "imtrustme-ai") {
      aiCalls.push(r.request().postData());
      const lines = JSON.parse(r.request().postData()).items;
      return r.fulfill({ body: JSON.stringify({ ok: true, summary: [
        { topic: "עבודה", text: "עבודה בהיקף חלקי.", sources: [lines.findIndex((x) => x[2].includes("80%"))] },
        { topic: "מגורים", text: "מעבר מגורים לאחרונה.", sources: [lines.findIndex((x) => x[2].includes("עדכון כתובת"))] },
      ], sentences: [
        { text: "מיילים על משכנתא ומעבר מגורים באותה תקופה.", sources: [0, 1] },
        { text: "אדם אמין ויסודי.", sources: [0] },
        { text: "משפט בלי מקור.", sources: [] },
      ] }), contentType: "application/json", headers });
    }
    if (JSON.parse(r.request().postData()).kind === "imtrustme-search") {
      const asked = JSON.parse(r.request().postData()).queries;
      if (asked.join(" ").includes("חברת דוגמה")) {
        employerSearches.push(asked);
        return r.fulfill({ body: JSON.stringify({ ok: true, results: [
          { title: "חברת דוגמה | דף הבית", link: "https://www.dugma-example.co.il/about?x=1", snippet: "חברת דוגמה עוסקת בתקשורת" },
          { title: "חברת דוגמה | LinkedIn", link: "https://il.linkedin.com/company/dugma-example", snippet: "" },
        ] }), contentType: "application/json", headers });
      }
      searches.push(r.request().postData());
      return r.fulfill({ body: JSON.stringify({ ok: true, results: [
        { title: `${OWNER_HE} מרצה בכנס`, link: "https://news-example.co.il/a#top", snippet: "" },
        { title: `${OWNER_HE} פסק דין`, link: "https://www.psakdin.co.il/Document/1", snippet: "" },
        { title: `${OWNER_HE}‏ | GitHub`, link: "https://github.com/test-owner-gh", snippet: "" },
        { title: `${OWNER_HE} אלופת ישראל בקרוספיט`, link: "https://sport-example.co.il/c", snippet: "" },
        { title: "מישהו אחר לגמרי", link: "https://other-example.co.il/b", snippet: "" },
      ] }), contentType: "application/json", headers });
    }
    if (failNext) { failNext = false; return r.fulfill({ status: 500, body: "{}", headers }); }
    posts.push(r.request().postData());
    r.fulfill({ body: '{"ok":true}', contentType: "application/json", headers });
  });
  let gets = 0, promoRead = 0, lists = 0, bodyGets = 0;
  await ctx.route("https://gmail.googleapis.com/**", (r) => {
    const u = new URL(r.request().url());
    const json = (o) => r.fulfill({ body: JSON.stringify(o), contentType: "application/json", headers: { "access-control-allow-origin": "*" } });
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: ME, messagesTotal: rows.length });
    if (u.pathname.endsWith("/messages")) {
      lists++;
      const start = Number(u.searchParams.get("pageToken") || 0);
      const label = u.searchParams.get("labelIds"), q = u.searchParams.get("q");
      if (q) assert(/after:\d{4}\/\d\d\/\d\d/.test(q), "search without a date: " + q);
      const sorted = [...rows].sort((a, b) => b.ts - a.ts).filter((x) =>
        label === "CATEGORY_PROMOTIONS" ? x.promo : label === "SENT" ? x.sent : label ? false : q ? matches(x, q) : true);
      const old = [{ id: "16d0c7e0a0000000", threadId: "16d0c7e0a0000000" }]; // a 2019 message, outside the 3 years
      const all = sorted.map((x) => ({ id: x.id, threadId: x.thread })).concat(label || q ? [] : old);
      return json({ messages: all.slice(start, start + 500), nextPageToken: start + 500 < all.length ? String(start + 500) : undefined });
    }
    if (u.pathname.includes("/attachments/")) return json({ data: Buffer.from(TEST_PDF).toString("base64url") });
    const id = u.pathname.split("/").pop();
    const x = byId.get(id);
    if (u.searchParams.get("format") === "full") {
      bodyGets++;
      if (x.promo) promoRead++;
      const b64 = (t) => Buffer.from(t).toString("base64url");
      const parts = [];
      if (x.body) parts.push({ mimeType: "text/plain", body: { data: b64(x.body) } });
      if (x.html) parts.push({ mimeType: "text/html", body: { data: b64(x.html) } });
      if (x.pdf) parts.push({ mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "att1", size: TEST_PDF.length } });
      return json({ id, threadId: x.thread, labelIds: ["INBOX"], payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: x.from || ME }], parts } });
    }
    if (x.promo) promoRead++;
    gets++;
    if (gets === 2) return r.fulfill({ status: 429, body: "{}", headers: { "access-control-allow-origin": "*" } }); // one rate-limit hit
    const from = x.sent ? `${enc(OWNER_HE)} <${ME}>` : x.from;
    return json({ id, threadId: x.thread, internalDate: String(x.ts), labelIds: x.sent ? ["SENT"] : ["INBOX"],
      payload: { headers: [{ name: "From", value: from }, { name: "To", value: x.to }, { name: "Subject", value: x.subject }] } });
  });

  const shot = (n) => page.screenshot({ path: `${SHOTS}/${mode}-${n}.png`, fullPage: true });
  await page.goto("https://site.test/index.html");
  await shot("1-welcome");

  // Gmail matches whole words: a Hebrew subject search must also ask for the word with its prefixes
  const widened = await page.evaluate(() => [widenSubjects('subject:"הוצאה לפועל"'), widenSubjects("subject:(רבעוני OR invoice) from:x.com"), widenSubjects("subject:BDI")]);
  assert(widened[0].includes('"בהוצאה לפועל"') && widened[0].includes('"הוצאה לפועל"'), "a phrase keeps its quotes and gets prefixes: " + widened[0]);
  assert(widened[1].includes("הרבעוני") && widened[1].includes(" OR invoice)") && widened[1].endsWith(" from:x.com"), "a list widens only its Hebrew words: " + widened[1]);
  assert.strictEqual(widened[2], "subject:(BDI)", "an English word stays as it is");

  // the purpose stays out of everything a participant can read, on the page and in the engine's rows
  const FORBIDDEN = /משכיר|שכירת|שכר דירה|דירה|פרופיל/;
  assert(!FORBIDDEN.test(await page.evaluate(() => document.body.textContent + document.title)), "purpose word in the page");

  await page.click("text=להתחיל");
  await page.fill("#name-he", OWNER_HE);
  await page.fill("#name-en", process.env.OWNER_EN || "Dana Cohen");
  await page.check("#has-hh");
  await page.fill("#hh-name", HH_NAME);
  await page.click("#details-next");
  if (mode === "private") { await page.uncheck("#web-ok"); await page.uncheck("#ai-ok"); } // this run also proves nothing goes out without the boxes
  // what was finished at the very moment the report screen came up
  await page.evaluate(() => new MutationObserver(() => {
    if (!window.__atReport && document.querySelector("#s-report.on")) window.__atReport = { complete: S.run.complete, stagesLeft: [...document.querySelectorAll("#stages li:not(.done)")].map((li) => li.dataset.k).join() };
  }).observe(document.querySelector("#s-report"), { attributes: true }));
  await page.click("#connect");
  // the report comes up once, after every scan and the last writing, so nothing changes while it is being read
  await page.waitForSelector("#s-report.on", { timeout: 300000 });
  assert.deepStrictEqual(await page.evaluate(() => window.__atReport), { complete: true, stagesLeft: "" }, "the report was shown before the work behind it finished");
  assert((await page.textContent("#bg-status")).includes("בוטלה"), "no word that access was revoked");
  const shownAt = await page.textContent("#rep-portrait");
  await page.evaluate(() => S.background);
  assert.strictEqual(await page.textContent("#rep-portrait"), shownAt, "the summary changed after the report came up");
  // a final result that moves rows and changes a value: answers follow their row, and the changed row's answer is dropped
  const remap = await page.evaluate(() => {
    const original = S.result;
    const idOf = (res, key) => { for (const [gi, g] of res.groups.entries()) for (const [pi, p] of g.params.entries()) if (p.key === key) return `${gi}.${pi}`; };
    S.verdicts = { [idOf(original, "city")]: { verdict: "correct" }, [idOf(original, "bank")]: { verdict: "wrong", note: "n" }, [idOf(original, "pension")]: { verdict: "correct" } };
    S.hidden = new Set([idOf(original, "pension")]);
    S.noteOpen = new Set();
    const final = JSON.parse(JSON.stringify(original));
    final.groups.reverse();
    final.groups.flatMap((g) => g.params).find((p) => p.key === "bank").v = "ערך חדש";
    applyFinal(final);
    const out = { city: S.verdicts[idOf(final, "city")], bank: S.verdicts[idOf(final, "bank")], hidden: S.hidden.has(idOf(final, "pension")),
                  changed: S.reportChanged, shown: document.querySelector("#rep-groups").textContent.includes("ערך חדש") };
    S.verdicts = {}; S.hidden = null; S.noteOpen = null; S.reportChanged = false;
    S.result = original;
    renderReport();
    return out;
  });
  assert.deepStrictEqual(remap, { city: { verdict: "correct" }, bank: { note: "n" }, hidden: true, changed: true, shown: true }, "the final report was not applied");
  assert.strictEqual(await page.evaluate(() => window.__revoked), "tok", "access was not revoked");
  assert.strictEqual(promoRead, 0, "a promotion was read");
  const run = await page.evaluate(() => S.run);
  const inScope = rows.filter((x) => !x.promo).length;
  assert.strictEqual(run.messages, inScope, "not every mail was accounted for");
  assert.strictEqual(run.reads, gets - 1, "reads count"); // one rate-limit hit is retried
  assert(gets < inScope / 2, `opened ${gets} of ${inScope}: the point is not to open each mail`);
  const report = await page.evaluate(() => Object.fromEntries(S.result.groups.flatMap((g) => g.params).map((p) => [p.key, p])));
  if (!fs.existsSync(rowsFile)) {
    assert.notStrictEqual(report.legal.v, 0, "the legal mail found by search was missed");
    assert.strictEqual(typeof report.credit_report.v !== "undefined", true, "no credit report row");
    assert.ok(report.addressed_to, "no addressed-to row");
    // read mail: the city, the employer, destinations and a clean link, and nothing else from the text
    const all = await page.evaluate(() => JSON.stringify(S.result));
    assert.strictEqual(report.city.v, "חיפה", "city from the contract: " + JSON.stringify(report.city));
    assert.strictEqual(report.employer.v, "חברת דוגמה", "employer from the payslips");
    assert.ok(String(report.destinations.v).includes("אתונה"), "flight destination");
    assert.strictEqual(report.platform_linkedin.link, "https://www.linkedin.com/in/test-owner", "own profile link");
    assert.strictEqual(await page.locator('#rep-groups a[href="https://www.linkedin.com/in/test-owner"]').count(), 1, "the link is not on the page");
    assert.strictEqual(await page.evaluate(() => S.run.pdf_read), 1, "the PDF was not read");
    // the web and registries: only the participant's own name goes out, and a court page never comes back
    if (mode === "full") {
      assert.strictEqual(searches.length, 1, "web search calls");
      assert(!searches[0].includes(HH_NAME) && !registryCalls.some((u) => decodeURIComponent(u).includes(HH_NAME)), "a household member was searched");
      assert.ok(report.web_mentions.links.some((l) => l.url === "https://news-example.co.il/a"), "web mention");
      assert(!/psakdin|other-example/.test(JSON.stringify(report.web_mentions)), "court or unrelated result in the report");
      assert.ok(String(report.companies_registry.v).includes("515"), "company registry");
      assert.strictEqual(report.platform_github.link, "https://github.com/test-owner-gh", "a profile found by web search");
      assert.ok(report.platform_github.note.includes("מישהו אחר"), "must say it may be someone else");
      // the paragraph is added above the report; it says what the rows say and nothing about who the person is
      const para = await page.evaluate(() => portraitText());
      for (const bit of ["חברת דוגמה", "80%", "campus-example.ac.il", "חוזים והסכמים", "אלופת ישראל בקרוספיט", "עדכון כתובת מגורים", "יש משכנתא", "רכישת נכס", "אין בתיבה בעיות תשלום"]) assert(para.includes(bit), `paragraph lacks ${bit}: ${para}`);
      assert(!/דקדקן|יסודי|אמין|אחראי|מומלץ/.test(para), "an opinion in the paragraph: " + para);
      assert(!/הוראת קבע|מיילים על|סטרימינג/.test(para), "the dull or the descriptive in the paragraph: " + para);
      console.log("paragraph:", para);
      assert(!/נטפרי|netfree/i.test(await page.evaluate(() => JSON.stringify([S.result.groups, S.result.suppliers, S.result.unknown, S.result.ai_input]))), "a filtering provider reveals religious observance");
      assert.strictEqual(await page.locator("#rep-groups .group").count() > 3, true, "the report rows must stay under the paragraph");
    } else {
      assert.strictEqual(searches.length + registryCalls.length, 0, "the name went out with the box unticked");
      assert.strictEqual(aiCalls.length, 0, "subjects went to the AI with the box unticked");
      assert.strictEqual(report.web_mentions, undefined, "web rows with the box unticked");
    }
    for (const leak of ["הרצל", "secrettoken", "other-person", "12345", "אילת", "seat"]) assert(!all.includes(leak), "from the mail's text: " + leak);
    assert.ok(report.reply_time.v.includes("30"), "reply time: " + report.reply_time.v);
    assert.strictEqual(report.reply_time.private, false, "a bonus row must not be asked in the private mode");
    assert.strictEqual(report.job_search.n, 1, "job search count");
    assert.ok(String(report.subscriptions.v).includes("saasco.io"), "recurring charges from an unknown sender: " + JSON.stringify(report.subscriptions) + " unknown:" + JSON.stringify(await page.evaluate(() => S.result.stats.by_class)));
    assert.ok(String(report.active_hours.v).includes(":00"), "active hours");
    assert.ok(/%$/.test(report.promo_share.v), "promotion share");
    assert.strictEqual(await page.locator("#rep-hero, .tile").count(), 0, "the numbers card on top is gone; the mailbox gets one line in the summary");
    // the fixed facts that open the summary: one to a line, said either way, and silent where there is nothing to judge by
    const facts = await page.evaluate(() => factLines().map((l) => l.text));
    assert.deepStrictEqual(facts, ["תיבת מייל פעילה.", "תשלום סדיר לספק אחד, חצי שנה ומעלה, ויש בתיבה אישורים על הוראות קבע.", "אין בתיבה בעיות תשלום מהותיות.",
      "לא נפתחו מחלוקות: לא נשלחו מהתיבה ערעורים או תלונות.", "יש בתיבה הודעות על הליך משפטי, הוצאה לפועל או עיקול."], "the fixed facts");
    assert.strictEqual(await page.locator("#rep-portrait .p-line").first().locator("p").count(), facts.length, "each fixed fact gets its own line");
    assert.strictEqual(report.interest_travel?.n, 4, "the travel interest must count promotions too");
    assert.strictEqual(report.interest_travel?.private, false, "an interest must not be asked in the private mode");
    const suppliers = await page.evaluate(() => S.result.suppliers);
    assert(suppliers.some((x) => /בזק/.test(x.org_he) && x.months > 0), "the supplier table is missing the bills: " + JSON.stringify(suppliers));
    assert((await page.textContent("#supplier-rows")).includes("בזק"), "the supplier table was not drawn");
    assert(/בזק/.test(String(report.utility_accounts.v)), "the bills found by search were missed: " + report.utility_accounts.v);
    const shop = (await page.evaluate(() => S.result.unknown)).find((u) => u.domain === "shop-example.co.il");
    assert.strictEqual(shop?.count, 3, "an unknown sender's mail was not all counted");
  }
  console.log(`${mode}: ${gets} opened, ${lists} lists, for ${inScope} mails`);
  await shot("2-report");
  assert(!FORBIDDEN.test(await page.evaluate(() => JSON.stringify(S.result.groups) + document.body.textContent)), "purpose word in the report");

  // sharing the report is the default; the other way is a small link below it
  assert.strictEqual(await page.locator("#s-choose").count(), 0, "the choice screen is back");
  await page.click('#s-report [data-mode="full"]');
  await page.waitForSelector("#s-review.on");
  if (mode === "private") {
    await shot("3-other-way");
    await page.click('#s-review [data-mode="private"]');
    await page.waitForSelector("#s-check.on");
  }

  const total = await page.evaluate(() => S.result.groups.reduce((a, g) => a + g.params.length, 0));
  if (mode === "private") {
    // answer: "city" wrong with a kind, "legal" wrong, one row skipped, everything else correct
    const total = await page.evaluate(() => S.checkList.length);
    for (let i = 0; i < total; i++) {
      const key = await page.evaluate(() => param(S.checkList[S.checkAt]).key);
      if (i === 0) await shot("4-check");
      if (key === "city") {
        await page.click('[data-verdict="wrong"]');
        await shot("5-check-wrong");
        await page.click('[data-kind="inaccurate"]');
      } else if (key === "legal") {
        await page.click('[data-verdict="wrong"]');
      } else if (key === "loans") {
        await page.click("#chk-skip");
      } else {
        await page.click('[data-verdict="correct"]');
      }
    }
  } else {
    // the report itself: black out one row, open a sensitive one, answer and comment on the row
    await page.waitForSelector("#s-review.on");
    const ids = await page.evaluate(() => Object.fromEntries(S.result.groups.flatMap((g, gi) => g.params.map((p, pi) => [p.key, `${gi}.${pi}`]))));
    const row = (k) => `.rv-row[data-id="${ids[k]}"]`;
    const shown = (k) => page.isChecked(`${row(k)} [data-show]`);
    for (const k of Object.keys(ids)) assert(await shown(k), "every row must start visible: " + k);
    assert.strictEqual(await page.evaluate(() => S.hidden.size), 0, "something starts hidden");
    await shot("4-review");
    const secret = await page.evaluate((id) => valText(param(id)), ids.longest_supplier);
    assert((await page.textContent("#rev-groups")).includes(secret), "row value should be on the screen");
    await page.uncheck(`${row("longest_supplier")} [data-show]`);
    assert(!(await page.textContent("#rev-groups")).includes(secret), "a blacked-out value is still on the page");
    // the AI sentences: only cleaned subjects went out, opinions are dropped, and each has its own V
    await page.waitForFunction(() => document.querySelector("#rev-portrait .portrait-top")?.textContent.includes("עבודה בהיקף חלקי"), null, { timeout: 120000 });
    await page.evaluate(() => S.background); // the second, deeper reading runs after the scan
    assert.strictEqual(aiCalls.length, 2, "AI calls: the report's first reading and the deep one");
    assert(!JSON.parse(aiCalls[0]).deep && JSON.parse(aiCalls[1]).deep === true, "only the second reading is deep");
    assert.strictEqual(await page.evaluate(() => S.result.groups.filter((g) => g.title === AI_SUMMARY).length), 1, "the deep reading replaces the conclusions, not adds to them");
    for (const secret of [OWNER_HE, HH_NAME, ME, "123456789", "me@x.com", "partner@example.com"]) assert(!aiCalls.join(" ").includes(secret), "leaked to AI: " + secret);
    assert(aiCalls[0].includes("נסח טאבו"), "subjects must reach the AI");
    assert(!/[0-9]/.test(JSON.stringify(JSON.parse(aiCalls[0]).items.filter((x) => x[0]).map((x) => x[2]))), "digits in a subject sent to AI");
    // the top of the report: conclusions by topic, the workplace, and real links
    const top = await page.textContent("#rev-portrait .portrait-top");
    assert(top.includes("עבודה בהיקף חלקי") && top.includes("התאגדה ב-2005"), "the conclusions on top: " + top);
    // the mailbox line opens the conclusions, never goes to the AI, and goes down with the row it rests on
    assert(top.trim().startsWith("עובדות") && top.includes("תיבת מייל פעילה"), "the fixed facts on top: " + top);
    assert(!/תיבת מייל|יש בתיבה הודעות על הליך|לא נפתחו מחלוקות/.test(aiCalls.join(" ")), "a line that is the person's own business went to the AI");
    await page.uncheck(`${row("sent_per_week")} [data-show]`);
    assert(!(await page.textContent("#rev-portrait .portrait-top")).includes("תיבת מייל"), "the mailbox line outlived its row");
    await page.check(`${row("sent_per_week")} [data-show]`);
    const hrefs = await page.$$eval("#rev-portrait .portrait-links a", (a) => a.map((x) => x.href));
    assert(hrefs.includes("https://www.dugma-example.co.il/"), "the employer's site: " + hrefs);
    assert(hrefs.includes("https://il.linkedin.com/company/dugma-example"), "the employer's LinkedIn: " + hrefs);
    assert(hrefs.some((h) => h.includes("github.com/test-owner-gh")), "the participant's network link: " + hrefs);
    assert.strictEqual(employerSearches.length, 1, "employer searches");
    assert.strictEqual(await page.evaluate(() => bestProfile([{ url: "a", text: "דנה כהן - Analyst" }, { url: "b", text: "דנה כהן at חברת דוגמה" }], "חברת דוגמה")), "b", "the profile that mentions the workplace");
    assert.strictEqual(await page.evaluate(() => hasAllWords("Dana Cohen‏ - ‏Data Engineer", "Dana Cohen")), true, "direction marks in a title");
    assert(!/maccabi|friend@/.test(aiCalls.join(" ")), "an excluded or personal sender went to AI");
    assert(!(await page.textContent("#rev-portrait")).includes("אמין"), "an opinion from the AI reached the page");
    assert.strictEqual(await page.evaluate(() => S.ai.length), 1, "only the valid AI sentence stays");
    // blacking out a row takes the conclusion built on it, so it can't come back through the AI
    await page.uncheck(`${row("job_scope")} [data-show]`);
    assert(!(await page.textContent("#rev-portrait .portrait-top")).includes("עבודה בהיקף חלקי"), "a conclusion outlived its row");
    await page.check(`${row("job_scope")} [data-show]`);
    await page.evaluate(() => { const r = rowsOf(AI_SUMMARY)[0]; S.hidden.delete(r.id); refreshRow(r.id); });
    await page.uncheck(`[data-id="${await page.evaluate(() => { const gi = S.result.groups.findIndex((g) => g.title === AI_GROUP); return gi + ".0"; })}"] [data-show]`);
    assert(!(await page.textContent("#rev-portrait")).includes("ומעבר מגורים באותה"), "a struck AI sentence is still in the paragraph");
    await page.check(`[data-id="${await page.evaluate(() => { const gi = S.result.groups.findIndex((g) => g.title === AI_GROUP); return gi + ".0"; })}"] [data-show]`);
    // a row blacked out takes its sentence out of the paragraph
    await page.uncheck(`${row("job_scope")} [data-show]`);
    assert(!(await page.textContent("#rev-portrait")).includes("80%"), "a blacked-out row is still in the paragraph");
    // rows that say something by name alone leave no trace when blacked out
    for (const k of ["interest_travel", "platform_facebook", "household_accounts"]) await page.uncheck(`${row(k)} [data-show]`);
    await page.click(`${row("legal")} [data-rv="wrong"]`);
    await page.click(`${row("legal")} [data-rk="invented"]`);
    await page.click(`${row("city")} [data-rv="wrong"]`);
    await page.click(`${row("city")} [data-rk="inaccurate"]`);
    await page.click(`${row("city")} [data-note-open]`);
    await page.fill(`${row("city")} [data-note]`, "הערה לבדיקה");
    await page.click(`${row("longest_supplier")} [data-note-open]`);
    await page.fill(`${row("longest_supplier")} [data-note]`, "הערה על שורה מושחרת");
    await page.click(`${row("mailbox_age")} [data-note-open]`);
    await page.fill(`${row("mailbox_age")} [data-note]`, "רק הערה, בלי תשובה");
    for (const k of Object.keys(ids)) {
      if (["city", "legal", "loans", "mailbox_age"].includes(k)) continue;
      if (await page.isVisible(`${row(k)} [data-rv="correct"]`)) await page.click(`${row(k)} [data-rv="correct"]`);
    }
    await shot("5-review-done");
    await page.click('#s-review [data-go="s-questions"]');
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
  assert.strictEqual(fb.stats.skipped_promotions, rows.filter((x) => x.promo).length, "skipped count");
  assert.strictEqual(fb.verdicts.find((v) => v.key === "loans"), undefined, "skipped row was sent");
  const city = fb.verdicts.find((v) => v.key === "city");
  const legal = fb.verdicts.find((v) => v.key === "legal");
  assert.strictEqual(city.kind, "inaccurate");

  if (mode === "private") {
    // exact field allow-list, then a search of the whole file for anything taken from the report
    for (const v of fb.verdicts) {
      assert(!("value" in v) && !("note" in v), "value or note in a private verdict: " + v.key);
      assert(!["household_accounts"].includes(v.key) && !/^(platform|interest)_/.test(v.key), "conditional row sent: " + v.key);
      assert(!["reply_time", "job_search", "subscriptions", "unread"].includes(v.key), "bonus row sent: " + v.key);
    }
    assert.deepStrictEqual(Object.keys(legal).sort(), ["key", "label", "verdict"], "a sensitive row carries more than the answer");
    assert.strictEqual(fb.unknown_senders.length, 0, "unknown senders must start unticked");
    assert(!("report" in fb), "a report in a private file");
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
    // what was blacked out is not in the file at all, while its answer and comment are
    const params = result.groups.flatMap((g) => g.params);
    const hiddenValue = String(params.find((p) => p.key === "longest_supplier").v);
    assert(!text.includes(hiddenValue), "blacked-out value in the file: " + hiddenValue);
    assert(fb.report.portrait.includes("חברת דוגמה") && !fb.report.portrait.includes("80%"), "the paragraph sent: " + fb.report.portrait);
    const repRows = fb.report.groups.flatMap((g) => g.rows);
    const hiddenRow = repRows.find((r) => r.key === "longest_supplier");
    assert(hiddenRow.hidden && !("value" in hiddenRow) && !("evidence" in hiddenRow), "a blacked-out row carries more than its name");
    const hv = fb.verdicts.find((v) => v.key === "longest_supplier");
    assert(hv.hidden && hv.note === "הערה על שורה מושחרת" && !("value" in hv), "the answer on a blacked-out row");
    assert.strictEqual(fb.verdicts.find((v) => v.key === "mailbox_age").verdict, "comment", "a comment without an answer");
    assert.strictEqual(repRows.find((r) => r.key === "city").value, String(params.find((p) => p.key === "city").v ?? params.find((p) => p.key === "city").why), "a visible row must carry its value");
    assert(repRows.find((r) => r.key === "legal")?.value, "a visible sensitive row must carry its value");
    assert(repRows.find((r) => r.key === "job_search"), "a visible finding must be in the report");
    // rows that say something by name alone are gone entirely once blacked out
    const dropped = ["interest_travel", "platform_facebook", "household_accounts"];
    assert(!repRows.some((r) => dropped.includes(r.key)), "a conditional row was sent while blacked out");
    assert(!fb.verdicts.some((v) => dropped.includes(v.key)), "a conditional answer was sent while blacked out");
    assert(repRows.find((r) => r.key === "platform_linkedin")?.value.includes("linkedin.com/in/test-owner"), "the profile link is not in the report");
    assert(!text.includes(HH_NAME), "household name in the file");
    assert(!text.includes("booking.com"), "a blacked-out interest shows through the unknown senders");
    // the mail: readable, carries what's visible, and escapes whatever it was sent
    const gs = fs.readFileSync(path.join(__dirname, "../tools/send_feedback.gs"), "utf8");
    const html = require("vm").runInNewContext(`${gs};renderMail(d)`, { d: { ...fb, from: "<img src=x>" }, MailApp: {}, ContentService: {} });
    assert(html.includes("&lt;img") && !html.includes("<img"), "the mail does not escape");
    assert(html.includes("הערה לבדיקה") && !html.includes(hiddenValue), "the mail content");
    fs.writeFileSync(path.join(SHOTS, "mail-full.html"), `<!doctype html><meta charset="utf-8">${html}`);
    const mailPage = await ctx.newPage();
    await mailPage.goto("file://" + path.resolve(SHOTS, "mail-full.html"));
    await mailPage.screenshot({ path: path.join(SHOTS, "mail-full.png"), fullPage: true });
    await mailPage.close();
    fs.writeFileSync(path.join(SHOTS, "feedback-full.json"), text);
    console.log(`full: ${fb.verdicts.length} answers of ${total} rows, ${repRows.filter((r) => r.hidden).length} rows blacked out, value absent from file and mail`);
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
