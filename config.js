// googleClientId: the OAuth client id from Google Cloud (Credentials -> OAuth client ID -> Web application).
// It is public by design; it only works from the origins listed for it in Google Cloud.
window.IMTRUSTME = {
  googleClientId: "131300795124-eraocnr40j5bk85ej2jmjkim7a664jup.apps.googleusercontent.com",
  sendUrl: "https://script.google.com/macros/s/AKfycbx0fZl1IpsJnGSNV2kU-sEGMCJNvCR82mC-my4ljs5lSN5K6tPbX7axnKXd1eBMxeT3rA/exec", // the Apps Script web app, see tools/send_feedback.gs
  appName: "imtrustme", // must match the App name on the Google consent screen
  feedbackTo: "יהודית",
  years: 3,
};
