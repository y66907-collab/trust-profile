// Google Apps Script web app behind the page's send button. It mails each feedback to the account that deployed it,
// so that address never appears in the public page. It keeps nothing.
// Deploy: script.google.com > New project > paste this > Deploy > New deployment > Web app,
// Execute as: Me, Who has access: Anyone. Put the /exec URL in site/config.js, in sendUrl.

const MAX_BYTES = 300000;

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Opening the URL once, as the owner, is what grants the permission to send
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
    body: JSON.stringify(d, null, 1),
    attachments: [Utilities.newBlob(raw, "application/json", name)],
  });
  return reply({ ok: true });
}
