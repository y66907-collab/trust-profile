// imtrustme pilot: Gmail envelopes -> engine in the browser -> participant checks each row -> participant presses send.
// Network calls: Google sign-in, the Gmail API (read envelopes, then revoke), the CDN for the engine, and the send button.
"use strict";

const CFG = window.IMTRUSTME;
const SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
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
        err.textContent = "לא התקבלה הרשאה לקרוא מעטפות. אפשר לנסות שוב, ולסמן את ההרשאה בחלון של Google.";
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
async function gget(url, tries = 0) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + S.token } });
  if (r.ok) return r.json();
  if ((r.status === 429 || r.status === 403 || r.status >= 500) && tries < 6) {
    await new Promise((res) => setTimeout(res, 600 * 2 ** tries + Math.random() * 300));
    return gget(url, tries + 1);
  }
  if (r.status === 401) throw new Error("ההרשאה של Google פגה");
  throw new Error("Gmail " + r.status);
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
  const since = Date.now() - CFG.years * 365.25 * 864e5;

  // 1. list every id (cheap). The oldest id gives the mailbox age; only the last N years are read
  stage("list", "now");
  // Promotions are dropped by id: listing them is cheap (500 per request) and each one skipped saves a whole read.
  // A list comes back newest first, so this stops at the start of the period
  const promo = new Set();
  let token = "", inPeriod = true;
  do {
    const page = await gget(`${API}/messages?labelIds=CATEGORY_PROMOTIONS&maxResults=500${token ? "&pageToken=" + token : ""}`);
    for (const m of page.messages || []) {
      if (idTime(m.id) >= since) promo.add(m.id);
      else inPeriod = false;
    }
    token = page.nextPageToken;
  } while (token && inPeriod);

  let ids = [], skipped = 0, oldest = Infinity;
  do {
    const page = await gget(`${API}/messages?maxResults=500${token ? "&pageToken=" + token : ""}`);
    for (const m of page.messages || []) {
      const t = idTime(m.id);
      if (t < oldest) oldest = t;
      if (t < since) continue;
      if (promo.has(m.id)) skipped++;
      else ids.push(m);
    }
    token = page.nextPageToken;
    stage("list", "now", fmtN(ids.length));
    bar(Math.min(0.08, 0.002 * (ids.length / 500)));
  } while (token);
  stage("list", "done", fmtN(ids.length));

  // 2. envelopes, a few at a time (Gmail allows ~50 a second per person)
  stage("read", "now");
  const rows = [], senders = new Map();
  let done = 0, sentChecked = 0;
  const t0 = performance.now();
  const q = ids.slice();
  const headers = ["From", "To", "Subject"].map((h) => "&metadataHeaders=" + h).join("");
  async function lane() {
    while (q.length) {
      const m = q.shift();
      const g = await gget(`${API}/messages/${m.id}?format=metadata${headers}`);
      const h = Object.fromEntries((g.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      const labels = g.labelIds || [];
      if (!labels.includes("DRAFT")) {
        const sent = labels.includes("SENT");
        rows.push({ thread: g.threadId, id: g.id, ts: +g.internalDate || idTime(g.id), from: addrOf(h.from), to: addrOf(h.to),
                    subject: decodeWords(h.subject || "").replace(/[\t\r\n]+/g, " "), sent });
        if (sent && addrOf(h.from) === profile.emailAddress.toLowerCase()) {
          sentChecked++;
          const nm = nameOf(h.from);
          if (nm) senders.set(nm, (senders.get(nm) || 0) + 1);
        }
      }
      done++;
      if (done % 25 === 0 || done === ids.length) {
        stage("read", "now", `${fmtN(done)} / ${fmtN(ids.length)}`);
        bar(0.08 + 0.82 * (done / ids.length));
        const rate = done / ((performance.now() - t0) / 1000);
        const left = Math.max(0, (ids.length - done) / rate);
        $("#eta").textContent = left > 50 ? `נשארו בערך ${Math.round(left / 60)} דקות` : "עוד רגע";
      }
    }
  }
  await Promise.all(Array.from({ length: 10 }, lane));
  stage("read", "done", fmtN(rows.length));

  // 3. access is no longer needed: revoke before the engine even starts
  stage("revoke", "now");
  await revoke();
  stage("revoke", "done");

  // 4. engine
  stage("engine", "now");
  $("#eta").textContent = engineReady ? "" : "מטעינים את המנוע…";
  await whenEngine();
  if (engineErr) throw new Error("המנוע לא נטען (" + engineErr + ")");
  const account = [...senders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const today = new Date().toLocaleDateString("sv-SE");
  S.run = { messages: rows.length, listed: ids.length, skipped_promotions: skipped, mailbox_since: isFinite(oldest) ? new Date(oldest).toLocaleDateString("sv-SE") : null };
  const result = await new Promise((res, rej) => {
    S.onEngine = (r, e) => (e ? rej(new Error(e)) : res(r));
    worker.postMessage({ type: "run", payload: {
      today, owner: S.owner, own_addresses: [profile.emailAddress], rows, account_name: account,
      sent_checked: sentChecked, mailbox_since: S.run.mailbox_since } });
  });
  rows.length = 0; // the envelopes are not kept once the profile exists
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
                skipped_promotions: S.run.skipped_promotions };
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
    `עם סוג אירוע ${pct(st.business_in_labelled, st.business_in)} · ${fmtN(st.templates)} תבניות · ${fmtN(st.skipped_promotions)} פרסומות שלא נקראו`);

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
