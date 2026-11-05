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
  flights: "subject:(טיסה OR \"boarding pass\" OR itinerary OR \"כרטיס טיסה\") -subject:(פרסומת OR מבצע OR הגרלה)",
  orders: "subject:(\"ההזמנה שלך\" OR \"your order\" OR משלוח OR shipped OR \"order confirmation\")",
  learning: "subject:(קורס OR כנס OR הרצאה OR webinar OR conference OR meetup OR course)",
  contracts: "subject:(חוזה OR הסכם OR contract OR agreement)",
  contracts_sent: "in:sent subject:(חוזה OR הסכם OR contract OR agreement)",
  standing_orders: 'subject:"הוראת קבע"',
  moving: 'subject:"מעבר דירה"',
  property_docs: 'subject:("נסח טאבו" OR "הסכם מכר" OR "חוזה מכר" OR "מס רכישה" OR "רישום זכויות")',
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
  'subject:"הסכם הלוואה"', 'subject:"מצב הלוואה"', 'subject:"לוח סילוקין"', 'subject:"נתוני אשראי"', 'subject:"דוח אשראי"', 'subject:"דירוג אשראי"', "subject:BDI", 'subject:"שינוי כתובת מגורים"', "subject:משכנתא",
  'subject:"תלוש שכר"', 'subject:"תלוש משכורת"', 'subject:"תלוש לחודש"', "subject:payslip",
  "subject:(רבעוני OR תקופתי OR שנתי) subject:(פנסיה OR גמל OR השתלמות)",
];
// Gmail matches whole words, so a search for פנסיה misses בפנסיה, and a row can read 0 while the mail is there.
// Every Hebrew word in a subject search is also asked for with the prefixes that attach to it.
const HE_PREFIXES = ["", "ה", "ב", "ל", "ו", "מ", "ש", "כ", "וה", "שה", "וב", "ול"];
function widenSubjects(q) {
  return q.replace(/subject:(\([^()]*\)|"[^"]*"|\S+)/g, (_, value) => {
    const terms = value.startsWith("(") ? value.slice(1, -1).split(/\s+OR\s+/) : [value];
    const wide = terms.flatMap((term) => {
      const word = term.replace(/^"|"$/g, "");
      if (!/^[א-ת]/.test(word)) return [term];
      return HE_PREFIXES.map((p) => (term.startsWith('"') ? `"${p}${word}"` : p + word));
    });
    return `subject:(${wide.join(" OR ")})`;
  });
}
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

// ---------------------------------------------------------------- the owner's own name, in any spelling
// A name is compared by its consonants, so the Hebrew someone typed meets whatever English spelling an address carries.
// A Hebrew letter that English writes in two ways gives two readings, and any one of them is enough
const HE_CONSONANTS = { "ב": ["b"], "ג": ["g"], "ד": ["d"], "ו": ["", "b"], "ז": ["z"], "ט": ["t"], "כ": ["k", ""], "ך": ["k", ""], "ל": ["l"], "מ": ["m"], "ם": ["m"],
  "נ": ["n"], "ן": ["n"], "ס": ["s"], "פ": ["p"], "ף": ["p"], "צ": ["ts"], "ץ": ["ts"], "ק": ["k"], "ר": ["r"], "ש": ["s"], "ת": ["t"] };
const squeeze = (s) => s.replace(/(.)\1+/g, "$1");
function skeletons(word) {
  const w = String(word || "").toLowerCase().replace(/[^a-zא-ת]/g, "");
  if (!/[א-ת]/.test(w)) {
    const t = w.replace(/^j/, "y").replace(/sh/g, "s").replace(/tz/g, "ts").replace(/ch|kh/g, "").replace(/ph/g, "p").replace(/th/g, "t")
      .replace(/[cq]/g, "k").replace(/x/g, "ks").replace(/f/g, "p").replace(/[vw]/g, "b");
    return [squeeze(t[0] === "y" ? "y" + t.slice(1).replace(/[aeiouhy]/g, "") : t.replace(/[aeiouhy]/g, ""))];
  }
  let out = [""];
  [...w].forEach((c, i) => {
    const ways = c === "י" ? (i === 0 ? ["y", ""] : [""]) : HE_CONSONANTS[c] || [""];
    out = out.flatMap((s) => ways.map((x) => s + x)).slice(0, 16);
  });
  return [...new Set(out.map(squeeze))];
}
// First name and family name, each as the set of its readings
function ownNames(owner) {
  const first = new Set(), last = new Set();
  for (const full of [owner.name_he, owner.name_en]) {
    const words = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    skeletons(words[0]).forEach((s) => first.add(s));
    skeletons(words.slice(1).join("")).forEach((s) => last.add(s));
  }
  return { first, last };
}
// Both names have to be there, so a relative who shares the family name is not taken for the owner: an initial is not a
// name. And a pair of names with too few consonants to tell people apart is not compared at all
function isOwnName(text, names) {
  const words = String(text || "").toLowerCase().split(/[^a-zא-ת]+/).filter(Boolean);
  const pairs = [...names.first].flatMap((f) => [...names.last].map((l) => [f, l])).filter(([f, l]) => f && l && f.length + l.length >= 4);
  if (!pairs.length || !words.length) return false;
  if (words.length === 1) return pairs.some(([f, l]) => skeletons(words[0]).some((s) => s === squeeze(f + l) || s === squeeze(l + f)));
  return words.some((w, i) => w.length >= 2 && pairs.some(([f, l]) => skeletons(w).includes(f) && skeletons(words.filter((_, j) => j !== i).join("")).includes(l)));
}
// A work address: the owner's own name in front of an organisation's domain, on mail that came in or went out. A mailbox
// service is not a workplace, and neither is a place of study, where every student gets an address
const NOT_A_WORKPLACE = /(^|\.)(ac\.[a-z]{2}|edu|edu\.[a-z]{2}|k12\.[a-z]{2})$/;
function workAddress(rows, owner, own) {
  const names = ownNames(owner), seen = {};
  for (const r of rows) {
    if (!r.real) continue; // only an opened mail carries the whole address
    const [local, domain] = String(r.sent ? r.to : r.from).split("@");
    if (!domain || `${local}@${domain}` === own || PERSONAL_DOMAINS.includes(domain) || NOT_A_WORKPLACE.test(domain) || !isOwnName(local, names)) continue;
    seen[domain] = (seen[domain] || 0) + 1;
  }
  const [domain, mails] = Object.entries(seen).sort((a, b) => b[1] - a[1])[0] || [];
  return domain ? { domain, mails } : null;
}

function stage(k, state, n) {
  const li = $(`#stages [data-k="${k}"]`);
  li.classList.remove("now", "done");
  if (state) li.classList.add(state);
  if (n !== undefined) li.querySelector("[data-n]").textContent = n;
}
const bar = (f) => ($("#bar").style.width = Math.round(f * 100) + "%");
const fmtN = (n) => n.toLocaleString("he-IL");

// ---------------------------------------------------------------- reading the few mails that need it
// Most of the mailbox stays unread. These searches pick mail about where someone lives, works and flies, newest first and
// capped. The text stays in this function: only a city, an employer, destinations and profile links leave it
const SCOPE_RX = /(?:היקף|אחוז|חלקיות)\s*משרה\D{0,12}(\d{2,3})/;
const READ_TOPICS = {
  residence: { q: 'subject:(חוזה OR הסכם OR שכירות OR ארנונה OR עירייה OR "תאגיד המים" OR "חשבון מים")', max: 40, pdf: true },
  work: { q: 'subject:("תלוש שכר" OR "תלוש משכורת" OR "אישור העסקה" OR "טופס 106" OR payslip)', max: 15, pdf: true },
  flights: { q: 'subject:(טיסה OR "boarding pass" OR itinerary OR "כרטיס טיסה") -subject:(פרסומת OR מבצע OR הגרלה)', max: 25, pdf: false },
};
// A CV the person sent themselves. Each is its own search, since a file name and a subject cannot share one
const CV_QUERIES = ["filename:cv", "filename:resume", "filename:קורות", "filename:קוח", 'subject:"קורות חיים"', "subject:cv", "subject:resume"].map((q) => `in:sent has:attachment ${q}`);
const SOCIAL = [
  ["LinkedIn", "from:linkedin.com", /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/comm\/in\/([A-Za-z0-9%_-]+)\?[^"'\s]*trk=[^"'\s]*header-0-profile_glimmer/, (u) => `https://www.linkedin.com/in/${u}`],
  ["Instagram", "from:instagram.com", /instagram\.com\/_n\/user\?[^"']*?username=([A-Za-z0-9._]+)[^"']*?click_source=(?:header|footer)_profile_pic/, (u) => `https://www.instagram.com/${u}`],
  ["Facebook", "from:facebookmail.com", /facebook\.com\/nd\/\?(\d{8,})&[^"']*lloc=logo/, (u) => `https://www.facebook.com/profile.php?id=${u}`],
  ["GitHub", "from:github.com", /signed in as\s*<strong>([A-Za-z0-9-]+)<\/strong>/, (u) => `https://github.com/${u}`],
];
const CITIES = [["תל אביב", "תל-אביב", "Tel Aviv"], ["ירושלים", "Jerusalem"], ["חיפה", "Haifa"], ["ראשון לציון"], ["פתח תקווה", "פתח תקוה"], ["אשדוד"], ["נתניה"], ["באר שבע"], ["בני ברק"], ["חולון"], ["רמת גן"], ["אשקלון"], ["רחובות"], ["בת ים"], ["בית שמש"], ["כפר סבא"], ["הרצליה"], ["חדרה"], ["מודיעין"], ["נצרת"], ["לוד"], ["רמלה"], ["רעננה"], ["גבעתיים"], ["הוד השרון"], ["נהריה"], ["קרית גת", "קריית גת"], ["קרית אתא", "קריית אתא"], ["קרית מוצקין", "קריית מוצקין"], ["קרית ביאליק", "קריית ביאליק"], ["קרית ים", "קריית ים"], ["קרית אונו", "קריית אונו"], ["קרית שמונה", "קריית שמונה"], ["קרית מלאכי", "קריית מלאכי"], ["אילת"], ["עכו"], ["טבריה"], ["צפת"], ["עפולה"], ["כרמיאל"], ["דימונה"], ["אופקים"], ["נתיבות"], ["שדרות"], ["יבנה"], ["נס ציונה"], ["רמת השרון"], ["ראש העין"], ["גבעת שמואל"], ["אור יהודה"], ["יהוד"], ["אריאל"], ["מעלה אדומים"], ["ביתר עילית"], ["מודיעין עילית"], ["גדרה"], ["זכרון יעקב"], ["פרדס חנה"], ["קיסריה"], ["טירת כרמל"], ["נשר"], ["מגדל העמק"], ["יקנעם"], ["עומר"], ["מיתר"], ["להבים"], ["ערד"], ["קצרין"], ["שוהם"], ["כוכב יאיר"]];
const DESTINATIONS = [["אתונה", "Athens"], ["לונדון", "London"], ["פריז", "Paris"], ["רומא", "Rome"], ["מילאנו", "Milan"], ["ברצלונה", "Barcelona"], ["מדריד", "Madrid"], ["ברלין", "Berlin"], ["אמסטרדם", "Amsterdam"], ["פראג", "Prague"], ["בודפשט", "Budapest"], ["וינה", "Vienna"], ["ורשה", "Warsaw"], ["בוקרשט", "Bucharest"], ["סופיה", "Sofia"], ["לרנקה", "Larnaca"], ["פאפוס", "Paphos"], ["כרתים", "Crete", "Heraklion"], ["רודוס", "Rhodes"], ["סלוניקי", "Thessaloniki"], ["דובאי", "Dubai"], ["ניו יורק", "New York"], ["לוס אנג'לס", "Los Angeles"], ["מיאמי", "Miami"], ["בנגקוק", "Bangkok"], ["טוקיו", "Tokyo"], ["ליסבון", "Lisbon"], ["דבלין", "Dublin"], ["ציריך", "Zurich"], ["ז'נבה", "Geneva"], ["מינכן", "Munich"], ["פרנקפורט", "Frankfurt"], ["בטומי", "Batumi"], ["טביליסי", "Tbilisi"], ["מרקש", "Marrakech"]];
const wordRx = (names) => new RegExp(`(?:^|[^א-תA-Za-z])(?:[בלמה])?(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=$|[^א-תA-Za-z])`, "gi");
const CITY_RX = CITIES.map((c) => [c[0], wordRx(c)]);
const DEST_RX = DESTINATIONS.map((c) => [c[0], wordRx(c)]);
const PLACE_STRONG = /המושכר|הנכס|כתובת הנכס|מקום המגורים|property/i;
const PLACE_WEAK = /כתובת|ברחוב|רחוב|רח'|מען|בעיר|ביישוב|address/i;
const EMPLOYER_RX = /(?:שם המעסיק|שם מעסיק|מעסיק|employer)\s*[:：]\s*([^\n\r|,;<]{2,30})/i;

// A Hebrew PDF often stores its words in visual order, so each is tried both ways
const bothWays = (t) => [t, t.split(/\s+/).map((w) => (/[א-ת]/.test(w) ? [...w].reverse().join("") : w)).join(" ")];
function placeScore(text) {
  let best = null, bestScore = 0;
  for (const variant of bothWays(text)) for (const [name, rx] of CITY_RX) {
    let score = 0;
    for (const m of variant.matchAll(rx)) {
      const around = variant.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20);
      score += PLACE_STRONG.test(around) ? 3 : PLACE_WEAK.test(around) ? 1 : 0;
    }
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best ? [best, Math.min(bestScore, 3)] : null;
}
function decodePart(body, part) {
  const raw = atob(body.data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const ct = (part.headers || []).find((h) => h.name.toLowerCase() === "content-type")?.value || "";
  const charset = /charset="?([\w-]+)/i.exec(ct)?.[1] || "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
function partsOf(p, out = []) {
  if (p) { out.push(p); (p.parts || []).forEach((x) => partsOf(x, out)); }
  return out;
}
let pdfReady = null;
function loadPdf() {
  pdfReady ??= new Promise((res, rej) => {
    const s = Object.assign(document.createElement("script"), { src: "vendor/pdf.min.js", onload: res, onerror: rej });
    document.head.append(s);
  }).then(() => { pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; });
  return pdfReady;
}
async function pdfText(data) {
  await loadPdf();
  const bytes = Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  let text = "";
  for (let i = 1; i <= Math.min(doc.numPages, 6); i++) text += " " + (await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(" ");
  await doc.destroy();
  return text;
}

// ---------------------------------------------------------------- reading a CV
// A Word file is a zip: only the document itself and its page headers are unpacked, with what the browser already has
const fileBytes = (data) => Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function inflate(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}
async function docxText(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip");
  let p = v.getUint32(end + 16, true);
  const parts = [];
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true), at = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (/^word\/(document|header\d*)\.xml$/.test(name)) {
      const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
      const raw = bytes.subarray(start, start + size);
      const xml = new DOMParser().parseFromString(new TextDecoder().decode(method === 8 ? await inflate(raw) : raw), "application/xml");
      const lines = [...xml.getElementsByTagName("w:p")].map((x) => [...x.getElementsByTagName("w:t")].map((t) => t.textContent).join("")).filter((l) => l.trim());
      parts[name === "word/document.xml" ? "push" : "unshift"](lines.join("\n")); // the page header first: a name often sits there
    }
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return parts.join("\n");
}
// A PDF as lines: the pieces of one line share a height on the page
async function pdfLines(bytes) {
  await loadPdf();
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, 6); i++) {
    const byHeight = new Map();
    for (const it of (await (await doc.getPage(i)).getTextContent()).items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!byHeight.has(y)) byHeight.set(y, []);
      byHeight.get(y).push(it);
    }
    for (const y of [...byHeight.keys()].sort((a, b) => b - a)) {
      // Hebrew runs from the right, so the pieces of a Hebrew line are taken from the right
      const row = byHeight.get(y), rtl = row.some((x) => /[א-ת]/.test(x.str));
      out.push(row.sort((a, b) => (rtl ? b.transform[4] - a.transform[4] : a.transform[4] - b.transform[4])).map((x) => x.str).join(" ").replace(/\s+/g, " ").trim());
    }
  }
  await doc.destroy();
  return out.join("\n");
}
const CV_WORDS = /ניסיון|נסיון|השכלה|תעסוקה|לימודים|כישורים|מיומנויות|experience|education|employment|skills/gi;
// A Hebrew PDF may keep each word backwards: the reading with more known words is the right one
function readable(text) {
  const flipped = text.split("\n").map((l) => l.split(/(\s+)/).map((w) => (/[א-ת]/.test(w) ? [...w].reverse().join("") : w)).join("")).join("\n");
  return (flipped.match(CV_WORDS) || []).length > (text.match(CV_WORDS) || []).length ? flipped : text;
}
// The owner's first and family name close together in a text: how a CV opens. One of the two alone is someone else
function ownNameIn(text, names) {
  const words = String(text || "").toLowerCase().match(/[a-zא-ת]+/g) || [];
  const pairs = [...names.first].flatMap((f) => [...names.last].map((l) => [f, l])).filter(([f, l]) => f && l && f.length + l.length >= 4);
  const keys = words.map((w) => (w.length >= 2 ? skeletons(w) : []));
  return words.some((_, i) => pairs.some(([f, l]) => keys[i].includes(f) &&
    [1, 2, 3].some((d) => [i - d, i + d].some((j) => keys[j]?.includes(l) || (keys[j] && keys[j + 1] && skeletons(words[j] + words[j + 1]).includes(l))))));
}
// Only years are taken from a CV. What a job was, and where, is written in too many ways for a rule to read it right
const CV_NOW = "היום|כיום|עכשיו|הווה|today|present|current|now";
const CV_RANGE = new RegExp(`(?:\\d{1,2}[./])?((?:19|20)\\d\\d)\\s*(?:[-–—]|עד|to)\\s*(?:\\d{1,2}[./])?((?:19|20)\\d\\d|${CV_NOW})`, "i");
const CV_SECTIONS = [["work", /ניסיון|נסיון|תעסוקה|קריירה|experience|employment|career/i], ["study", /השכלה|לימודים|education|academic/i],
  ["other", /מיומנויות|כישורים|skills|שפות|languages|התנדבות|volunteer|צבא|שירות לאומי|military|summary|תקציר|פרויקטים|projects|tools/i]];
// The work and study parts of a CV, for the AI and only with the person's tick. Nothing that names or reaches the person
// comes along: the top of the file is never taken, and a line with a contact detail, a long number or family matters is dropped
const CV_PRIVATE = /@|https?:|www\.|\d{5,}|\d{2,3}[- ]\d{3}[- ]?\d{4}|ת\.?ז\.?|תעודת זהות|תאריך לידה|יליד|נשוי|נשואה|רווק|גרוש|ילדים|אמא ל|אבא ל|born|married|רחוב|רח'|כתובת|address/i;
function cvLines(text, names) {
  const out = [];
  let section = null;
  for (const line of text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const heading = line.length < 45 && !CV_RANGE.test(line) && CV_SECTIONS.find(([, rx]) => rx.test(line));
    if (heading) { section = heading[0]; continue; }
    if ((section !== "work" && section !== "study") || CV_PRIVATE.test(line) || ownNameIn(line, names)) continue;
    out.push(line.slice(0, 165));
    if (out.length >= 40) break;
  }
  return out;
}
function cvCurrentSince(text) {
  let section = null, since = null;
  const thisYear = new Date().getFullYear();
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const range = CV_RANGE.exec(line);
    const heading = line.length < 45 && !range && CV_SECTIONS.find(([, rx]) => rx.test(line));
    if (heading) { section = heading[0]; continue; }
    if (!range || /^\d/.test(range[2]) || (section && section !== "work")) continue; // a job that is still going on
    const from = Number(range[1]);
    if (from >= 1960 && from <= thisYear && (since === null || from > since)) since = from;
  }
  return since;
}

async function readRelevant(search, pool, drop, senders) {
  const out = { links: {}, body_reads: 0, pdf_read: 0, pdf_failed: 0, cv_files: 0 };
  const [rules, hashes] = await Promise.all(["rules", "excluded_hashes"].map((f) => fetch(`engine/${f}.json`).then((r) => r.json())));
  const hidden = new Set(hashes.sha256);
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // The same policy as the engine: mail from an excluded kind of sender is never decoded
  const blocked = async (domain) => {
    const parts = domain.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts.slice(i).join(".");
      if (senders[d] && senders[d].sector in rules.excluded_sectors) return true;
      if (hidden.has(await sha(d))) return true;
    }
    return false;
  };
  const headerOf = (g, n) => (g.payload?.headers || []).find((h) => h.name.toLowerCase() === n)?.value || "";
  async function fetchMail(id) {
    const g = await gget(`${API}/messages/${id}?format=full`, READ_UNITS);
    const domain = addrOf(headerOf(g, "from")).split("@")[1] || "";
    if (await blocked(domain)) return null;
    out.body_reads++;
    return g;
  }
  const textOf = (g) => partsOf(g.payload).filter((p) => p.body?.data && /^text\//.test(p.mimeType || "")).map((p) => {
    const t = decodePart(p.body, p);
    return p.mimeType === "text/html" ? new DOMParser().parseFromString(t, "text/html").body.textContent : t;
  }).join(" ");
  let pdfBudget = 12;
  async function pdfsOf(g) {
    const texts = [];
    for (const p of partsOf(g.payload)) {
      if (!/\.pdf$/i.test(p.filename || "") || !p.body?.attachmentId || p.body.size > 4e6 || pdfBudget <= 0) continue;
      pdfBudget--;
      try {
        const a = await gget(`${API}/messages/${g.id}/attachments/${p.body.attachmentId}`, READ_UNITS);
        texts.push(await pdfText(a.data));
        out.pdf_read++;
      } catch (e) { out.pdf_failed++; } // scanned or password protected: nothing to read
    }
    return texts;
  }
  const idsFor = async (q, max) => (await search(q)).filter((m) => !drop.has(m.id)).slice(0, max).map((m) => m.id);
  const when = (id) => new Date(idTime(id)).toISOString().slice(0, 10);

  const cities = {};
  await pool(await idsFor(READ_TOPICS.residence.q, READ_TOPICS.residence.max), 4, async (id) => {
    const g = await fetchMail(id);
    if (!g) return;
    const found = placeScore([textOf(g), ...(await pdfsOf(g))].join(" "));
    if (!found) return;
    const c = (cities[found[0]] ??= { name: found[0], votes: 0, mails: 0, first: when(id), last: when(id) });
    c.votes += found[1]; c.mails++;
    if (when(id) < c.first) c.first = when(id);
    if (when(id) > c.last) c.last = when(id);
  });
  out.city = Object.values(cities).sort((a, b) => b.votes - a.votes)[0] || null;

  const employers = {};
  const scopes = {};
  await pool(await idsFor(READ_TOPICS.work.q, READ_TOPICS.work.max), 4, async (id) => {
    const g = await fetchMail(id);
    if (!g) return;
    const text = [textOf(g), ...(await pdfsOf(g))].join(" ");
    const m = EMPLOYER_RX.exec(text);
    if (m) { const name = m[1].trim(); employers[name] = (employers[name] || 0) + 1; }
    const pct = Number(SCOPE_RX.exec(text)?.[1]);
    if (pct >= 10 && pct <= 100) scopes[pct] = (scopes[pct] || 0) + 1;
  });
  const [scope, scopeN] = Object.entries(scopes).sort((a, b) => b[1] - a[1])[0] || [];
  if (scope) out.job_scope = { pct: Number(scope), mails: scopeN };
  const [employer, employerN] = Object.entries(employers).sort((a, b) => b[1] - a[1])[0] || [];
  if (employerN >= 2) out.employer = { name: employer, mails: employerN };

  // The person's own CV: the newest file they sent that opens with their own name. One they passed on for someone else
  // fails that check. The engine gets two things: since when the current job, and when the file was sent. With the AI
  // box ticked, the work and study lines are kept for the AI as well
  const names = ownNames(S.owner), cvIds = new Set();
  await pool(CV_QUERIES, 4, async (q) => (await idsFor(q, 6)).forEach((id) => cvIds.add(id)));
  let cvBudget = 8;
  for (const id of [...cvIds].sort((a, b) => idTime(b) - idTime(a))) {
    if (out.cv || cvBudget <= 0) break;
    const g = await fetchMail(id);
    for (const p of g ? partsOf(g.payload) : []) {
      if (out.cv || cvBudget <= 0 || !/\.(pdf|docx)$/i.test(p.filename || "") || !p.body?.attachmentId || p.body.size > 4e6) continue;
      cvBudget--;
      try {
        const bytes = fileBytes((await gget(`${API}/messages/${g.id}/attachments/${p.body.attachmentId}`, READ_UNITS)).data);
        const text = readable(/\.docx$/i.test(p.filename) ? await docxText(bytes) : await pdfLines(bytes));
        out.cv_files++;
        if ((text.match(CV_WORDS) || []).length < 2 || !ownNameIn(text.slice(0, 600), names)) continue;
        out.cv = { current_since: cvCurrentSince(text), sent: when(id).slice(0, 7) };
        S.cvLines = $("#ai-ok").checked ? cvLines(text, names) : []; // kept apart from what the engine gets, and only for the AI
      } catch (e) { out.pdf_failed++; }
    }
  }

  const dests = {};
  await pool(await idsFor(READ_TOPICS.flights.q, READ_TOPICS.flights.max), 4, async (id) => {
    const g = await fetchMail(id);
    if (!g) return;
    const t = textOf(g);
    for (const [name, rx] of DEST_RX) { rx.lastIndex = 0; if (rx.test(t)) dests[name] = (dests[name] || 0) + 1; }
  });
  out.destinations = Object.entries(dests).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);

  // The link is rebuilt from a checked name, so a login token in the mail's own link never comes along
  await pool(SOCIAL, 4, async ([name, q, rx, make]) => {
    for (const id of (await search(q)).slice(0, 5).map((m) => m.id)) {
      const g = await fetchMail(id);
      if (!g) continue;
      const html = partsOf(g.payload).filter((p) => p.body?.data && p.mimeType === "text/html").map((p) => decodePart(p.body, p)).join(" ");
      const u = (name === "GitHub" && headerOf(g, "x-github-recipient")) || rx.exec(html)?.[1];
      if (u && /^[A-Za-z0-9._%-]+$/.test(u)) { out.links[name] = make(u); break; }
    }
  });
  return out;
}

// ---------------------------------------------------------------- the web and public registries
// Only if the participant left the box ticked, and only their own name: never a household member's. Every failure just
// leaves the rows out, since none of this is needed for the report
const REGISTRY_API = "https://data.gov.il/api/3/action/datastore_search";
const REGISTRIES = [
  { title: "רואה/ת חשבון", id: "7e86def9-0899-45f4-8942-d6fe38482b1a", name: (r) => `${r["שם פרטי"]} ${r["שם משפחה"]}`, detail: (r) => `רישיון ${r["מספר רישיון"]}, ${r["סטטוס"]}`, city: (r) => r["ישוב"] },
  { title: "רופא/ה", id: "9c64c522-bbc2-48fe-96fb-3b2a8626f59e", name: (r) => `${r["שם פרטי"]} ${r["שם משפחה"]}`, detail: (r) => `רישיון ${r["מספר רישיון רופא"]}`, city: () => "" },
  { title: "מתווך/ת", id: "a0f56034-88db-4132-8803-854bcdb01ca1", name: (r) => r["שם המתווך"], detail: (r) => `רישיון ${r["מס רשיון"]}`, city: (r) => r["עיר מגורים"] },
  { title: "שמאי/ת מקרקעין", id: "8540534a-eccd-4568-a677-652d589ed172", name: (r) => r["שם שמאי"], detail: (r) => `רישיון ${r["מספר רשיון"]}`, city: (r) => r["עיר"] },
  { title: "עובד/ת סוציאלי/ת", id: "0f25d8f5-eecc-4d63-8914-38d59f19925b", name: (r) => `${r["שם-פרטי"]} ${r["שם-משפחה"]}`, detail: (r) => `רישום ${r["מספר רישום"]}`, city: (r) => r["ישוב מגורים"] },
  { title: "קבלן/ית", id: "4eb61bd6-18cf-4e7c-9f9c-e166dfa0a2d8", name: (r) => r.SHEM_YESHUT || "", detail: (r) => `קבלן ${r.MISPAR_KABLAN}, ${r.TEUR_ANAF}`, city: (r) => r.SHEM_YISHUV || "" },
];
const COMPANY_REGISTRY = { title: "חברה", id: "f004176c-b85f-4542-8901-7b3176f9a054", name: (r) => r["שם חברה"], detail: (r) => `ח.פ. ${r["מספר חברה"]}, ${r["סטטוס חברה"]}`, city: (r) => r["שם עיר"] || "" };
const nameWords = (s) => String(s || "").replace(/[‎‏‪-‮⁦-⁩]/g, " ").replace(/["'`~\-–־.,()|]/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
const hasAllWords = (text, name) => { const w = new Set(nameWords(text)); const q = nameWords(name); return q.length >= 2 && q.every((x) => w.has(x)); };
const sameCity = (a, b) => { const x = nameWords(a).join(""), y = nameWords(b).join(""); return !!x && !!y && (x.includes(y) || y.includes(x)); };

async function registryRows(reg, name, city) {
  const r = await fetch(`${REGISTRY_API}?resource_id=${reg.id}&limit=200&q=${encodeURIComponent(name)}`);
  if (!r.ok) return [];
  const rows = (await r.json()).result?.records || [];
  const exact = rows.filter((x) => hasAllWords(reg.name(x), name));
  // People share names, so a registry entry counts only when its city agrees, or when it's the only one with that name
  const inCity = exact.filter((x) => sameCity(reg.city(x), city));
  const sure = inCity.length ? inCity : exact.length === 1 ? exact : [];
  return sure.slice(0, 3).map((x) => `${reg.title}: ${reg.detail(x)}${inCity.length ? "" : " (לפי השם בלבד)"}`);
}

const ACHIEVEMENT_RX = /אלוף|אלופת|מקום ראשון|זכה ב|זכתה ב|champion|winner/i;
const SKIP_MENTIONS = /(^|\.)(psakdin|nevo|takdin|lawdata|dinimveod)\.co\.il$|(^|\.)gov\.il$/; // a court page under a shared name would accuse the wrong person
const NETWORK_LINKS = [
  ["LinkedIn", /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9%_-]+)\/?$/, (u) => `https://www.linkedin.com/in/${u}`],
  ["Instagram", /^https:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?$/, (u) => `https://www.instagram.com/${u}`],
  ["Facebook", /^https:\/\/(?:[a-z-]+\.)?facebook\.com\/([A-Za-z0-9.]{5,})\/?$/, (u) => `https://www.facebook.com/${u}`],
  ["GitHub", /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/, (u) => `https://github.com/${u}`],
];
async function webHits(queries) {
  if (!CFG.sendUrl || CFG.sendUrl.startsWith("PASTE")) return [];
  const r = await fetch(CFG.sendUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ kind: "imtrustme-search", queries }) });
  const reply = await r.json();
  return reply.ok ? reply.results || [] : [];
}
async function lookupOutside(city, account) {
  const out = { licenses: [], companies: [], mentions: [], web_links: {} };
  if (!$("#web-ok").checked) return out;
  const nameHe = S.owner.name_he;
  const nameEn = S.owner.name_en || (/^[A-Za-z][A-Za-z.' -]+ [A-Za-z.' -]+$/.test(account || "") ? account.trim() : null);
  const settle = async (p) => { try { return await p; } catch (e) { console.warn("outside lookup failed", e); return []; } };
  const [licenses, companies, hits] = await Promise.all([
    Promise.all(REGISTRIES.map((reg) => settle(registryRows(reg, nameHe, city)))),
    settle(registryRows(COMPANY_REGISTRY, nameHe, city)),
    settle(webHits([`"${nameHe}"`, nameEn && `"${nameEn}"`, `site:linkedin.com/in "${nameEn || nameHe}"`].filter(Boolean))),
  ]);
  out.licenses = licenses.flat();
  out.companies = companies;
  const seen = new Set();
  for (const h of hits) {
    const link = String(h.link || "");
    if (!/^https:\/\//.test(link) || seen.has(link)) continue;
    seen.add(link);
    if (!hasAllWords(`${h.title} ${h.snippet}`, nameHe) && !(nameEn && hasAllWords(`${h.title} ${h.snippet}`, nameEn))) continue;
    const domain = new URL(link).hostname.replace(/^www\./, "");
    const net = NETWORK_LINKS.map(([n, rx, make]) => { const m = rx.exec(link.split("?")[0]); return m && [n, make(m[1])]; }).find(Boolean);
    if (net) {
      out.web_links[net[0]] ??= net[1];
      if (net[0] === "LinkedIn") (S.linkedinHits ??= []).push({ url: net[1], text: `${h.title} ${h.snippet}` });
      continue;
    }
    if (/linkedin|facebook|instagram|tiktok|twitter|x\.com/.test(domain) || SKIP_MENTIONS.test(domain)) continue;
    out.mentions.push({ text: `${String(h.title || domain).slice(0, 70)} (${domain})`, url: link.split("#")[0] });
  }
  const standsOut = (m) => (ACHIEVEMENT_RX.test(m.text) ? 0 : 1);
  out.mentions = out.mentions.sort((a, b) => standsOut(a) - standsOut(b)).slice(0, 5);
  return out;
}

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
  const search = (q) => list("q=" + encodeURIComponent(`${widenSubjects(q)} ${after}`));

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
  let show = () => {
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

  const [senders, labels, orgs] = await Promise.all(["senders", "labels", "orgs"].map((f) => fetch(`engine/${f}.json`).then((r) => r.json())));
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
  // mail from or to another address in the owner's own name: opened, since where that address lives says where they work
  await pool([S.owner.name_he, S.owner.name_en].filter(Boolean).map((n) => `"${n.replace(/"/g, "")}"`), 2, async (n) => {
    (await search(`from:${n} -in:sent`)).slice(0, 10).forEach((m) => toOpen.add(m.id));
    (await search(`in:sent to:${n}`)).slice(0, 10).forEach((m) => toOpen.add(m.id));
  });
  if ($("#ai-ok").checked) await pool(AI_TOPICS, 4, async (q) => { (await search(q)).slice(0, 25).forEach((m) => toOpen.add(m.id)); });
  await pool([...toOpen], 4, open);
  // The report stands without this: a failure here costs a city, not the run
  const readOut = await readRelevant(search, pool, drop, { ...orgs, ...senders }).catch((e) => { console.warn("targeted reading stopped", e); return { links: {}, body_reads: 0, pdf_read: 0, pdf_failed: 0, cv_files: 0 }; });
  const outside = await lookupOutside(readOut.city?.name || "", [...senderName.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]).catch((e) => { console.warn("outside lookup stopped", e); return {}; });

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
        sent_checked: sentChecked, mailbox_since, interests, insights, receipt_ids: receiptIds, read_out: readOut, outside,
        work_address: workAddress(rows.values(), S.owner, own) } });
    }).then((r) => ({ r, counted }));
  };
  const first = await runEngine();
  S.run = { messages: first.counted, listed: total, skipped_promotions: skipped, reads, complete: false, mailbox_since,
            report_seconds: Math.round((performance.now() - t0) / 1000) };
  Object.assign(S.run, { body_reads: readOut.body_reads, pdf_read: readOut.pdf_read, pdf_failed: readOut.pdf_failed, cv_files: readOut.cv_files });
  S.result = first.r;
  stage("engine", "done");
  // The report is shown once, when everything behind it is finished, so nothing changes under the reader's eyes.
  // Until then this screen stays, with the rest of the work as its own stages
  show = () => showBackground(total - pending.size, total);
  show();
  S.enrich = (async () => {
    await lookupEmployer(first.r).catch((e) => console.warn("employer lookup stopped", e));
    await askAi(first.r).catch((e) => console.warn("AI paragraph stopped", e));
    attachEmployer(S.result);
    attachAi(S.result);
  })();

  // everyone else: open one mail, learn the sender, ask for all of theirs. Newest first, until no mail is left
  // unaccounted for. The final run replaces the first result, so nothing is shown or sent from one that was only partial
  S.scanned = (async () => {
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
      stage("rest", "done", fmtN(total));
      stage("write", "now");
      $("#eta").textContent = "עוד רגע";
      const last = await runEngine();
      Object.assign(S.run, { messages: last.counted, reads, complete: true });
      await S.enrich;
      // a workplace that only the whole mailbox showed is looked up now
      await lookupEmployer(last.r).catch((e) => console.warn("employer lookup stopped", e));
      applyFinal(last.r);
    } catch (e) {
      console.warn("background read stopped", e); // the first result stands; the feedback says the count is partial
      S.run.reads = reads;
      await S.enrich;
    }
    S.run.read_seconds = Math.round((performance.now() - t0) / 1000);
    await revoke();
    rows.clear(); // the envelopes are not kept once the profile exists
    window.onbeforeunload = null;
  })();
  // The deeper conclusions are written from the whole mailbox, and only then does the report come up
  S.background = S.scanned.then(deepenAi).finally(() => {
    stage("rest", "done");
    stage("write", "done");
    bar(1);
    S.cvLines = []; // the AI has had its say, so the lines are not kept
    renderReport();
    go("s-report");
    const el = $("#bg-status");
    el.hidden = false;
    el.textContent = "הבדיקה הסתיימה, והגישה ל-Gmail בוטלה.";
  });
}

function showBackground(done, total) {
  stage("rest", "now", `${fmtN(done)} / ${fmtN(total)}`);
  bar(0.08 + 0.82 * (done / (total || 1)));
  $("#eta").textContent = "עוד כמה דקות";
}

// The final run replaces the report. Answers follow their row by its key, since rows can appear and move, and an answer
// on a value that has since changed is dropped: it was about something else
function applyFinal(r) {
  attachEmployer(r);
  attachAi(r);
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
// A profile link. Rebuilt from a checked name in readRelevant, and escaped here as well
const valHtml = (p) => (p.links ? (p.lead ? `${esc(p.lead)}<br>` : "") + p.links.filter((l) => /^https:\/\//.test(l.url)).map((l) => `<a class="row-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l.text)}</a>`).join("") : p.link && /^https:\/\//.test(p.link)
  ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer nofollow" dir="ltr">${esc(valText(p))}</a>` : esc(valText(p)));
const valText = (p) => (p.v === null ? p.why : p.v === 0 ? "0" : String(p.v));

// ---------------------------------------------------------------- the workplace
// Only facts: is it active, since when, and links to its own pages. Whether a company is "stable" would be an opinion
const dropCompanyWords = (s) => nameWords(s).filter((w) => !["בעמ", "בע", "מ", "ltd", "inc"].includes(w)).join(" ");
// Several people can share a name, so the page that mentions the workplace is the likelier one
const bestProfile = (hits, employer) => hits.find((h) => nameWords(employer).every((w) => nameWords(h.text).includes(w)))?.url;
const AGGREGATORS = /linkedin|facebook|instagram|wikipedia|youtube|tiktok|twitter|x\.com|gov\.il|drushim|alljobs|jobmaster|checkid|dunsguide|bdi|theworker|rocketreach|theorg|maariv|ynet|globes|calcalist|themarker/;
const DOMAIN_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const LINKEDIN_COMPANY = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\/[^/]+\/?$/;
const cleanUrl = (u) => String(u || "").split(/[?#]/)[0];
// A workplace known only by the domain of a work address: its own site says what it is, in its own words
async function lookupByDomain(domain) {
  const labels = domain.split(".").slice(0, -1);
  if (labels.length > 1 && /^(co|com|org|net|gov|muni)$/.test(labels[labels.length - 1])) labels.pop();
  const label = labels[labels.length - 1];
  const hits = await webHits([`site:${domain}`, `site:linkedin.com/company "${label}"`]);
  const hostOf = (h) => { try { return new URL(h.link).hostname.toLowerCase(); } catch { return ""; } };
  const site = hits.find((h) => /^https:\/\//.test(h.link || "") && (hostOf(h) === domain || hostOf(h).endsWith("." + domain)));
  const page = hits.find((h) => LINKEDIN_COMPANY.test(cleanUrl(h.link)) && nameWords(label).every((w) => nameWords(h.title).includes(w)));
  // the name as the organisation writes it, when its own page gives one
  const name = (page && String(page.title).split(/\s[|–-]\s/)[0].trim().slice(0, 40)) || domain;
  const links = [site && { text: `האתר של ${name}`, url: new URL(site.link).origin }, page && { text: `${name} ב-LinkedIn`, url: cleanUrl(page.link) }].filter(Boolean);
  if (!links.length) return;
  // a search result is cut mid-sentence, so only the whole sentences are kept
  const snippet = String(site?.snippet || "").replace(/\s+/g, " ").slice(0, 180);
  const whole = snippet.slice(0, snippet.lastIndexOf(". ") > 25 ? snippet.lastIndexOf(". ") : snippet.length).replace(/[\s.…]+$/, "");
  S.employer = { name, lead: whole, links, snippet: whole, note: "מחיפוש ברשת" };
}
async function lookupEmployer(r) {
  if (!$("#web-ok").checked || S.employer) return;
  const row = r.groups.flatMap((g) => g.params).find((p) => p.key === "employer");
  if (!row || row.outcome !== "found" || (row.note || "").includes("שולח")) return;
  const name = String(row.v);
  if (DOMAIN_NAME.test(name)) return lookupByDomain(name);
  const settle = async (p) => { try { return await p; } catch (e) { console.warn("employer lookup failed", e); return []; } };
  const [records, hits] = await Promise.all([
    settle(fetch(`${REGISTRY_API}?resource_id=${COMPANY_REGISTRY.id}&limit=50&q=${encodeURIComponent(name)}`).then((x) => x.json()).then((x) => x.result?.records || [])),
    settle(webHits([`"${name}"`, `site:linkedin.com/company "${name}"`])),
  ]);
  // The name people use is often shorter than the registered one. Only a single match counts, or it may be another company
  const wanted = nameWords(dropCompanyWords(name));
  const matches = records.filter((x) => wanted.length && wanted.every((w) => nameWords(x["שם חברה"]).includes(w)));
  const record = new Set(matches.map((x) => x["מספר חברה"])).size === 1 ? matches[0] : null;
  S.bestLinkedin = bestProfile(S.linkedinHits || [], name);
  const year = record && /\b(19|20)\d\d\b/.exec(String(record["תאריך התאגדות"]))?.[0];
  const linkedin = hits.map((h) => cleanUrl(h.link)).find((u) => LINKEDIN_COMPANY.test(u));
  const site = hits.find((h) => /^https:\/\//.test(h.link || "") && !AGGREGATORS.test(new URL(h.link).hostname) &&
    nameWords(h.title).some((w) => nameWords(name).includes(w)));
  const lead = record ? [`${record["סטטוס חברה"]}`, year && `התאגדה ב-${year}`, record["שם עיר"]].filter(Boolean).join(", ") : "";
  const links = [site && { text: `האתר של ${name}`, url: new URL(site.link).origin }, linkedin && { text: `${name} ב-LinkedIn`, url: linkedin }].filter(Boolean);
  if (!lead && !links.length) return;
  S.employer = { name, lead, links, snippet: String(site?.snippet || "").slice(0, 180) };
}
function attachEmployer(r) {
  const profileRow = r.groups.flatMap((g) => g.params).find((p) => p.key === "platform_linkedin");
  if (S.bestLinkedin && profileRow?.note?.includes("מישהו אחר")) {
    profileRow.link = S.bestLinkedin;
    profileRow.v = S.bestLinkedin.split("//")[1].replace(/^www\./, "");
    const item = (r.portrait || []).find((x) => x.label === "LinkedIn");
    if (item) item.url = S.bestLinkedin;
  }
  if (!S.employer || r.groups.some((g) => g.title === "מקום העבודה")) return;
  const { name, lead, links, note } = S.employer;
  r.groups.push({ title: "מקום העבודה", params: [{ label: `על ${name}`, v: [lead, ...links.map((l) => l.url)].filter(Boolean).join(" · "), lead, links, n: null, span: "", why: null,
    note: note || "מרשם החברות ומחיפוש ברשת", key: "employer_about", fb_label: "על מקום העבודה", detail: false, private: false, outcome: "found" }] });
}

// ---------------------------------------------------------------- the AI paragraph
// Only with the box ticked. The engine prepares the subjects (no digits, no addresses, no names it knows, no personal
// or excluded senders); nothing else goes out, and the participant's name is not sent. Each sentence becomes a report row
// with its own V, so it can be struck out like any other. Any failure just leaves the rows out
// Subjects are known only for mail that was opened, so these topics get opened too (the envelope only, never the body)
const AI_TOPICS = [
  'subject:(משכנתא OR נכס OR טאבו OR "הסכם מכר" OR "חוזה מכר" OR "מס רכישה" OR "רישום זכויות" OR "ועד בית")',
  'subject:("מעבר דירה" OR "שינוי כתובת" OR "העברת חשבון" OR "החלפת משלם" OR ארנונה)',
  'subject:(סמסטר OR "אישור לימודים" OR תואר OR מלגה OR "שכר לימוד" OR קורס OR הסמכה OR certificate)',
  'subject:("כתב מינוי" OR קידום OR "חוזה העסקה" OR "אישור העסקה" OR offer OR promotion)',
  'subject:("עוסק מורשה" OR "עוסק פטור" OR "רשם החברות" OR "דוח שנתי" OR "פתיחת תיק")',
  'subject:(תחרות OR אליפות OR זכית OR "מקום ראשון" OR תעודה OR competition OR winner)',
  'subject:(התנדבות OR מילואים OR הרצאה OR כנס OR conference)',
  'in:sent subject:(חוזה OR הסכם OR משכנתא OR "מעבר דירה" OR ביטוח)',
];
const AI_GROUP = "מה AI הבין מהנושאים", AI_SUMMARY = "בקצרה", FACTS_TOPIC = "עובדות", CV_ROW = "קורות חיים ששלחת";
const AI_BLOCKED = /דקדקן|יסודי|אמין|אחראי|מומלץ|ציון|סיכון|משכיר|שוכר|שכירות|שכר דירה/;
async function askAi(r, deep = false) {
  if (!$("#ai-ok").checked || !r.ai_input?.length || !CFG.sendUrl || CFG.sendUrl.startsWith("PASTE")) return;
  // Facts from the report come first, so a sentence built on one can be taken down when its row is blacked out
  const facts = (r.ai_facts || []).map((x) => ({ label: x.label, line: ["", "עובדה מהדוח", x.text.slice(0, 190)] }));
  if (S.employer?.snippet) facts.push({ label: null, line: ["", "על מקום העבודה", `${S.employer.name}: ${S.employer.snippet}`.slice(0, 190)] });
  // the person's own words about their work and studies. Tied to the CV row, so blacking it out takes these conclusions too
  (S.cvLines || []).forEach((l) => facts.push({ label: CV_ROW, line: ["", "עובדה מהדוח", `מתוך קורות חיים: ${l}`.slice(0, 190)] }));
  const items = [...facts.map((x) => x.line), ...r.ai_input.map((x) => [x.d, x.o, x.s])];
  const reply = await fetch(CFG.sendUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: AbortSignal.timeout(deep ? 300000 : 90000),
    body: JSON.stringify({ kind: "imtrustme-ai", items, ...(deep ? { deep: true } : {}) }) }).then((x) => x.json());
  if (!reply.ok) { console.warn("AI paragraph not written:", reply.error); return; }
  const valid = (x) => typeof x.text === "string" && x.text.length <= 220 && !AI_BLOCKED.test(x.text) &&
    Array.isArray(x.sources) && x.sources.length && x.sources.every((i) => Number.isInteger(i) && i >= 0 && i < items.length);
  const withLabels = (x) => ({ ...x, labels: x.sources.map((i) => facts[i]?.label).filter(Boolean) });
  S.ai = (reply.sentences || []).filter(valid).slice(0, 12).map(withLabels);
  const summary = (reply.summary || []).filter(valid).filter((x) => typeof x.topic === "string" && x.topic.length <= 30).slice(0, 10).map(withLabels);
  if (deep && !summary.length) return false; // the first reading stays
  S.aiSummary = summary;
  S.run.ai_sentences = S.ai.length + S.aiSummary.length;
  return true;
}
// The first conclusions come with the report and rest on what was known then. Once the whole mailbox is read they are
// written again from all of it, more slowly. Gmail access is already gone by now: this reads only what the report holds
async function deepenAi() {
  if ($("#s-done").classList.contains("on") || !S.result?.ai_input?.length) return;
  try {
    if (!(await askAi(S.result, true))) return;
    const next = structuredClone(S.result);
    next.groups = next.groups.filter((g) => g.title !== AI_SUMMARY && g.title !== AI_GROUP);
    applyFinal(next);
    followBlackouts();
  } catch (e) {
    console.warn("deep conclusions stopped", e);
  }
}
function attachAi(r) {
  const row = (x, i, prefix, label) => ({ label, v: x.text, n: x.sources.length, span: "", why: null, note: "נכתב על ידי AI, ייתכנו טעויות", source_labels: x.labels,
    key: `${prefix}_${i}`, fb_label: `משפט AI ${prefix} ${i + 1}`, detail: false, private: false, outcome: "found" });
  if (S.aiSummary?.length && !r.groups.some((g) => g.title === AI_SUMMARY)) r.groups.push({ title: AI_SUMMARY, params: S.aiSummary.map((x, i) => row(x, i, "ai_summary", x.topic)) });
  if (S.ai?.length && !r.groups.some((g) => g.title === AI_GROUP)) r.groups.push({ title: AI_GROUP, params: S.ai.map((x, i) => row(x, i, "ai", `משפט ${i + 1}`)) });
}
const rowsOf = (title) => { const gi = S.result.groups.findIndex((g) => g.title === title); return gi < 0 ? [] : S.result.groups[gi].params.map((p, pi) => ({ p, id: `${gi}.${pi}` })); };
const visibleRows = (title) => rowsOf(title).filter(({ id }) => !isHidden(id)).map(({ p }) => p);
const aiText = () => visibleRows(AI_GROUP).map((p) => p.v).join(" ");
// A sentence built on a row goes when that row is blacked out, so nothing comes back through the AI
function followBlackouts() {
  if (!S.hidden) return;
  const ids = {};
  S.result.groups.forEach((g, gi) => g.params.forEach((p, pi) => { ids[p.label] = `${gi}.${pi}`; }));
  for (const title of [AI_SUMMARY, AI_GROUP]) for (const { p, id } of rowsOf(title)) {
    if (!S.hidden.has(id) && (p.source_labels || []).some((l) => S.hidden.has(ids[l]))) { S.hidden.add(id); refreshRow(id); }
  }
}
// The links shown at the top: only for rows still visible
function topLinks() {
  const out = [];
  const ids = {};
  S.result.groups.forEach((g, gi) => g.params.forEach((p, pi) => { ids[p.label] = `${gi}.${pi}`; }));
  for (const x of S.result.portrait || []) if (x.url && !isHidden(ids[x.label])) out.push({ text: x.label, url: x.url });
  const employer = rowsOf("מקום העבודה")[0];
  if (employer && !isHidden(employer.id)) out.push(...employer.p.links);
  return out.filter((l) => /^https:\/\//.test(l.url));
}
function summaryLines() {
  const summary = visibleRows(AI_SUMMARY).map((p) => ({ topic: p.label, text: p.v }));
  const employer = rowsOf("מקום העבודה")[0];
  if (employer && !isHidden(employer.id) && employer.p.lead) summary.push({ topic: "עבודה", text: `${S.employer.name}: ${employer.p.lead}.` });
  if (summary.length) summary.unshift(...factLines());
  return summary;
}
// The fixed facts are the engine's, one to a line, and open the summary whoever wrote the rest of it.
// A line goes down with any row it rests on
function factLines() {
  const ids = {};
  S.result.groups.forEach((g, gi) => g.params.forEach((p, pi) => { ids[p.label] = `${gi}.${pi}`; }));
  return (S.result.portrait || []).filter((x) => x.topic === FACTS_TOPIC && ![x.label, ...(x.needs || [])].some((l) => isHidden(ids[l])))
    .map((x) => ({ topic: x.topic, text: x.text }));
}

// The paragraph follows the rows: a row blacked out takes its sentence with it, so nothing can go out through here
function portraitLines(mainOnly) {
  const ids = {};
  S.result.groups.forEach((g, gi) => g.params.forEach((p, pi) => { ids[p.label] = `${gi}.${pi}`; }));
  const topics = new Map();
  for (const x of S.result.portrait || []) {
    if ([x.label, ...(x.needs || [])].some((l) => isHidden(ids[l])) || (mainOnly && !x.main)) continue;
    if (!topics.has(x.topic)) topics.set(x.topic, { plain: [], lists: new Map() });
    const t = topics.get(x.topic);
    if (!x.join) t.plain.push(x.text);
    else { if (!t.lists.has(x.join)) t.lists.set(x.join, []); t.lists.get(x.join).push(x.text); }
  }
  return [...topics].map(([topic, t]) => ({ topic, text: [...t.plain, ...[...t.lists].map(([k, v]) => `${k}: ${v.join(", ")}.`)].join(" ") }));
}
const portraitText = () => portraitLines().map((l) => l.text).join(" ");
function showPortrait(card) {
  const summary = summaryLines(), links = topLinks();
  const lines = summary.length ? summary : [...factLines(), ...portraitLines(true).filter((l) => l.topic !== FACTS_TOPIC)];
  // One section: each topic once, with its points under it
  const topics = new Map();
  lines.forEach((l) => { if (!topics.has(l.topic)) topics.set(l.topic, []); topics.get(l.topic).push(l.text); });
  $(`${card}`).hidden = !lines.length;
  $(`${card} .portrait-top`).innerHTML = [...topics].map(([topic, texts]) => `<div class="p-line"><span>${esc(topic)}</span><div>${texts.map((t) => `<p>${esc(t)}</p>`).join("")}</div></div>`).join("");
  $(`${card} .portrait-links`).innerHTML = links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l.text)}</a>`).join("");
}
function renderReport() {
  showPortrait("#rep-portrait");
  const r = S.result;
  $("#rep-name").textContent = S.owner.name_he;
  $("#rep-read").textContent = S.run.body_reads ? `בנוסף נקראו ${fmtN(S.run.body_reads)} מיילים על מגורים, עבודה, טיסות ורשתות. מהם נשמרו רק עיר, מעסיק, יעדים וקישורים.` : "";
  const d = r.today.split("-").reverse().join(".");
  const ymOf = (x) => x.slice(0, 7).split("-").reverse().join(".");
  const range = r.stats.date_range;
  $("#rep-meta").innerHTML = [["הופק", d], ["תקופה", range ? `<bdi dir="ltr">${esc(ymOf(range[0]))} – ${esc(ymOf(range[1]))}</bdi>` : "—"],
    ["מיילים בתקופה", fmtN(S.run.listed)]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  $("#rep-groups").innerHTML = r.groups.map((g) => `
    <div class="card group"><h2>${esc(g.title)}</h2>${g.params.map((p) => `<div class="row">
        <div class="lab">${esc(p.label)}</div>
        <div class="val ${p.v === null ? "none" : ""}">${valHtml(p)}</div>
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
    <div class="rv-val ${isParam && p.v === null ? "none" : ""}">${hidden ? `<span class="redact" role="img" aria-label="מושחר"></span>` : isParam ? valHtml(p) : esc(value)}</div>
    <div class="rv-ev">${hidden ? (whole ? "השורה הזו לא תישלח בכלל." : "יישלחו רק התשובה וההערה שלך, אם תוסיפו.") : isParam ? evLine(p) : ""}</div>
    ${chips || canNote ? `<div class="rv-act">${chips}${canNote ? `<button class="link" data-note-open>תגובה</button>` : ""}</div>` : ""}
    ${kinds}
    ${canNote && noteOpen ? `<textarea class="rv-note" data-note placeholder="תגובה ל${esc(CFG.feedbackTo)}">${esc(v.note || "")}</textarea>` : ""}
  </div>`;
}

function reviewCount() {
  followBlackouts();
  showPortrait("#rev-portrait");
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
    portrait: portraitText(),
    summary: summaryLines(),
    links: topLinks(),
  };
}
function statsRecord() {
  const st = S.result.stats;
  const out = { messages: st.messages, business_in: st.business_in, business_in_registered: st.business_in_registered,
                business_in_labelled: st.business_in_labelled, templates: st.templates, orgs: st.orgs,
                skipped_promotions: S.run.skipped_promotions, reads: S.run.reads, report_seconds: S.run.report_seconds,
                read_seconds: S.run.read_seconds, complete: S.run.complete,
                body_reads: S.run.body_reads, pdf_read: S.run.pdf_read, pdf_failed: S.run.pdf_failed, ai_sentences: S.run.ai_sentences ?? null };
  if (!isPrivate()) { out.findings_rows = st.findings_rows; out.report_rows = S.result.groups.reduce((a, g) => a + g.params.length, 0); }
  return out;
}

$("#to-feedback").addEventListener("click", async () => {
  // the preview has to show what will really go out, so it waits for the last of the count
  const btn = $("#to-feedback"), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "מסיימים לעבור על השולחים…";
  await S.scanned;
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
