# imtrustme Gmail pilot — instructions for Claude

The repo holds only the Gmail pilot: a person connects their inbox, the engine builds a report in their browser, and the report and feedback arrive by email. Yudit (tech) & Yogev (business). Docs in Hebrew, code in English.

**Always talk to Yudit in Hebrew.** Every reply, every progress note between tool calls, every summary — in Hebrew.
Code, identifiers, commit messages and code comments stay in English.

## Non-negotiable product rules (keep them)
1. **Nothing leaves the browser without the person's choice.** Feedback is sent only on their click, and a redacted value is never sent.
2. **Verification, not scoring.** No AI/trust score and no opinions about the person.
3. **Never store** protected attributes, biometrics, exact salary, or a street address.
4. **Missing data is never penalised.**
5. **Participants are blind.** The page never reveals the purpose. `pilot/test/e2e.js` fails if a revealing word reaches it.

## Layout
- `pilot/site/` — the page, published to the `gh-pages` branch. `engine/` is the Python engine, run in Pyodide.
- `pilot/tools/` — the feedback Apps Script and feedback merging.
- `pilot/test/` — e2e test with Google, Gmail and sending mocked.
- `pilot/README.md` — full explanation, setup and publishing.

## Run
```
cd pilot/test && npm install && npx playwright install chromium
node e2e.js
```

## Earlier work
The backend, connectors and product and regulation docs were removed from the tree. They remain in git history at commit `c91f8fc`.
