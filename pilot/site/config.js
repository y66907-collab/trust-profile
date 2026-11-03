// googleClientId: the OAuth client id from Google Cloud (Credentials -> OAuth client ID -> Web application).
// It is public by design; it only works from the origins listed for it in Google Cloud.
window.IMTRUSTME = {
  googleClientId: "PASTE_CLIENT_ID.apps.googleusercontent.com",
  sendUrl: "PASTE_SCRIPT_URL", // the Apps Script web app, see tools/send_feedback.gs
  appName: "imtrustme", // must match the App name on the Google consent screen
  feedbackTo: "יהודית",
  years: 3,
};
