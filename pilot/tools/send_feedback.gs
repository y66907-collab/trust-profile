// Google Apps Script web app behind the page's send button. It mails each feedback to the account that deployed it,
// so that address never appears in the public page. It keeps nothing.
// Deploy: script.google.com > New project > paste this > Deploy > New deployment > Web app,
// Execute as: Me, Who has access: Anyone. Put the /exec URL in site/config.js, in sendUrl.

const MAX_BYTES = 300000;

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Opening the URL once, as the owner, is what grants the permission to send
function esc(x) {
  return String(x === undefined || x === null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The readable mail. Every value comes from a public URL, so all of it is escaped and nothing here makes a link
function renderMail(d) {
  const VERDICT = { correct: "נכון", wrong: "לא נכון", unsure: "לא יודע/ת", comment: "הערה" };
  const KIND = { missed: "חסר משהו שקיים", invented: "כתוב משהו שלא קיים", inaccurate: "הפרטים לא מדויקים" };
  const COLOR = { correct: "#0a6f74", wrong: "#8a5a00", unsure: "#587173", comment: "#587173" };
  const td = "padding:8px 10px;border-top:1px solid #dbe7e6;vertical-align:top;text-align:right;";
  const answer = (v) => !v ? "" : `<div style="color:${COLOR[v.verdict] || "#587173"};font-weight:bold">${esc(VERDICT[v.verdict] || v.verdict)}${v.kind ? " · " + esc(KIND[v.kind] || v.kind) : ""}</div>` +
    (v.note ? `<div>${esc(v.note)}</div>` : "");
  const verdicts = Array.isArray(d.verdicts) ? d.verdicts : [];
  const byKey = {};
  verdicts.forEach((v) => { byKey[v.key] = v; });
  const black = `<span style="background:#000;color:#000;padding:0 60px">&nbsp;</span>`;
  const head = (cols) => `<tr>${cols.map((c) => `<th style="${td}border-top:0;color:#587173;font-size:12px">${c}</th>`).join("")}</tr>`;
  const table = (body) => `<table dir="rtl" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">${body}</table>`;
  const title = (t) => `<h3 style="color:#0a6f74;margin:22px 0 6px;font-size:16px">${esc(t)}</h3>`;
  let out = `<div dir="rtl" style="font-family:Arial,sans-serif;color:#102a2b;max-width:760px;text-align:right">`;
  out += `<h2 style="margin:0 0 4px">משוב מ${esc(d.from)}</h2>`;
  out += `<div style="color:#587173;font-size:13px">${d.mode === "full" ? "שיתף/ה את הדוח" : "בלי הדוח: רק התשובות"}${d.report && d.report.hidden_rows ? " · " + esc(d.report.hidden_rows) + " שורות הושחרו" : ""}</div>`;
  const a = d.answers || {};
  if (a["q-overall"]) out += `<p><b>כמה נכון בסך הכול:</b> ${esc(a["q-overall"])}</p>`;
  if (a["q-ux"]) out += `<p><b>מה היה מבלבל:</b> ${esc(a["q-ux"])}</p>`;
  const rep = d.report;
  if (rep && Array.isArray(rep.groups)) {
    rep.groups.forEach((g) => {
      out += title(g.title) + table(head(["שורה", "מה המנוע כתב", "על סמך", "תשובה"]) + (g.rows || []).map((r) =>
        `<tr><td style="${td}color:#587173">${esc(r.label)}</td><td style="${td}font-weight:bold">${r.hidden ? black : esc(r.value)}</td>` +
        `<td style="${td}color:#587173;font-size:12px">${r.hidden ? "" : esc(r.evidence)}</td><td style="${td}">${answer(byKey[r.key])}</td></tr>`).join(""));
    });
    [["פירוט ספקים", rep.suppliers], ["אירועי תשלום זניחים", rep.minor]].forEach(([t, list]) => {
      if (Array.isArray(list) && list.length) out += title(t) + table(list.map((x) =>
        `<tr><td style="${td}font-weight:bold">${esc(x.org)}</td><td style="${td}">${esc(x.text)}</td><td style="${td}">${esc(x.note)}</td></tr>`).join(""));
    });
  } else {
    out += title("התשובות") + table(head(["שורה", "תשובה"]) + verdicts.map((v) =>
      `<tr><td style="${td}color:#587173">${esc(v.label)}</td><td style="${td}">${answer(v)}</td></tr>`).join(""));
  }
  if (Array.isArray(d.unknown_senders) && d.unknown_senders.length) {
    out += title("שולחים שהמנוע לא הכיר") + table(d.unknown_senders.map((u) =>
      `<tr><td style="${td}direction:ltr;text-align:left">${esc(u.domain)}</td><td style="${td}">${esc(u.count)}</td><td style="${td}">${esc(u.skeleton)}</td></tr>`).join(""));
  }
  if (d.stats) out += `<p style="color:#587173;font-size:12px;margin-top:22px">${esc(d.stats.messages)} מיילים נספרו. הקובץ המצורף הוא לאיחוד המשובים.</p>`;
  return out + "</div>";
}

function doGet() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL); // Google lets people tick permissions one by one
  return reply({ ok: true, ready: true });
}

function doPost(e) {
  // The URL is public, so anything that isn't a feedback in the expected shape is refused
  const raw = e && e.postData ? e.postData.contents : "";
  if (!raw || raw.length > MAX_BYTES) return reply({ ok: false, error: "size" });
  let d;
  try { d = JSON.parse(raw); } catch (err) { return reply({ ok: false, error: "json" }); }
  if (d.kind !== "imtrustme-pilot-feedback" || d.version !== 2 || !Array.isArray(d.verdicts)) return reply({ ok: false, error: "shape" });

  const from = String(d.from || "ללא שם").replace(/[\r\n]+/g, " ").slice(0, 60);
  const name = "feedback-" + Utilities.formatDate(new Date(), "UTC", "yyyyMMddHHmmss") + "-" + Utilities.getUuid().slice(0, 6) + ".json";
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: "imtrustme feedback: " + from,
    body: "המשוב מופיע בגרסת ה-HTML של המייל ובקובץ המצורף.",
    htmlBody: renderMail(d),
    attachments: [Utilities.newBlob(raw, "application/json", name)],
  });
  return reply({ ok: true });
}
