// Age and marital status of the participant, read in the browser from documents that carry their full name and from
// what they wrote themselves. app.js shows the result as report rows; nothing here reaches the AI.
"use strict";
window.ownerScan = async (owner, get, after, drop = new Set()) => {
  const HE = { "ב": "b", "ג": "g", "ד": "d", "ז": "z", "ט": "t", "כ": "k", "ך": "k", "ל": "l", "מ": "m", "ם": "m", "נ": "n", "ן": "n", "ס": "s", "פ": "p", "ף": "p", "צ": "ts", "ץ": "ts", "ק": "k", "ר": "r", "ש": "s", "ת": "t" };
  const skel = (word) => {
    const w = word.toLowerCase().replace(/['"׳״`]/g, "");
    if (/[א-ת]/.test(w)) return [...w].map((c, i) => HE[c] ?? (c === "י" && i === 0 ? "y" : "")).join("");
    const out = w.replace(/sh/g, "s").replace(/ch|kh/g, "").replace(/ph/g, "p").replace(/th/g, "t").replace(/c/g, "k").replace(/f/g, "p").replace(/v/g, "b").replace(/w/g, "");
    return out[0] === "y" ? "y" + out.slice(1).replace(/[aeiouhy]/g, "") : out.replace(/[aeiouhy]/g, "");
  };
  const rev = (w) => [...w].reverse().join("");
  const skels = (w) => (/[א-ת]/.test(w) ? [skel(w), skel(rev(w))] : [skel(w)]);
  const WORD = /[\p{L}'"׳״]+/gu;
  const [first, ...rest] = owner.name_he.trim().split(/\s+/);
  const FIRST = skel(first), LAST = skel(rest.join(" ") || first);
  // The full name, by consonants so Hebrew and any English spelling meet. Returns where it stands in the text
  const ownHits = (text) => {
    const toks = [...String(text).matchAll(WORD)], hits = [];
    toks.forEach((t, i) => {
      if (!skels(t[0]).includes(FIRST)) return;
      for (let j = Math.max(0, i - 3); j <= Math.min(toks.length - 1, i + 3); j++) if (j !== i && skels(toks[j][0]).includes(LAST)) { hits.push(t.index); return; }
    });
    return hits;
  };
  const hasFirst = (t) => [...String(t).matchAll(WORD)].some((m) => skels(m[0]).includes(FIRST));
  const hasLast = (t) => [...String(t).matchAll(WORD)].some((m) => skels(m[0]).includes(LAST));

  const pmap = async (items, size, fn) => {
    const q = [...items];
    await Promise.all(Array.from({ length: size }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch (e) { console.warn("owner scan skipped a mail"); } } }));
  };
  const search = async (q, max) => {
    const ids = [];
    let page = "";
    do {
      const b = await get(`${API}/messages?q=${encodeURIComponent(`${q} ${after}`)}&maxResults=100${page ? "&pageToken=" + page : ""}`);
      ids.push(...(b.messages || []).map((m) => m.id).filter((id) => !drop.has(id))); // promotions are never opened
      page = b.nextPageToken;
    } while (page && ids.length < max);
    return ids.slice(0, max);
  };
  const searchAll = async (qs, max) => {
    const ids = new Set();
    await pmap(qs, 3, async (q) => (await search(q, max)).forEach((i) => ids.add(i)));
    return [...ids];
  };
  const mails = new Map();
  const mail = async (id) => {
    if (!mails.has(id)) mails.set(id, await get(`${API}/messages/${id}?format=full`));
    return mails.get(id);
  };
  const header = (g, n) => (g.payload?.headers || []).find((h) => h.name.toLowerCase() === n)?.value || "";
  const when = (g) => new Date(Number(g.internalDate)).toISOString().slice(0, 10);
  const isSent = (g) => (g.labelIds || []).includes("SENT");
  const files = new Map();
  const fileTexts = async (g) => {
    const out = [];
    for (const p of partsOf(g.payload)) {
      if (!/\.(pdf|docx)$/i.test(p.filename || "") || !p.body?.attachmentId || p.body.size > 8e6) continue;
      const key = g.id + p.partId;
      if (!files.has(key)) {
        let text = "";
        try {
          const bytes = fileBytes((await get(`${API}/messages/${g.id}/attachments/${p.body.attachmentId}`)).data);
          text = readable(/\.docx$/i.test(p.filename) ? await docxText(bytes) : await pdfLines(bytes));
        } catch (e) { /* scanned or password protected */ }
        files.set(key, text);
      }
      out.push(files.get(key));
    }
    return out;
  };
  const allText = (g) => partsOf(g.payload).filter((p) => p.body?.data && /^text\//.test(p.mimeType || "")).map((p) => {
    const t = decodePart(p.body, p);
    return p.mimeType === "text/html" ? new DOMParser().parseFromString(t, "text/html").body.textContent : t;
  }).join(" ");
  // Only what the person wrote: quoted replies and forwarded mail are cut
  const ownWords = (g) => {
    const parts = partsOf(g.payload).filter((p) => p.body?.data);
    const plain = parts.find((p) => p.mimeType === "text/plain");
    let t = "";
    if (plain) t = decodePart(plain.body, plain);
    else {
      const html = parts.find((p) => p.mimeType === "text/html");
      if (html) { const d = new DOMParser().parseFromString(decodePart(html.body, html), "text/html"); d.querySelectorAll(".gmail_quote,blockquote").forEach((x) => x.remove()); t = d.body.textContent; }
    }
    const cut = t.search(/\n[\s‎‏‪-‮]*(>|On .{5,80} wrote:|ב?תאריך .{5,80} (מאת|כתב|כתבה)|-{3,} ?(Forwarded|הודעה)|From: |מאת: )/);
    return (cut > -1 ? t.slice(0, cut) : t).replace(/\s+/g, " ");
  };

  // ---- age: a birth date stated next to the full name. Greetings disagree with each other, so they only fill in the day
  const DATE = /(?:(\d{1,2})[./\-](\d{1,2})[./\-]((?:19|20)\d\d)|((?:19|20)\d\d)[./\-](\d{1,2})[./\-](\d{1,2}))/;
  const LABEL = /תאריך\s*לידה|ת\.?\s*לידה|שנת\s*לידה|נולד(?:ה|תי)?\s|date\s*of\s*birth|birth\s*date|d\.?o\.?b\.?|born/gi;
  const nowY = new Date().getFullYear();
  const votes = {}, days = {}, minors = {};
  let docs = 0, stated = 0, statedForOthers = 0;
  const readBirths = (text) => {
    const own = ownHits(text);
    for (const m of text.matchAll(LABEL)) {
      const around = text.slice(m.index, m.index + m[0].length + 45);
      const d = DATE.exec(around) || /\b((?:19|20)\d\d)\b/.exec(around);
      if (!d) continue;
      const year = Number(d[3] || d[4] || d[1]);
      if (year < 1930 || year > nowY) continue;
      if (nowY - year < 18) { minors[year] = (minors[year] || 0) + 1; continue; } // a child's row in the same form
      if (!own.some((i) => Math.abs(i - m.index) < 160)) continue;
      votes[year] = (votes[year] || 0) + 5;
      docs++;
      const md = d[3] ? `${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : d[4] ? `${d[5].padStart(2, "0")}-${d[6].padStart(2, "0")}` : null;
      if (md) days[md] = (days[md] || 0) + 1;
    }
  };
  const birthIds = await searchAll(['"תאריך לידה"', '"ת. לידה"', '"שנת לידה"', '"date of birth"', "DOB", "filename:ספח", "subject:ספח", '"טופס 101"', "filename:101", '"נקודות זיכוי"',
    'subject:"הצעת ביטוח"', "subject:פוליסה", 'subject:"ביטוח בריאות"', "filename:פוליסה", 'subject:"אישור ניהול חשבון"', "subject:דרכון", 'subject:"רישיון נהיגה"'], 80);
  await pmap(birthIds, 6, async (id) => {
    const g = await mail(id);
    readBirths(allText(g));
    (await fileTexts(g)).forEach(readBirths);
  });
  const greetings = await searchAll(['subject:"יום הולדת"', "subject:birthday"], 120);
  const greetDays = {};
  await pmap(greetings, 6, async (id) => {
    const g = await mail(id), subj = header(g, "subject");
    if (isSent(g) || !/יום הולדת|birthday/i.test(subj) || !hasFirst(subj)) return;
    const md = when(g).slice(5);
    greetDays[md] = (greetDays[md] || 0) + 1;
  });
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const day = top(days) || top(greetDays);
  await pmap(await search('in:sent ("אני בת" OR "years old")', 60), 6, async (id) => {
    const g = await mail(id), w = ownWords(g);
    for (const m of w.matchAll(/אני\s+בת\s+(\d{2})|I(?:'m| am)\s+(\d{2})\s+years/gi)) {
      // Text written for a friend: "my name is <someone else>" next to it means the age is hers, not the sender's
      const intro = /(?:שמי|קוראים לי|my name is)\s+([^\s,.]+\s+[^\s,.]+)/i.exec(w.slice(Math.max(0, m.index - 200), m.index + 60));
      if (intro && !ownHits(intro[1]).length) { statedForOthers++; continue; }
      const date = when(g);
      const born = Number(date.slice(0, 4)) - Number(m[1] || m[2]) - (day && date.slice(5) < day ? 1 : 0);
      votes[born] = (votes[born] || 0) + 3;
      stated++;
    }
  });
  const bornYear = Number(top(votes)) || null;
  const today = new Date().toISOString().slice(5, 10);

  // ---- marital status: forms about the person, and what the person wrote
  const ownForms = [], spouse = [], child = [];
  let blankForms = 0, maidenDocs = 0;
  const readForm = (t) => {
    const own = ownHits(t);
    const near = (i) => own.some((x) => Math.abs(x - i) < 250);
    for (const m of t.matchAll(/מצב\s*משפחתי\D{0,25}?(נשוי|נשואה|רווק|רווקה|גרוש|גרושה|אלמן|אלמנה)|marital\s*status\W{0,10}(married|single|divorced|widowed)/gi)) {
      // A blank form lists every option after the label: that says nothing about the person
      const after = t.slice(m.index, m.index + m[0].length + 45);
      if (["נשו|married", "רווק|single", "גרוש|divorced", "אלמ|widowed"].filter((k) => new RegExp(k, "i").test(after)).length > 1) { blankForms++; continue; }
      if (near(m.index)) ownForms.push(/נשו|married/i.test(m[0]) ? "נשואה" : /רווק|single/i.test(m[0]) ? "רווקה" : /גרוש|divorced/i.test(m[0]) ? "גרושה" : "אלמנה");
    }
    for (const m of t.matchAll(/לפני\s*הנישואין|שם\s*נעורים|maiden\s*name/gi)) if (near(m.index)) maidenDocs++;
  };
  await pmap(await searchAll(['"מצב משפחתי"', '"marital status"', "filename:ספח", '"טופס 101"', '"נקודות זיכוי"'], 60), 6, async (id) => {
    const g = await mail(id);
    readForm(allText(g));
    (await fileTexts(g)).forEach(readForm);
  });
  const SPOUSE = /(?:^|\s)(בעלי|הבעל שלי|בן זוגי|אשתי|האישה שלי|my husband|my wife)(?=[\s,.!?]|$)/gi;
  const CHILD = /(?:^|\s)(הילדים שלי|הילד שלי|הילדה שלי|הבן שלי|הבת שלי|הקטן שלי|הקטנה שלי|לילדים שלי|my kids|my son|my daughter|my children)(?=[\s,.!?]|$)/gi;
  // "בעלי" also means "owners of", so a noun right after it does not count
  const NOT_SPOUSE = /^(ה[א-ת]+|זיק[הות]+|חיים|מקצוע|עסקים?|מניות|תפקיד\S*|ניסיון|נסיון|תואר|רישיון|חברה|חברות|קרקע|דירות?|הון|נכסים?|חשבון|שליטה|מוגבלות|תעודה|תעודת|ידע|יכולת|אופי|עניין|ענין|רכב|כלב\S*|זכות|זכויות|השפעה|סמכות)$/;
  await pmap(await search('in:sent (בעלי OR "בן זוגי" OR "הילדים שלי" OR "הבן שלי" OR "הבת שלי" OR "הילד שלי" OR "my husband" OR "my kids")', 120), 6, async (id) => {
    const g = await mail(id), w = ownWords(g);
    if (!hasFirst(header(g, "from"))) return; // sent from the same account by someone else
    for (const m of w.matchAll(SPOUSE)) {
      const next = w.slice(m.index + m[0].length).trim().split(/\s+/)[0] || "";
      if (m[1] !== "בעלי" || !NOT_SPOUSE.test(next)) spouse.push(when(g));
    }
    for (const m of w.matchAll(CHILD)) child.push(when(g));
  });
  const sameSurname = new Set();
  await pmap(await search("in:sent", 400), 6, async (id) => {
    const g = await mail(id);
    for (const h of ["to", "cc"]) for (const piece of header(g, h).split(",")) {
      const name = piece.replace(/<[^>]*>/, "").replace(/["']/g, "").trim();
      if (name && !name.includes("@") && hasLast(name) && !ownHits(name).length) sameSurname.add(name);
    }
  });
  const status = ownForms[0] || (spouse.length ? "נשואה" : null);
  const sources = (ownForms.length ? 1 : 0) + (spouse.length >= 2 ? 1 : 0) + (maidenDocs ? 1 : 0);
  const kidYears = Object.keys(minors).map(Number).sort();
  return {
    age: bornYear ? { age: nowY - bornYear - (day && today < day ? 1 : 0), born: bornYear, day, docs, stated, statedForOthers } : null,
    family: status ? { status, sure: sources >= 2, forms: ownForms.length, spouse: spouse.length, maidenDocs, blankForms, relatives: sameSurname.size } : null,
    kids: child.length ? { words: child.length, years: kidYears } : null,
  };
};
