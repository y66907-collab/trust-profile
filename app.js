// imtrustme pilot: Gmail envelopes -> engine in the browser -> participant checks each row -> participant presses send.
// Network calls: Google sign-in, the Gmail API (read envelopes, then revoke), the CDN for the engine, and the send button.
"use strict";

const CFG = window.IMTRUSTME;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly"; // search needs it: gmail.metadata refuses the q parameter
// Gmail's budget per person is 6,000 units a minute. A read costs 20 and a list of up to 500 ids costs 5
const READ_UNITS = 20, LIST_UNITS = 5, UNIT_MS = 11; // 11 ms a unit keeps just under the budget
const PERSONAL_DOMAINS = ["gmail.com", "walla.co.il", "walla.com", "hotmail.com", "outlook.com", "yahoo.com", "012.net.il",
  "netvision.net.il", "bezeqint.net", "013net.net", "icloud.com", "live.com", "googlemail.com"]; // same list as engine.py
const PLATFORM_DOMAINS = ["linkedin.com", "facebookmail.com", "facebook.com", "instagram.com", "mail.instagram.com", "github.com"]; // pilot.py
// Interests come from a closed list of everyday senders, counted by address alone. Nothing that can reveal religion, health,
// politics or community goes on it (so no news or newsletters): product rule 3
const INTERESTS = [
  { key: "fitness", label: "כושר וספורט", domains: ["crossfit.com", "trainheroic.com", "myprotein.com", "strava.com", "garmin.com"] },
  { key: "tech", label: "טכנולוגיה ו-AI", domains: ["github.com", "supabase.com", "vercel.com", "anthropic.com", "openai.com", "bubble.io", "pipedream.com", "zoom.us", "cursor.com"] },
  { key: "career", label: "קריירה וחיפוש עבודה", domains: ["greenhouse-mail.io", "comeet.co", "lever.co", "workablemail.com", "alljobs.co.il", "drushim.co.il", "glassdoor.com"] },
  { key: "travel", label: "נסיעות וטיסות", domains: ["booking.com", "airbnb.com", "ryanair.com", "elal.co.il", "skygini.com", "skyscanner.com", "issta.co.il", "wizzair.com", "easyjet.com", "expedia.com", "agoda.com"] },
  { key: "shopping", label: "קניות אונליין", domains: ["amazon.com", "aliexpress.com", "ebay.com", "ksp.co.il", "ivory.co.il", "shein.com", "next.co.il", "email.apple.com", "samsung.com"] },
  { key: "entertainment", label: "מוזיקה וסטרימינג", domains: ["netflix.com", "spotify.com", "disneyplus.com", "apple.com"] },
  { key: "cards", label: "כרטיסי אשראי", domains: ["cal-online.co.il", "max.co.il", "isracard.co.il", "americanexpress.co.il"] },
  { key: "insurance", label: "ביטוח", domains: ["menora.co.il", "harel-ins.co.il", "migdal.co.il", "clalbit.co.il", "fnx.co.il", "ayalon-ins.co.il", "wobi.co.il"] },
  { key: "tools", label: "כלים דיגיטליים", domains: ["canva.com", "figma.com", "notion.so", "slack.com", "atlassian.com", "dropbox.com", "adobe.com", "mailsuite.com", "mailtrack.io", "linkedin.com"] },
];
// Findings a person finds interesting about themselves. Each is a count of subjects: the search returns ids, nothing is opened
const LIFE_QUERIES = {
  job_search: "subject:(ראיון OR משרה OR מועמדות OR \"קורות חיים\" OR interview OR candidate OR application)",
  flights: "subject:(טיסה OR \"boarding pass\" OR itinerary OR \"כרטיס טיסה\")",
  orders: "subject:(\"ההזמנה שלך\" OR \"your order\" OR משלוח OR shipped OR \"order confirmation\")",
  learning: "subject:(קורס OR כנס OR הרצאה OR webinar OR conference OR meetup OR course)",
  contracts: "subject:(חוזה OR הסכם OR contract OR agreement)",
  disputes: "in:sent subject:(ערעור OR השגה OR תלונה OR complaint)",
  thanks: "from:gmail.com subject:תודה",
  security: "subject:(\"התראת אבטחה\" OR \"security alert\" OR \"new sign-in\" OR \"כניסה חדשה\")",
  documents: "subject:(תלוש OR \"טופס 106\" OR \"אישור הכנסה\" OR payslip)",
};
const RECEIPT_QUERY = "subject:(קבלה OR חשבונית OR receipt OR invoice OR subscription OR מנוי OR renewal)";
// One search for each report row that reads a mail's wording. Whatever comes back is opened, and pilot.py decides on the real subject
const SIGNAL_QUERIES = [
  'subject:"כתב תביעה"', 'subject:"תביעה קטנה"', 'subject:"בית משפט"', 'subject:"בית המשפט"', 'subject:"הוצאה לפועל"',
  'subject:"רשות האכיפה"', "subject:עיקול", "subject:chargeback", 'subject:"הכחשת עסקה"',
  'subject:"חשבון מוגבל"', 'subject:"שיק חוזר"', 'subject:"שיקים חוזרים"', 'subject:"חריגה ממסגרת"', 'subject:"הגבלת חשבון"', 'subject:"התראה לפני הגבלה"',
  'subject:"הסכם הלוואה"', 'subject:"נתוני אשראי"', 'subject:"דוח אשראי"', 'subject:"דירוג אשראי"', "subject:BDI", 'subject:"שינוי כתובת מגורים"', "subject:משכנתא",
  'subject:"תלוש שכר"', 'subject:"תלוש משכורת"', 'subject:"תלוש לחודש"', "subject:payslip",
  "subject:(רבעוני OR תקופתי OR שנתי) subject:(פנסיה OR גמל OR השתלמות)",
];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const S = { owner: null, token: null, result: null, run: {}, mode: null, verdicts: {}, checkList: [], checkAt: 0 };

// ---------------------------------------------------------------- navigation
function go(id) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  const step = +$("#" + id).dataset.step;
  $$("#steps li").forEach((li, i) => li.classList.toggle("on", i < step));
  window.scrollTo({ top: 0, behavior: "instant" });
  const h = $("#" + id + " h1");
  if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) go(b.dataset.go);
});
$$(".to-name").forEach((el) => (el.textContent = CFG.feedbackTo));
$("#yrs").textContent = CFG.years;
$("#app-name").textContent = CFG.appName;

// ---------------------------------------------------------------- engine (starts downloading now)
const worker = new Worker("worker.js");
let engineReady = false, engineErr = null;
const engineWaiters = [];
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "ready") { engineReady = true; engineWaiters.splice(0).forEach((f) => f()); }
  else if (m.type === "error") { engineErr = m.error; engineWaiters.splice(0).forEach((f) => f()); S.onEngine?.(null, m.error); }
  else if (m.type === "result") S.onEngine?.(m.result);
};
const whenEngine = () => (engineReady || engineErr ? Promise.resolve() : new Promise((r) => engineWaiters.push(r)));

// ---------------------------------------------------------------- details
$("#has-hh").addEventListener("change", (e) => ($("#hh-wrap").hidden = !e.target.checked));
$("#details-next").addEventListener("click", () => {
  const he = $("#name-he").value.trim().replace(/\s+/g, " ");
  if (he.split(" ").length < 2) { $("#name-err").hidden = false; $("#name-he").focus(); return; }
  $("#name-err").hidden = true;
  const hh = $("#has-hh").checked && $("#hh-name").value.trim();
  S.owner = { name_he: he, name_en: $("#name-en").value.trim() || null, household: hh ? { name: hh.replace(/\s+/g, " ") } : null };
  $("#fb-from").value = he.split(" ")[0];
  go("s-connect");
});

// ---------------------------------------------------------------- connect
$("#connect").addEventListener("click", () => {
  const err = $("#connect-err");
  err.hidden = true;
  if (!window.google?.accounts?.oauth2) { err.textContent = "החלון של Google עוד לא נטען. אפשר לנסות שוב בעוד רגע."; err.hidden = false; return; }
  if (CFG.googleClientId.startsWith("PASTE")) { err.textContent = "הדף עוד לא מחובר ל-Google (חסר מזהה בקובץ config.js)."; err.hidden = false; return; }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CFG.googleClientId,
    scope: SCOPE,
    callback: (t) => {
      if (t.error || !google.accounts.oauth2.hasGrantedAllScopes(t, SCOPE)) {
        err.textContent = "לא התקבלה ההרשאה. אפשר לנסות שוב, ולסמן את ההרשאה בחלון של Google.";
        err.hidden = false;
        return;
      }
      S.token = t.access_token;
      readMailbox().catch(fail);
    },
    error_callback: (e) => {
      err.textContent = e.type === "popup_closed" ? "החלון של Google נסגר. אפשר לנסות שוב." : "החלון של Google לא נפתח. אולי חוסם חלונות קופצים?";
      err.hidden = false;
    },
  });
  client.requestAccessToken({ prompt: "consent" });
});

function fail(e) {
  console.error(e);
  const el = $("#run-err");
  el.textContent = "משהו נעצר: " + (e?.message || e) + ". אפשר לרענן את הדף ולנסות שוב. שום דבר לא נשמר.";
  el.hidden = false;
  revoke();
}

// ---------------------------------------------------------------- Gmail
// A rate limit never ends a run. All requests share one pace: when Gmail says slow down, everyone waits, and the
// pace recovers step by step. Only a real refusal, or Gmail silent for GIVE_UP_MS, stops the run.
const RATE_REASONS = ["rateLimitExceeded", "userRateLimitExceeded"];
const GIVE_UP_MS = 20 * 6e4;
const flow = { slow: 1, next: 0, hits: 0, lastOk: 0 }; // slow: how far below the budget Gmail has pushed us
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function slowDown(retryAfter) {
  if (Date.now() - flow.lastOk > GIVE_UP_MS) throw new Error("Gmail לא עונה כבר 20 דקות");
  flow.hits++;
  flow.slow = Math.min(8, flow.slow * 1.5);
  const pause = Math.max(Math.min(6e4, 1000 * 2 ** flow.hits), (+retryAfter || 0) * 1000) + Math.random() * 500;
  flow.next = Math.max(flow.next, Date.now() + pause);
}

async function gget(url, units = LIST_UNITS) {
  if (!flow.lastOk) flow.lastOk = Date.now();
  for (;;) {
    const now = Date.now(), at = Math.max(now, flow.next);
    flow.next = at + units * UNIT_MS * flow.slow;
    if (at > now) await sleep(at - now);
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: "Bearer " + S.token } });
    } catch { // offline for a moment, or the laptop slept
      slowDown();
      continue;
    }
    if (r.ok) {
      flow.lastOk = Date.now();
      flow.hits = 0;
      flow.slow = Math.max(1, flow.slow * 0.98);
      return r.json();
    }
    if (r.status === 401) {
      await renewAccess();
      flow.lastOk = Date.now();
      continue;
    }
    const reason = await r.clone().json().then((b) => b.error?.errors?.[0]?.reason || b.error?.status).catch(() => "");
    if (r.status === 429 || r.status >= 500 || (r.status === 403 && RATE_REASONS.includes(reason))) {
      slowDown(r.headers.get("Retry-After"));
      continue;
    }
    throw new Error("Gmail " + r.status + (reason ? " " + reason : ""));
  }
}

// Google access lasts about an hour. A long read asks for one click to continue: a window opened without a click is blocked.
let renewing = null;
function renewAccess() {
  renewing ||= new Promise((resolve, reject) => {
    const el = $("#run-err");
    el.textContent = "הגישה ל-Google פגה אחרי שעה. מה שנקרא עד עכשיו נשמר בדף. ";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = "להמשיך מאותו מקום";
    el.append(b);
    el.hidden = false;
    b.addEventListener("click", () => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId,
        scope: SCOPE,
        callback: (t) => {
          if (t.error) return reject(new Error("לא התקבלה הרשאה להמשיך"));
          S.token = t.access_token;
          el.hidden = true;
          el.textContent = "";
          renewing = null;
          resolve();
        },
      });
      client.requestAccessToken({ prompt: "" });
    });
  });
  return renewing;
}

const idTime = (id) => Number(BigInt("0x" + id) >> 20n); // a Gmail id carries its epoch ms in the top bits

function decodeWords(s) {
  // RFC 2047 encoded words, in case a header comes back undecoded
  return (s || "").replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=\s*(?==\?)?/g, (_, cs, enc, txt) => {
    try {
      let bytes;
      if (enc.toUpperCase() === "B") bytes = Uint8Array.from(atob(txt), (c) => c.charCodeAt(0));
      else {
        const t = txt.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(t, (c) => c.charCodeAt(0));
      }
      return new TextDecoder(cs).decode(bytes);
    } catch { return txt; }
  });
}
const addrOf = (s) => ((s || "").match(/[\w.+'-]+@[\w.-]+\.\w+/) || [""])[0].toLowerCase();
const nameOf = (s) => decodeWords((s || "").replace(/<[^>]*>/, "")).replace(/["']/g, "").trim();

function stage(k, state, n) {
  const li = $(`#stages [data-k="${k}"]`);
  li.classList.remove("now", "done");
  if (state) li.classList.add(state);
  if (n !== undefined) li.querySelector("[data-n]").textContent = n;
}
const bar = (f) => ($("#bar").style.width = Math.round(f * 100) + "%");
const fmtN = (n) => n.toLocaleString("he-IL");

async function readMailbox() {
  $("#connect-pre").hidden = true;
  $("#connect-run").hidden = false;
  window.onbeforeunload = () => true;

  const profile = await gget(API + "/profile");
  const own = profile.emailAddress.toLowerCase();
  const since = Date.now() - CFG.years * 365.25 * 864e5;
  const after = "after:" + new Date(since).toISOString().slice(0, 10).replace(/-/g, "/");

  // Every list comes back newest first, so a filtered list stops at the start of the period
  async function list(params) {
    const out = [];
    let token = "", inPeriod = true;
    do {
      const page = await gget(`${API}/messages?maxResults=500&${params}${token ? "&pageToken=" + token : ""}`, LIST_UNITS);
      for (const m of page.messages || []) {
        if (idTime(m.id) >= since) out.push(m);
        else inPeriod = false;
      }
      token = page.nextPageToken;
    } while (token && inPeriod);
    return out;
  }
  const search = (q) => list("q=" + encodeURIComponent(`${q} ${after}`));

  // 1. every id in the period (cheap). The oldest id gives the mailbox age
  stage("list", "now");
  const [promo, draft, sentIds] = await Promise.all(["CATEGORY_PROMOTIONS", "DRAFT", "SENT"].map((l) => list("labelIds=" + l)));
  const drop = new Set(promo.map((m) => m.id));
  const drafts = new Set(draft.map((m) => m.id));
  const pending = new Map(); // id -> thread: mail we can't yet say who sent
  let token = "", oldest = Infinity, skipped = 0;
  const perYear = {};
  do {
    const page = await gget(`${API}/messages?maxResults=500${token ? "&pageToken=" + token : ""}`, LIST_UNITS);
    for (const m of page.messages || []) {
      const t = idTime(m.id);
      if (t < oldest) oldest = t;
      if (t < since || drafts.has(m.id)) continue;
      const y = new Date(t).getFullYear();
      perYear[y] = (perYear[y] || 0) + 1;
      if (drop.has(m.id)) skipped++;
      else pending.set(m.id, m.threadId);
    }
    token = page.nextPageToken;
    stage("list", "now", fmtN(pending.size));
  } while (token);
  const total = pending.size;
  const threadOf = new Map(pending);
  stage("list", "done", fmtN(total));

  // 2. who sent what, by asking Gmail instead of opening each mail: a search costs what a quarter of a read costs and
  // answers for up to 500 mails, and each id already carries its date
  stage("read", "now");
  const t0 = performance.now();
  const rows = new Map();
  let reads = 0;
  const show = () => {
    const left = pending.size;
    stage("read", "now", `${fmtN(total - left)} / ${fmtN(total)}`);
    bar(0.08 + 0.82 * ((total - left) / (total || 1)));
    $("#eta").textContent = left ? "עוד כמה דקות" : "עוד רגע";
  };
  function place(m, fields) {
    if (!threadOf.has(m.id)) return null; // a promotion or a draft
    pending.delete(m.id);
    const row = rows.get(m.id) || { thread: threadOf.get(m.id), id: m.id, ts: idTime(m.id), from: "", to: "", subject: "", sent: false };
    rows.set(m.id, row);
    return Object.assign(row, fields);
  }
  const pool = async (items, size, fn) => {
    const q = items.slice();
    await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
  };
  const headers = ["From", "To", "Subject"].map((h) => "&metadataHeaders=" + h).join("");
  const opened = new Set(), senderName = new Map();
  let sentChecked = 0;
  async function open(id) {
    if (opened.has(id) || !threadOf.has(id)) return null;
    opened.add(id);
    const g = await gget(`${API}/messages/${id}?format=metadata${headers}`, READ_UNITS);
    reads++;
    const h = Object.fromEntries((g.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    const sent = (g.labelIds || []).includes("SENT");
    if (sent && addrOf(h.from) === own) {
      sentChecked++;
      const nm = nameOf(h.from);
      if (nm) senderName.set(nm, (senderName.get(nm) || 0) + 1);
    }
    const row = place({ id }, { from: addrOf(h.from), to: addrOf(h.to), subject: decodeWords(h.subject || "").replace(/[\t\r\n]+/g, " "), sent, real: true });
    show();
    return row;
  }

  sentIds.forEach((m) => place(m, { from: own, sent: true }));
  show();

  const [senders, labels] = await Promise.all(["senders", "labels"].map((f) => fetch(`engine/${f}.json`).then((r) => r.json())));
  const known = [...new Set([...Object.keys(senders), ...labels.map((l) => l.domain), ...PLATFORM_DOMAINS])];

  // known companies: all their mail, and mail sent to them
  await pool(known, 8, async (d) => {
    (await search(`from:${d}`)).forEach((m) => { const r = place(m, {}); if (r && !r.real && !r.sent) r.from = "x@" + d; });
    (await search(`to:${d} in:sent`)).forEach((m) => { const r = place(m, {}); if (r && !r.real) r.to = "x@" + d; });
    show();
  });
  // interests: promotions count here, since they are what shows what someone follows. Only the sender and the date are used
  const interests = [];
  await pool(INTERESTS.flatMap((t) => t.domains.map((d) => [t, d])), 8, async ([t, d]) => {
    const found = await search(`from:${d}`);
    if (found.length) interests.push({ key: t.key, label: t.label, domain: d, n: found.length,
      first: Math.min(...found.map((m) => idTime(m.id))), last: Math.max(...found.map((m) => idTime(m.id))) });
  });
  // habits come from the timestamp inside each id, so none of this opens a mail. No weekday on purpose: a day without
  // mail can point to religious observance (product rule 3)
  const hourCount = new Array(24).fill(0);
  sentIds.forEach((m) => hourCount[new Date(idTime(m.id)).getHours()]++);
  let activeFrom = 0, activeBest = -1;
  for (let h = 0; h < 24; h++) {
    const c = [0, 1, 2, 3].reduce((a, k) => a + hourCount[(h + k) % 24], 0);
    if (c > activeBest) { activeBest = c; activeFrom = h; }
  }
  const sentSet = new Set(sentIds.map((m) => m.id)), threads = new Map();
  threadOf.forEach((th, id) => { if (!threads.has(th)) threads.set(th, []); threads.get(th).push(id); });
  const waits = [];
  threads.forEach((ids) => {
    ids.sort((a, b) => idTime(a) - idTime(b));
    for (let i = 1; i < ids.length; i++) {
      const dt = idTime(ids[i]) - idTime(ids[i - 1]);
      if (sentSet.has(ids[i]) && !sentSet.has(ids[i - 1]) && dt < 14 * 864e5) waits.push(dt);
    }
  });
  waits.sort((a, b) => a - b);
  const [unreadIds, updatesIds, socialIds, forumsIds] = await Promise.all(["UNREAD", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"].map((l) => list("labelIds=" + l)));
  const life = {};
  await pool(Object.keys(LIFE_QUERIES), 8, async (k) => {
    const found = await search(LIFE_QUERIES[k]);
    life[k] = { n: found.length, years: [...new Set(found.map((m) => new Date(idTime(m.id)).getFullYear()))].sort() };
  });
  const receiptIds = (await search(RECEIPT_QUERY)).map((m) => m.id);
  const insights = {
    mailbox_total: profile.messagesTotal, per_year: perYear, promotions: skipped, unread: unreadIds.length,
    updates: updatesIds.length, social: socialIds.length, forums: forumsIds.length,
    in_period: Object.values(perYear).reduce((a, b) => a + b, 0), sent: sentIds.length, weeks: Math.max(1, (Date.now() - Math.max(since, oldest)) / (7 * 864e5)),
    active_from: sentIds.length >= 5 ? activeFrom : null, active_share: sentIds.length ? Math.round((100 * activeBest) / sentIds.length) : 0,
    reply_minutes: waits.length >= 5 ? Math.round(waits[Math.floor(waits.length / 2)] / 60000) : null, reply_n: waits.length, life,
  };
  // what kind of mail each is: the engine labels a mail by a phrase of its subject, so the phrase it was found by is enough.
  // Applied in the rules' order: first rule wins, as in the engine
  const hits = new Array(labels.length);
  await pool(labels.map((l, i) => [l, i]), 8, async ([l, i]) => { hits[i] = await search(`from:${l.domain} subject:"${l.match.replace(/"/g, "")}"`); });
  labels.forEach((l, i) => hits[i].forEach((m) => { const r = rows.get(m.id); if (r && !r.real && !r.subject) r.subject = l.match; }));
  // bills on the owner's name, or the household's
  const names = [S.owner.name_he, S.owner.name_he.split(" ").slice(1).concat(S.owner.name_he.split(" ")[0]).join(" "), S.owner.name_en, S.owner.household?.name].filter(Boolean);
  const named = new Map();
  await pool([...new Set(names)], 4, async (n) => { (await search(`subject:"${n.replace(/"/g, "")}"`)).forEach((m) => named.has(m.id) || named.set(m.id, n)); });
  // private mail stays out of the report: its count is all the engine needs
  await pool(PERSONAL_DOMAINS, 8, async (d) => {
    (await search(`from:${d}`)).forEach((m) => { const r = place(m, {}); if (r && !r.real && !r.sent) r.from = "x@" + d; });
    show();
  });
  // the rows that depend on exact wording are opened, so nothing here rests on a search alone
  const toOpen = new Set();
  await pool(SIGNAL_QUERIES, 8, async (q) => { (await search(q)).forEach((m) => toOpen.add(m.id)); });
  sentIds.slice(0, 5).forEach((m) => toOpen.add(m.id));
  await pool([...toOpen], 4, open);

  // the report: nothing below changes its rows, since every row rests on known companies or on the mail just opened
  stage("read", "done", fmtN(total - pending.size));
  stage("engine", "now");
  $("#eta").textContent = engineReady ? "" : "מטעינים את המנוע…";
  await whenEngine();
  if (engineErr) throw new Error("המנוע לא נטען (" + engineErr + ")");
  const today = new Date().toLocaleDateString("sv-SE");
  const mailbox_since = isFinite(oldest) ? new Date(oldest).toLocaleDateString("sv-SE") : null;
  const runEngine = () => {
    const out = [...rows.values()].map(({ real, ...r }) => (!real && named.has(r.id) ? { ...r, subject: `${r.subject} ${named.get(r.id)}`.trim() } : r));
    const account = [...senderName.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || "";
    const counted = out.length;
    return new Promise((res, rej) => {
      S.onEngine = (r, e) => (e ? rej(new Error(e)) : res(r));
      worker.postMessage({ type: "run", payload: { today, owner: S.owner, own_addresses: [profile.emailAddress], rows: out, account_name: account,
        sent_checked: sentChecked, mailbox_since, interests, insights, receipt_ids: receiptIds } });
    }).then((r) => ({ r, counted }));
  };
  const first = await runEngine();
  S.run = { messages: first.counted, listed: total, skipped_promotions: skipped, reads, complete: false, mailbox_since,
            report_seconds: Math.round((performance.now() - t0) / 1000) };
  S.result = first.r;
  stage("engine", "done");
  bar(1);
  renderReport();
  go("s-report");
  showBackground(total - pending.size, total);

  // everyone else, behind the report: open one mail, learn the sender, ask for all of theirs. Newest first, until no mail
  // is left unaccounted for. The final run replaces the report, so nothing is sent from a result that was only partial
  S.background = (async () => {
    try {
      const asked = new Set([...known, ...PERSONAL_DOMAINS]);
      const queue = [...pending.keys()].sort((x, y) => idTime(y) - idTime(x));
      await pool(Array.from({ length: 4 }), 4, async () => {
        while (queue.length) {
          const id = queue.shift();
          if (!pending.has(id)) continue;
          const row = await open(id);
          const d = row?.from.split("@")[1];
          if (d && !asked.has(d)) {
            asked.add(d);
            (await search(`from:${d}`)).forEach((m) => { const r = place(m, {}); if (r && !r.real && !r.sent) r.from = "x@" + d; });
          }
          showBackground(total - pending.size, total);
        }
      });
      const last = await runEngine();
      Object.assign(S.run, { messages: last.counted, reads, complete: true });
      applyFinal(last.r);
    } catch (e) {
      console.warn("background read stopped", e); // the report stands; the feedback says the count is partial
      S.run.reads = reads;
    }
    S.run.read_seconds = Math.round((performance.now() - t0) / 1000);
    await revoke();
    rows.clear(); // the envelopes are not kept once the profile exists
    window.onbeforeunload = null;
    showBackground();
  })();
}

function showBackground(done, total) {
  const el = $("#bg-status");
  el.hidden = false;
  el.textContent = total === undefined
    ? `הבדיקה הסתיימה, והגישה ל-Gmail בוטלה.${S.reportChanged ? " הדוח התעדכן לפי כל השולחים, ותשובות על שורות שהשתנו נמחקו. כדאי לעבור עליהן שוב." : ""}`
    : `ממשיכים לעבור על שאר השולחים (${fmtN(done)} מתוך ${fmtN(total)}). הדוח יכול עוד להתעדכן, ושום דבר לא יישלח לפני שזה נגמר.`;
}

// The final run replaces the report. Answers follow their row by its key, since rows can appear and move, and an answer
// on a value that has since changed is dropped: it was about something else
function applyFinal(r) {
  const index = (res) => {
    const m = new Map();
    res.groups.forEach((g, gi) => g.params.forEach((p, pi) => m.set(p.key, { id: `${gi}.${pi}`, p })));
    res.suppliers.forEach((x, i) => m.set(`s:${x.org_he}`, { id: `s${i}`, p: x }));
    res.minor.forEach((x, i) => m.set(`m:${x.org_he}:${x.first}`, { id: `m${i}`, p: x }));
    return m;
  };
  const before = index(S.result), after = index(r);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stay = S.checkList?.[S.checkAt], stayKey = stay && param(stay).key;
  let changed = before.size !== after.size;
  const verdicts = {}, hidden = new Set(), noteOpen = new Set();
  for (const [key, { id, p }] of before) {
    const n = after.get(key);
    if (!n) { changed = true; continue; }
    if (!same(p, n.p)) changed = true;
    const v = S.verdicts[id];
    if (v) {
      const kept = same(p.v, n.p.v) ? v : (v.note ? { note: v.note } : null);
      if (kept !== v) S.reportChanged = true;
      if (kept) verdicts[n.id] = kept;
    }
    if (S.hidden?.has(id)) hidden.add(n.id);
    if (S.noteOpen?.has(id)) noteOpen.add(n.id);
  }
  S.result = r;
  if (!changed) return;
  S.verdicts = verdicts;
  renderReport();
  if (S.hidden) {
    S.hidden = hidden;
    S.noteOpen = noteOpen;
  }
  if (S.mode) {
    S.checkList = [];
    S.result.groups.forEach((g, gi) => g.params.forEach((p, pi) => {
      if (!isPrivate() || p.private) S.checkList.push(`${gi}.${pi}`);
    }));
    const at = S.checkList.findIndex((id) => param(id).key === stayKey);
    S.checkAt = at < 0 ? 0 : at;
    if (isPrivate()) renderCheck(); else renderReview();
  }
}

async function revoke() {
  if (!S.token) return;
  const t = S.token;
  S.token = null;
  await new Promise((res) => { try { google.accounts.oauth2.revoke(t, res); } catch { res(); } setTimeout(res, 4000); });
}

// ---------------------------------------------------------------- report
const evLine = (p) => {
  if (p.v === null) return "";
  const bits = [];
  if (p.n === 0) bits.push("נבדקה כל התקופה, לא נמצא");
  else if (p.n) bits.push(`לפי ${fmtN(p.n)} מיילים`);
  if (p.span) bits.push(/^\d/.test(p.span) ? `<bdi dir="ltr">${esc(p.span)}</bdi>` : esc(p.span)); // dates read start to end
  if (p.note) bits.push(esc(p.note));
  return bits.join(" · "); // every bit is already escaped or fixed text
};
// The same line as plain text, for the mail. The isolates keep a date range in order inside Hebrew
const evText = (p) => {
  if (p.v === null) return "";
  const bits = [];
  if (p.n === 0) bits.push("נבדקה כל התקופה, לא נמצא");
  else if (p.n) bits.push(`לפי ${fmtN(p.n)} מיילים`);
  if (p.span) bits.push(/^\d/.test(p.span) ? `\u2066${p.span}\u2069` : p.span);
  if (p.note) bits.push(p.note);
  return bits.join(" · ");
};
const valText = (p) => (p.v === null ? p.why : p.v === 0 ? "0" : String(p.v));

const HERO = ["reply_time", "active_hours", "companies", "promo_share", "unread", "sent_per_week"];
function renderReport() {
  const r = S.result;
  $("#rep-name").textContent = S.owner.name_he;
  const d = r.today.split("-").reverse().join(".");
  const ymOf = (x) => x.slice(0, 7).split("-").reverse().join(".");
  const range = r.stats.date_range;
  $("#rep-meta").innerHTML = [["הופק", d], ["תקופה", range ? `<bdi dir="ltr">${esc(ymOf(range[0]))} – ${esc(ymOf(range[1]))}</bdi>` : "—"],
    ["מיילים בתקופה", fmtN(S.run.listed)]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  // The part people came for: the numbers about themselves, before the detail
  const byKey = Object.fromEntries(r.groups.flatMap((g) => g.params).map((p) => [p.key, p]));
  const tiles = HERO.map((k) => byKey[k]).filter((p) => p && p.outcome === "found");
  $("#rep-hero").hidden = !tiles.length;
  $("#hero-tiles").innerHTML = tiles.map((p) => `<div class="tile"><b>${esc(valText(p))}</b><span>${esc(p.label)}</span></div>`).join("");
  $("#rep-groups").innerHTML = r.groups.map((g) => `
    <div class="card group"><h2>${esc(g.title)}</h2>${g.params.map((p) => `<div class="row">
        <div class="lab">${esc(p.label)}</div>
        <div class="val ${p.v === null ? "none" : ""}">${esc(valText(p))}</div>
        <div class="ev">${evLine(p)}</div>
      </div>`).join("")}</div>`).join("");
  $("#rep-suppliers").hidden = !r.suppliers.length;
  $("#supplier-rows").innerHTML = r.suppliers.map((x) => `<tr><td>${esc(x.org_he)}</td><td><bdi dir="ltr">${esc(x.first)} – ${esc(x.last)}</bdi></td>
    <td>${x.months}</td><td>${x.active ? "פעיל" : "הסתיים"}</td><td>${esc(x.holder)}</td></tr>`).join("");
  $("#rep-minor").hidden = !r.minor.length;
  $("#minor-list").innerHTML = r.minor.map((m) =>
    `<li>${esc(m.org_he)}: ${m.n_in === 1 ? "הודעה אחת" : m.n_in + " הודעות"}, ${esc(m.first.split("-").reverse().join("."))}. נסגר.</li>`).join("");
}

// ---------------------------------------------------------------- what to share, then row by row
const param = (id) => { const [g, p] = id.split(".").map(Number); return S.result.groups[g].params[p]; };
const VERDICT_HE = { correct: "נכון", wrong: "לא נכון", unsure: "לא יודע/ת", comment: "הערה" };
const KIND_HE = { missed: "חסר משהו שקיים", invented: "כתוב משהו שלא קיים", inaccurate: "הפרטים לא מדויקים" };
const isPrivate = () => S.mode === "private";
// A sensitive row without the report gets a bare answer: "missing" on a legal row would say there is a legal case
const asksKind = (p) => !isPrivate() || p.detail;
const isHidden = (id) => !isPrivate() && !!S.hidden?.has(id);
const bare = (id) => isPrivate() || isHidden(id);

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  S.mode = b.dataset.mode;
  S.checkList = [];
  S.result.groups.forEach((g, gi) => g.params.forEach((p, pi) => {
    if (!isPrivate() || p.private) S.checkList.push(`${gi}.${pi}`);
  }));
  const open = S.checkList.findIndex((id) => !S.verdicts[id]);
  S.checkAt = open < 0 ? 0 : open;
  $("#q-back").dataset.go = isPrivate() ? "s-check" : "s-review";
  if (!isPrivate()) { renderReview(); go("s-review"); return; }
  renderCheck();
  go("s-check");
});

// ---------------------------------------------------------------- the report with redactions and comments
// A row that exists only for some people says something by its name alone, so blacking it out removes it completely
const dropsWhole = (id) => (/^[sm]/.test(id) ? true : !param(id).private);

function supplierText(x) { return `\u2066${x.first} – ${x.last}\u2069 · ${x.months} חודשים · ${x.active ? "פעיל" : "הסתיים"} · ${x.holder}`; }
function minorText(m) { return `${m.n_in === 1 ? "הודעה אחת" : m.n_in + " הודעות"}, ${m.first.split("-").reverse().join(".")}. נסגר.`; }

function reviewRow(id) {
  const hidden = S.hidden.has(id), v = S.verdicts[id] || {};
  const isParam = !/^[sm]/.test(id);
  const p = isParam ? param(id) : null;
  const item = id[0] === "s" ? S.result.suppliers[+id.slice(1)] : id[0] === "m" ? S.result.minor[+id.slice(1)] : null;
  const label = isParam ? p.label : item.org_he;
  const value = isParam ? valText(p) : id[0] === "s" ? supplierText(item) : minorText(item);
  const whole = dropsWhole(id);
  const chips = isParam && !(hidden && whole) ? ["correct", "wrong", "unsure"].map((k) =>
    `<button class="chip ${k === "wrong" ? "no" : ""} ${v.verdict === k ? "on" : ""}" data-rv="${k}">${VERDICT_HE[k]}</button>`).join("") : "";
  const kinds = isParam && v.verdict === "wrong" && (!hidden || p.detail) ? `<div class="rv-kinds">${Object.entries(KIND_HE).map(([k, t]) =>
    `<button class="chip ${v.kind === k ? "on" : ""}" data-rk="${k}">${t}</button>`).join("")}</div>` : "";
  const noteOpen = S.noteOpen.has(id) || v.note;
  const canNote = !(hidden && whole);
  return `<div class="rv-row ${hidden ? "is-hidden" : ""}" data-id="${id}">
    <label class="rv-v" title="לשתף את השורה"><input type="checkbox" data-show ${hidden ? "" : "checked"} aria-label="לשתף: ${esc(label)}"></label>
    <div class="rv-lab">${esc(label)}</div>
    <div class="rv-val ${isParam && p.v === null ? "none" : ""}">${hidden ? `<span class="redact" role="img" aria-label="מושחר"></span>` : esc(value)}</div>
    <div class="rv-ev">${hidden ? (whole ? "השורה הזו לא תישלח בכלל." : "יישלחו רק התשובה וההערה שלך, אם תוסיפו.") : isParam ? evLine(p) : ""}</div>
    ${chips || canNote ? `<div class="rv-act">${chips}${canNote ? `<button class="link" data-note-open>תגובה</button>` : ""}</div>` : ""}
    ${kinds}
    ${canNote && noteOpen ? `<textarea class="rv-note" data-note placeholder="תגובה ל${esc(CFG.feedbackTo)}">${esc(v.note || "")}</textarea>` : ""}
  </div>`;
}

function reviewCount() {
  const all = $$("#rev-groups .rv-row").length, off = S.hidden.size;
  $("#rev-count").textContent = `${all - off} גלויות · ${off} מושחרות`;
}
function renderReview() {
  S.hidden ??= new Set(); // everything starts visible; only what the participant unticks is left out
  S.noteOpen ??= new Set();
  const r = S.result;
  const card = (title, ids) => `<div class="card group"><h2>${esc(title)}</h2>${ids.map(reviewRow).join("")}</div>`;
  $("#rev-groups").innerHTML = r.groups.map((g, gi) => card(g.title, g.params.map((_, pi) => `${gi}.${pi}`))).join("") +
    (r.suppliers.length ? card("פירוט ספקים", r.suppliers.map((_, i) => `s${i}`)) : "") +
    (r.minor.length ? card("אירועי תשלום זניחים", r.minor.map((_, i) => `m${i}`)) : "");
  reviewCount();
}
function refreshRow(id) {
  $(`#rev-groups [data-id="${id}"]`).outerHTML = reviewRow(id);
  reviewCount();
}
function setNote(id, text) {
  const v = S.verdicts[id] || {};
  if (text) v.note = text; else delete v.note;
  if (v.verdict || v.note) S.verdicts[id] = v; else delete S.verdicts[id];
}
$("#s-review").addEventListener("change", (e) => {
  if (!e.target.matches("[data-show]")) return;
  const id = e.target.closest("[data-id]").dataset.id;
  if (e.target.checked) S.hidden.delete(id); else S.hidden.add(id);
  refreshRow(id);
});
$("#s-review").addEventListener("input", (e) => {
  if (e.target.matches("[data-note]")) setNote(e.target.closest("[data-id]").dataset.id, e.target.value.trim());
});
$("#s-review").addEventListener("click", (e) => {
  const row = e.target.closest("[data-id]"), id = row?.dataset.id;
  const rv = e.target.closest("[data-rv]"), rk = e.target.closest("[data-rk]");
  if (rv) {
    const old = S.verdicts[id] || {};
    const verdict = old.verdict === rv.dataset.rv ? undefined : rv.dataset.rv; // a second click takes the answer back
    S.verdicts[id] = { ...(old.note ? { note: old.note } : {}), ...(verdict ? { verdict } : {}), ...(verdict === "wrong" && old.kind ? { kind: old.kind } : {}) };
    if (!verdict && !old.note) delete S.verdicts[id];
    refreshRow(id);
  } else if (rk) {
    S.verdicts[id].kind = rk.dataset.rk;
    refreshRow(id);
  } else if (e.target.closest("[data-note-open]")) {
    S.noteOpen.add(id);
    refreshRow(id);
    $(`#rev-groups [data-id="${id}"] [data-note]`)?.focus();
  }
});
const reviewAll = (hide) => {
  $$("#rev-groups .rv-row").forEach((el) => { if (hide) S.hidden.add(el.dataset.id); else S.hidden.delete(el.dataset.id); });
  renderReview();
};
$("#rev-none").addEventListener("click", () => reviewAll(true));
$("#rev-all").addEventListener("click", () => reviewAll(false));

function renderCheck() {
  const id = S.checkList[S.checkAt], p = param(id), v = S.verdicts[id];
  const [g] = id.split(".").map(Number);
  $("#chk-count").textContent = `שורה ${S.checkAt + 1} מתוך ${S.checkList.length}`;
  $("#chk-bar").style.width = Math.round((100 * S.checkAt) / S.checkList.length) + "%";
  $("#chk-prev").hidden = S.checkAt === 0;
  $("#chk-card").innerHTML = `<div class="small">${esc(S.result.groups[g].title)}</div>
    <div class="chk-lab">${esc(p.label)}</div>
    <div class="chk-val ${p.v === null ? "none" : ""}">${esc(valText(p))}</div>
    <div class="row-ev">${evLine(p)}</div>
    ${isPrivate() ? `<div class="chk-private">מה שכתוב כאן נשאר אצלך. נשלחת רק התשובה.</div>` : ""}`;
  $$("[data-verdict]").forEach((b) => b.classList.toggle("on", v?.verdict === b.dataset.verdict));
  $$("[data-kind]").forEach((b) => b.classList.toggle("on", v?.kind === b.dataset.kind));
  const showMore = v?.verdict === "wrong" && asksKind(p);
  $("#chk-more").hidden = !showMore;
  $("#chk-note-wrap").hidden = isPrivate();
  $("#chk-note").placeholder = `הערה ל${CFG.feedbackTo} (לא חובה)`;
  $("#chk-note").value = v?.note || "";
}

function nextRow() {
  if (S.checkAt >= S.checkList.length - 1) { go("s-questions"); return; }
  S.checkAt++;
  renderCheck();
  window.scrollTo({ top: 0, behavior: "instant" });
}

$("#s-check").addEventListener("click", (e) => {
  const id = S.checkList[S.checkAt], p = id && param(id);
  const vb = e.target.closest("[data-verdict]"), kb = e.target.closest("[data-kind]");
  if (vb) {
    const verdict = vb.dataset.verdict;
    S.verdicts[id] = verdict === "wrong" ? { ...S.verdicts[id], verdict } : { verdict };
    if (verdict === "wrong" && asksKind(p)) renderCheck(); else nextRow();
  } else if (kb) {
    S.verdicts[id].kind = kb.dataset.kind;
    if (isPrivate()) nextRow(); else renderCheck();
  }
});
$("#chk-note").addEventListener("input", (e) => {
  const v = S.verdicts[S.checkList[S.checkAt]];
  if (v) v.note = e.target.value.trim();
});
$("#chk-next").addEventListener("click", nextRow);
$("#chk-skip").addEventListener("click", () => { delete S.verdicts[S.checkList[S.checkAt]]; nextRow(); });
$("#chk-prev").addEventListener("click", () => { S.checkAt--; renderCheck(); });

// ---------------------------------------------------------------- feedback
const radio = (n) => $(`input[name="${n}"]:checked`)?.value || "";
const answered = () => S.checkList.filter((id) => {
  const v = S.verdicts[id];
  if (!v) return false;
  if (isPrivate()) return !!v.verdict;
  return !(isHidden(id) && dropsWhole(id));
});

// An interest sender is known, not unknown, and listing it here would reveal an interest the participant blacked out
const unknownList = () => S.result.unknown.filter((u) =>
  !INTERESTS.some((t) => t.domains.some((d) => u.domain === d || u.domain.endsWith("." + d))));

function fbItem(group, key, k, v, on = true, mono = false) {
  return `<label class="fb-item"><input type="checkbox" data-g="${group}" data-k="${esc(key)}" ${on ? "checked" : ""}>
    <div><div class="k">${esc(k)}</div><div class="v ${mono ? "mono" : ""}">${esc(v)}</div></div></label>`;
}

// Everything sent is built from these allow-lists. Without the report no value, evidence, note or free name goes in
function verdictRecord(id) {
  const p = param(id), v = S.verdicts[id];
  const rec = { key: p.key, label: p.fb_label, verdict: v.verdict || "comment" };
  if (!bare(id) || p.detail) rec.outcome = p.outcome;
  if (v.verdict === "wrong" && v.kind && (!bare(id) || p.detail)) rec.kind = v.kind;
  if (!bare(id) && v.verdict === "wrong") rec.value = valText(p);
  if (!isPrivate() && v.note) rec.note = v.note;
  if (isHidden(id)) rec.hidden = true;
  return rec;
}
// The report as it goes out. A blacked-out value is never added here, so it isn't in the mail or the file at all
function reportRecord() {
  const r = S.result;
  const extra = (prefix, list, make) => list.flatMap((x, i) => {
    const id = prefix + i;
    return isHidden(id) ? [] : [{ ...make(x), ...(S.verdicts[id]?.note ? { note: S.verdicts[id].note } : {}) }];
  });
  return {
    today: r.today,
    groups: r.groups.map((g, gi) => ({ title: g.title, rows: g.params.flatMap((p, pi) => {
      const id = `${gi}.${pi}`;
      if (!isHidden(id)) return [{ key: p.key, label: p.label, value: valText(p), evidence: evText(p) }];
      return dropsWhole(id) ? [] : [{ key: p.key, label: p.fb_label, hidden: true }];
    }) })).filter((g) => g.rows.length),
    suppliers: extra("s", r.suppliers, (x) => ({ org: x.org_he, text: supplierText(x) })),
    minor: extra("m", r.minor, (m) => ({ org: m.org_he, text: minorText(m) })),
    hidden_rows: S.hidden.size,
  };
}
function statsRecord() {
  const st = S.result.stats;
  const out = { messages: st.messages, business_in: st.business_in, business_in_registered: st.business_in_registered,
                business_in_labelled: st.business_in_labelled, templates: st.templates, orgs: st.orgs,
                skipped_promotions: S.run.skipped_promotions, reads: S.run.reads, report_seconds: S.run.report_seconds,
                read_seconds: S.run.read_seconds, complete: S.run.complete };
  if (!isPrivate()) { out.findings_rows = st.findings_rows; out.report_rows = S.result.groups.reduce((a, g) => a + g.params.length, 0); }
  return out;
}

$("#to-feedback").addEventListener("click", async () => {
  // the preview has to show what will really go out, so it waits for the last of the count
  const btn = $("#to-feedback"), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "מסיימים לעבור על השולחים…";
  await S.background;
  btn.disabled = false;
  btn.textContent = label;
  const A = [["q-overall", "כמה נכון בסך הכול", radio("q-overall")], ["q-ux", "מה היה מבלבל", $("#q-ux").value.trim()]].filter((a) => a[2]);
  S.answers = Object.fromEntries(A.map((a) => [a[0], a[2]]));
  $("#fb-private-note").hidden = !isPrivate();
  $("#fb-partial").hidden = !!S.run.complete;
  $("#fb-answers-card").hidden = !A.length;
  $("#fb-answers").innerHTML = A.map((a) => fbItem("answers", a[0], a[1], a[2])).join("");

  $("#fb-report-card").hidden = isPrivate();
  if (!isPrivate()) {
    const rep = reportRecord();
    const line = (k, v) => `<div class="fb-rep"><span>${esc(k)}</span><b>${v}</b></div>`;
    $("#fb-report").innerHTML = rep.groups.map((g) => `<div class="k">${esc(g.title)}</div>` + g.rows.map((x) =>
      line(x.label, x.hidden ? `<span class="redact" role="img" aria-label="מושחר"></span>` : esc(x.value))).join("")).join("") +
      (rep.suppliers.length ? `<div class="k">פירוט ספקים</div>` + rep.suppliers.map((x) => line(x.org, esc(x.text))).join("") : "") +
      (rep.minor.length ? `<div class="k">אירועי תשלום זניחים</div>` + rep.minor.map((x) => line(x.org, esc(x.text))).join("") : "");
  }

  const ans = answered();
  $("#fb-verdicts").innerHTML = ans.length ? ans.map((id) => {
    const r = verdictRecord(id), bits = [VERDICT_HE[r.verdict]];
    if (r.kind) bits.push(KIND_HE[r.kind]);
    if (r.value !== undefined) bits.push(`המנוע כתב: ${r.value}`);
    if (r.hidden) bits.push("השורה מושחרת");
    if (r.note) bits.push(r.note);
    return fbItem("verdicts", id, r.label, bits.join(" · "));
  }).join("") : `<p class="small">לא נענו שורות.</p>`;

  const st = statsRecord();
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  $("#fb-stats").innerHTML = fbItem("stats", "all", "ספירות",
    `${fmtN(st.messages)} מיילים · ${fmtN(st.business_in)} מגופים · מזוהים ${pct(st.business_in_registered, st.business_in)} · ` +
    `עם סוג אירוע ${pct(st.business_in_labelled, st.business_in)} · ${fmtN(st.templates)} תבניות · ${fmtN(st.skipped_promotions)} פרסומות שדולגו · ${fmtN(st.reads)} מיילים שנפתחה הכותרת שלהם · ${fmtN(st.read_seconds)} שניות${st.complete ? "" : " · הספירה חלקית"}`);

  // Without the report these start unticked: a sender's address can hint at what someone uses
  const unknownOn = !isPrivate();
  $("#fb-unknown-note").textContent = (isPrivate()
    ? "לא מסומנים, כי כתובת שולח יכולה לרמוז במה את/ה משתמש/ת. אם לא מפריע לך, אפשר לסמן ולעזור ללמד את המנוע. "
    : "כדי ללמד את המנוע. ") + "יש כאן רק כתובת שולח ותבנית נושא, בלי מספרים ובלי שמך. שולחים של בריאות, תרומות, קהילה וילדים כבר הוצאו.";
  $("#fb-unknown-card").hidden = !unknownList().length;
  $("#fb-unknown").innerHTML = unknownList().map((u, i) => fbItem("unknown", i, `${u.domain} · ${u.count} מיילים`, u.skeleton, unknownOn)).join("");
  $$("#fb-unknown .fb-item").forEach((el) => el.classList.toggle("off", !unknownOn));
  go("s-feedback");
});

document.addEventListener("change", (e) => {
  const c = e.target.closest(".fb-item input");
  if (c) c.closest(".fb-item").classList.toggle("off", !c.checked);
});
const setAll = (on) => $$("#fb-unknown input").forEach((c) => { c.checked = on; c.closest(".fb-item").classList.toggle("off", !on); });
$("#fb-none").addEventListener("click", () => setAll(false));
$("#fb-all").addEventListener("click", () => setAll(true));

function buildFeedback() {
  const keep = (g) => new Set($$(`#s-feedback input[data-g="${g}"]:checked`).map((c) => c.dataset.k));
  const ka = keep("answers"), kv = keep("verdicts"), ku = keep("unknown"), ks = keep("stats");
  return {
    kind: "imtrustme-pilot-feedback", version: 2, mode: S.mode, from: $("#fb-from").value.trim() || "ללא שם",
    created: new Date().toISOString(), rule_version: S.result.rule_version,
    answers: Object.fromEntries(Object.entries(S.answers).filter(([k]) => ka.has(k))),
    verdicts: answered().filter((id) => kv.has(id)).map(verdictRecord),
    stats: ks.has("all") ? statsRecord() : null,
    unknown_senders: unknownList().filter((_, i) => ku.has(String(i))),
    ...(isPrivate() ? {} : { report: reportRecord() }),
  };
}

// The one network call that carries feedback, and only on this click. text/plain keeps the request simple (no CORS
// preflight, which Apps Script cannot answer). The script replies {ok:true} only after the mail went out
$("#fb-send").addEventListener("click", async () => {
  const btn = $("#fb-send"), err = $("#fb-send-err");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "שולח…";
  try {
    if (CFG.sendUrl.startsWith("PASTE")) throw new Error("no send url");
    const r = await fetch(CFG.sendUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(buildFeedback()) });
    const reply = await r.json();
    if (!reply.ok) throw new Error(reply.error || "rejected");
    $("#done-lead").textContent = `הכול הגיע ל${CFG.feedbackTo}. עזרת מאוד.`;
    go("s-done");
  } catch (e) {
    console.warn("send failed", e);
    err.hidden = false;
    $("#fb-download").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "שליחה";
  }
});

// Fallback only when sending failed: the participant still doesn't lose the answers
$("#fb-download").addEventListener("click", () => {
  // ASCII only: Chrome drops a Hebrew download name and saves the file as "download". The sender's name is inside
  const name = `feedback-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}.json`;
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new File([JSON.stringify(buildFeedback(), null, 1)], name, { type: "application/json" })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("#done-lead").textContent = `הקובץ ${name} נשמר אצלך. אפשר לשלוח אותו ל${CFG.feedbackTo} בוואטסאפ או במייל.`;
  go("s-done");
});
