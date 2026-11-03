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
// One search for each report row that reads a mail's wording. Whatever comes back is opened, and pilot.py decides on the real subject
const SIGNAL_QUERIES = [
  'subject:"כתב תביעה"', 'subject:"תביעה קטנה"', 'subject:"בית משפט"', 'subject:"בית המשפט"', 'subject:"הוצאה לפועל"',
  'subject:"רשות האכיפה"', "subject:עיקול", "subject:chargeback", 'subject:"הכחשת עסקה"',
  'subject:"חשבון מוגבל"', 'subject:"שיק חוזר"', 'subject:"שיקים חוזרים"', 'subject:"חריגה ממסגרת"', 'subject:"הגבלת חשבון"', 'subject:"התראה לפני הגבלה"',
  'subject:"הסכם הלוואה"', 'subject:"שינוי כתובת מגורים"', "subject:משכנתא",
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
  do {
    const page = await gget(`${API}/messages?maxResults=500${token ? "&pageToken=" + token : ""}`, LIST_UNITS);
    for (const m of page.messages || []) {
      const t = idTime(m.id);
      if (t < oldest) oldest = t;
      if (t < since || drafts.has(m.id)) continue;
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

  // everyone else: open one mail, learn the sender, ask for all of theirs. Newest first, until no mail is left unaccounted for
  const asked = new Set([...known, ...PERSONAL_DOMAINS]);
  const queue = [...pending.keys()].sort((a, b) => idTime(b) - idTime(a));
  await pool(Array.from({ length: 4 }), 4, async () => {
    while (queue.length) {
      const id = queue.shift();
      if (!pending.has(id)) continue;
      const row = await open(id);
      const d = row?.from.split("@")[1];
      if (!d || asked.has(d)) continue;
      asked.add(d);
      (await search(`from:${d}`)).forEach((m) => { const r = place(m, {}); if (r && !r.real && !r.sent) r.from = "x@" + d; });
      show();
    }
  });
  const out = [...rows.values()].map(({ real, ...r }) => (!real && named.has(r.id) ? { ...r, subject: `${r.subject} ${named.get(r.id)}`.trim() } : r));
  stage("read", "done", fmtN(out.length));

  // 3. access is no longer needed: revoke before the engine even starts
  stage("revoke", "now");
  await revoke();
  stage("revoke", "done");

  // 4. engine
  stage("engine", "now");
  $("#eta").textContent = engineReady ? "" : "מטעינים את המנוע…";
  await whenEngine();
  if (engineErr) throw new Error("המנוע לא נטען (" + engineErr + ")");
  const account = [...senderName.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const today = new Date().toLocaleDateString("sv-SE");
  S.run = { messages: out.length, listed: total, skipped_promotions: skipped, reads, read_seconds: Math.round((performance.now() - t0) / 1000),
            mailbox_since: isFinite(oldest) ? new Date(oldest).toLocaleDateString("sv-SE") : null };
  const result = await new Promise((res, rej) => {
    S.onEngine = (r, e) => (e ? rej(new Error(e)) : res(r));
    worker.postMessage({ type: "run", payload: {
      today, owner: S.owner, own_addresses: [profile.emailAddress], rows: out, account_name: account,
      sent_checked: sentChecked, mailbox_since: S.run.mailbox_since } });
  });
  out.length = 0; rows.clear(); // the envelopes are not kept once the profile exists
  stage("engine", "done");
  bar(1);
  window.onbeforeunload = null;
  S.result = result;
  renderReport();
  go("s-report");
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
const valText = (p) => (p.v === null ? p.why : p.v === 0 ? "0" : String(p.v));

function renderReport() {
  const r = S.result;
  $("#rep-name").textContent = S.owner.name_he;
  const d = r.today.split("-").reverse().join(".");
  $("#rep-meta").innerHTML = `${d}<br>${fmtN(r.stats.messages)} מיילים, ${CFG.years} שנים`;
  $("#rep-groups").innerHTML = r.groups.map((g) => `
    <div class="card group"><h2>${esc(g.title)}</h2>${g.params.map((p) => `<div class="row">
        <div class="lab">${esc(p.label)}</div>
        <div class="val ${p.v === null ? "none" : ""}">${esc(valText(p))}</div>
        <div class="ev">${evLine(p)}</div>
      </div>`).join("")}</div>`).join("");
  $("#rep-minor").hidden = !r.minor.length;
  $("#minor-list").innerHTML = r.minor.map((m) =>
    `<li>${esc(m.org_he)}: ${m.n_in === 1 ? "הודעה אחת" : m.n_in + " הודעות"}, ${esc(m.first.split("-").reverse().join("."))}. נסגר.</li>`).join("");
}

// ---------------------------------------------------------------- what to share, then row by row
const param = (id) => { const [g, p] = id.split(".").map(Number); return S.result.groups[g].params[p]; };
const VERDICT_HE = { correct: "נכון", wrong: "לא נכון", unsure: "לא יודע/ת" };
const KIND_HE = { missed: "חסר משהו שקיים", invented: "כתוב משהו שלא קיים", inaccurate: "הפרטים לא מדויקים" };
const isPrivate = () => S.mode === "private";
// A sensitive row without the report gets a bare answer: "missing" on a legal row would say there is a legal case
const asksKind = (p) => !isPrivate() || p.detail;

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
  renderCheck();
  go("s-check");
});

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
const answered = () => S.checkList.filter((id) => S.verdicts[id]);

function fbItem(group, key, k, v, on = true, mono = false) {
  return `<label class="fb-item"><input type="checkbox" data-g="${group}" data-k="${esc(key)}" ${on ? "checked" : ""}>
    <div><div class="k">${esc(k)}</div><div class="v ${mono ? "mono" : ""}">${esc(v)}</div></div></label>`;
}

// Everything sent is built from these allow-lists. Without the report no value, evidence, note or free name goes in
function verdictRecord(id) {
  const p = param(id), v = S.verdicts[id];
  const rec = { key: p.key, label: p.fb_label, verdict: v.verdict };
  if (!isPrivate() || p.detail) rec.outcome = p.outcome;
  if (v.verdict === "wrong" && v.kind && asksKind(p)) rec.kind = v.kind;
  if (!isPrivate() && v.verdict === "wrong") {
    rec.value = valText(p);
    if (v.note) rec.note = v.note;
  }
  return rec;
}
function statsRecord() {
  const st = S.result.stats;
  const out = { messages: st.messages, business_in: st.business_in, business_in_registered: st.business_in_registered,
                business_in_labelled: st.business_in_labelled, templates: st.templates, orgs: st.orgs,
                skipped_promotions: S.run.skipped_promotions, reads: S.run.reads, read_seconds: S.run.read_seconds };
  if (!isPrivate()) { out.findings_rows = st.findings_rows; out.report_rows = S.result.groups.reduce((a, g) => a + g.params.length, 0); }
  return out;
}

$("#to-feedback").addEventListener("click", () => {
  const A = [["q-overall", "כמה נכון בסך הכול", radio("q-overall")], ["q-ux", "מה היה מבלבל", $("#q-ux").value.trim()]].filter((a) => a[2]);
  S.answers = Object.fromEntries(A.map((a) => [a[0], a[2]]));
  $("#fb-private-note").hidden = !isPrivate();
  $("#fb-answers-card").hidden = !A.length;
  $("#fb-answers").innerHTML = A.map((a) => fbItem("answers", a[0], a[1], a[2])).join("");

  const ans = answered();
  $("#fb-verdicts").innerHTML = ans.length ? ans.map((id) => {
    const r = verdictRecord(id), bits = [VERDICT_HE[r.verdict]];
    if (r.kind) bits.push(KIND_HE[r.kind]);
    if (r.value !== undefined) bits.push(`המנוע כתב: ${r.value}`);
    if (r.note) bits.push(r.note);
    return fbItem("verdicts", id, r.label, bits.join(" · "));
  }).join("") : `<p class="small">לא נענו שורות.</p>`;

  const st = statsRecord();
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  $("#fb-stats").innerHTML = fbItem("stats", "all", "ספירות",
    `${fmtN(st.messages)} מיילים · ${fmtN(st.business_in)} מגופים · מזוהים ${pct(st.business_in_registered, st.business_in)} · ` +
    `עם סוג אירוע ${pct(st.business_in_labelled, st.business_in)} · ${fmtN(st.templates)} תבניות · ${fmtN(st.skipped_promotions)} פרסומות שדולגו · ${fmtN(st.reads)} מיילים שנפתחה הכותרת שלהם · ${fmtN(st.read_seconds)} שניות`);

  // Without the report these start unticked: a sender's address can hint at what someone uses
  const unknownOn = !isPrivate();
  $("#fb-unknown-note").textContent = (isPrivate()
    ? "לא מסומנים, כי כתובת שולח יכולה לרמוז במה את/ה משתמש/ת. אם לא מפריע לך, אפשר לסמן ולעזור ללמד את המנוע. "
    : "כדי ללמד את המנוע. ") + "יש כאן רק כתובת שולח ותבנית נושא, בלי מספרים ובלי שמך. שולחים של בריאות, תרומות, קהילה וילדים כבר הוצאו.";
  $("#fb-unknown-card").hidden = !S.result.unknown.length;
  $("#fb-unknown").innerHTML = S.result.unknown.map((u, i) => fbItem("unknown", i, `${u.domain} · ${u.count} מיילים`, u.skeleton, unknownOn)).join("");
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
    unknown_senders: S.result.unknown.filter((_, i) => ku.has(String(i))),
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
