// imtrustme pilot: Gmail envelopes -> engine in the browser -> report the owner reviews -> feedback file the owner sends.
// No server. The only network calls: Google sign-in, the Gmail API (read envelopes, then revoke), the CDN for the engine.
"use strict";

const CFG = window.IMTRUSTME;
const SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const S = { owner: null, token: null, result: null, marks: {}, run: {} };

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
  let ids = [], token = "", oldest = Infinity;
  do {
    const page = await gget(`${API}/messages?maxResults=500${token ? "&pageToken=" + token : ""}`);
    for (const m of page.messages || []) {
      const t = idTime(m.id);
      if (t < oldest) oldest = t;
      if (t >= since) ids.push(m);
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
  S.run = { messages: rows.length, listed: ids.length, mailbox_since: isFinite(oldest) ? new Date(oldest).toLocaleDateString("sv-SE") : null };
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
  $("#rep-meta").innerHTML = `נוצר ${d}<br>${fmtN(r.stats.messages)} מיילים, ${CFG.years} שנים`;
  $("#rep-groups").innerHTML = r.groups.map((g, gi) => `
    <div class="card group"><h2>${esc(g.title)}</h2>${g.params.map((p, pi) => {
      const id = `${gi}.${pi}`;
      return `<div class="row" data-id="${id}">
        <div class="lab">${esc(p.label)}</div>
        <div class="val ${p.v === null ? "none" : ""}">${esc(valText(p))}</div>
        <div class="hid">הוסתר על ידי בעל/ת הפרופיל</div>
        <div class="ev">${evLine(p)}</div>
        <div class="cmt-print"></div>
        <div class="ctl">
          <button class="chip" data-act="hide" aria-pressed="false">להסתיר</button>
          <button class="chip" data-act="comment" aria-pressed="false">תגובה</button>
          <button class="chip wrong" data-act="wrong" aria-pressed="false">לא נכון</button>
        </div>
        <textarea class="cmt" data-f="comment" hidden placeholder="התגובה תופיע למשכיר מתחת לשורה"></textarea>
        <div class="wrongbox" hidden><textarea data-f="wrongNote" placeholder="מה לא נכון? (נשלח רק ל${esc(CFG.feedbackTo)}, לא למשכיר)"></textarea></div>
      </div>`;
    }).join("")}</div>`).join("");
  $("#rep-minor").hidden = !r.minor.length;
  $("#minor-list").innerHTML = r.minor.map((m) =>
    `<li>${esc(m.org_he)}: ${m.n_in === 1 ? "הודעה אחת" : m.n_in + " הודעות"}, ${esc(m.first.split("-").reverse().join("."))}. נסגר.</li>`).join("");
  $("#notchecked").innerHTML = r.not_checked.map((x) => `<li><b>${esc(x.label)}:</b> ${esc(x.why)}</li>`).join("");
  $("#rep-foot").textContent = `גרסת חוקים ${r.rule_version}. המנוע דטרמיניסטי: אותה תיבה, אותו דוח.`;
}

$("#rep-groups").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const row = b.closest(".row"), id = row.dataset.id;
  const mk = (S.marks[id] ||= {});
  const on = b.getAttribute("aria-pressed") !== "true";
  b.setAttribute("aria-pressed", on);
  if (b.dataset.act === "hide") { mk.hidden = on; row.classList.toggle("hidden", on); b.textContent = on ? "להציג" : "להסתיר"; }
  if (b.dataset.act === "comment") { const t = $(".cmt", row); t.hidden = !on; if (on) t.focus(); else { t.value = ""; mk.comment = ""; $(".cmt-print", row).textContent = ""; } }
  if (b.dataset.act === "wrong") { mk.wrong = on; const w = $(".wrongbox", row); w.hidden = !on; if (on) $("textarea", w).focus(); }
});
$("#rep-groups").addEventListener("input", (e) => {
  const t = e.target.closest("textarea[data-f]");
  if (!t) return;
  const row = t.closest(".row");
  (S.marks[row.dataset.id] ||= {})[t.dataset.f] = t.value.trim();
  if (t.dataset.f === "comment") $(".cmt-print", row).textContent = t.value.trim() ? "תגובת בעל/ת הפרופיל: " + t.value.trim() : "";
});
$("#print").addEventListener("click", () => window.print());

// ---------------------------------------------------------------- feedback
const param = (id) => { const [g, p] = id.split(".").map(Number); return S.result.groups[g].params[p]; };
const radio = (n) => $(`input[name="${n}"]:checked`)?.value || "";

function fbItem(group, key, k, v, on = true, mono = false) {
  return `<label class="fb-item"><input type="checkbox" data-g="${group}" data-k="${esc(key)}" ${on ? "checked" : ""}>
    <div><div class="k">${esc(k)}</div><div class="v ${mono ? "mono" : ""}">${esc(v)}</div></div></label>`;
}

$("#to-feedback").addEventListener("click", () => {
  const A = [["q-feel", "מה הרגשת", $("#q-feel").value.trim()], ["q-shown", "הראית למישהו", radio("q-shown")],
    ["q-send", "היית שולח/ת למשכיר", radio("q-send")], ["q-send-why", "מה היית מסתיר/ה", $("#q-send-why").value.trim()],
    ["q-fear", "מה הלחיץ בחיבור", $("#q-fear").value.trim()], ["q-pay", "היית משלם/ת", radio("q-pay")],
    ["q-ux", "מה היה לא נוח", $("#q-ux").value.trim()]].filter((a) => a[2]);
  S.answers = Object.fromEntries(A.map((a) => [a[0], a[2]]));
  $("#fb-answers").innerHTML = A.length ? A.map((a) => fbItem("answers", a[0], a[1], a[2])).join("") : `<p class="small">לא נענו שאלות.</p>`;

  const marks = Object.entries(S.marks).filter(([, m]) => m.hidden || m.comment || m.wrong);
  $("#fb-marks").innerHTML = marks.length ? marks.map(([id, m]) => {
    const p = param(id), bits = [];
    if (m.hidden) bits.push("הסתרת");
    if (m.comment) bits.push("תגובה: " + m.comment);
    if (m.wrong) bits.push(`לא נכון: "${valText(p)}"` + (m.wrongNote ? ` · ${m.wrongNote}` : ""));
    return fbItem("marks", id, p.label, bits.join(" · "));
  }).join("") : `<p class="small">לא סימנת שורות.</p>`;

  const st = S.result.stats;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  $("#fb-stats").innerHTML = fbItem("stats", "all", "ספירות",
    `${fmtN(st.messages)} מיילים · ${fmtN(st.business_in)} מגופים · מזוהים ${pct(st.business_in_registered, st.business_in)} · ` +
    `עם סוג אירוע ${pct(st.business_in_labelled, st.business_in)} · ${fmtN(st.templates)} תבניות · ${st.findings_rows} שורות עם ממצא`);

  $("#fb-unknown").innerHTML = S.result.unknown.length
    ? S.result.unknown.map((u, i) => fbItem("unknown", i, `${u.domain} · ${u.count} מיילים`, u.skeleton)).join("")
    : `<p class="small">המנוע הכיר את כל השולחים.</p>`;
  go("s-feedback");
});

document.addEventListener("change", (e) => {
  const c = e.target.closest(".fb-item input");
  if (c) c.closest(".fb-item").classList.toggle("off", !c.checked);
});
const setAll = (on) => $$("#fb-unknown input").forEach((c) => { c.checked = on; c.closest(".fb-item").classList.toggle("off", !on); });
$("#fb-none").addEventListener("click", () => setAll(false));
$("#fb-all").addEventListener("click", () => setAll(true));

let lastFile = null;
$("#fb-make").addEventListener("click", async () => {
  const keep = (g) => new Set($$(`#s-feedback input[data-g="${g}"]:checked`).map((c) => c.dataset.k));
  const ka = keep("answers"), km = keep("marks"), ku = keep("unknown"), ks = keep("stats");
  const from = $("#fb-from").value.trim() || "ללא שם";
  const out = {
    kind: "imtrustme-pilot-feedback", version: 1, from, created: new Date().toISOString(),
    rule_version: S.result.rule_version,
    answers: Object.fromEntries(Object.entries(S.answers).filter(([k]) => ka.has(k))),
    marks: Object.entries(S.marks).filter(([id]) => km.has(id)).map(([id, m]) => {
      const p = param(id);
      return { label: p.label, hidden: !!m.hidden, comment: m.comment || null, wrong: !!m.wrong,
               value: m.wrong ? valText(p) : null, wrong_note: m.wrong ? m.wrongNote || null : null };
    }),
    stats: ks.has("all") ? { ...S.result.stats, listed_3y: S.run.listed, has_household: !!S.owner.household,
                             report_rows: S.result.groups.reduce((a, g) => a + g.params.length, 0) } : null,
    unknown_senders: S.result.unknown.filter((_, i) => ku.has(String(i))),
  };
  // ASCII only: Chrome drops a Hebrew download name and saves the file as "download". The sender's name is inside
  const name = `imtrustme-feedback-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}.json`;
  lastFile = new File([JSON.stringify(out, null, 1)], name, { type: "application/json" });
  deliver(lastFile);
  $("#done-file").textContent = name;
  $("#again-share").hidden = !navigator.canShare?.({ files: [lastFile] });
  go("s-done");
});

async function share(file) {
  try { await navigator.share({ files: [file], title: "משוב imtrustme" }); } catch { /* closed or unsupported */ }
}
$("#again-share").addEventListener("click", () => lastFile && share(lastFile));

function deliver(file) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
