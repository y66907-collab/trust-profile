# Trust Profile — instructions for Claude

Portable, user-owned, verified trust profile. Yudit (tech) & Yogev (business). Docs in Hebrew, code in English.

**Always talk to Yudit in Hebrew.** Every reply, every progress note between tool calls, every summary — in Hebrew.
Code, identifiers, commit messages and code comments stay in English.

## Non-negotiable product rules (enforced in code — keep them)
1. **The profile belongs to the person.** Nothing is visible to anyone except through a ShareLink the person created.
2. **Verification, not scoring.** No AI/trust score from social media. Evidence + proof level (1–4) only.
   A "completeness" meter is allowed; it measures how much was proven, not who the person is.
3. **Never store** protected attributes, biometrics, post/like/friend content, exact salary, street address
   for display. See `backend/app/connectors/sanitize.py` — every evidence write passes through it.
4. **Missing data is never penalised.** No "warning" for not connecting a source.
5. **Referees answer closed questions only.** No free text (defamation, explainability).
6. **Everything is audited** (`AuditLog`), every share view is logged, evidence expires, sources are revocable.

## Layout
- `backend/app/connectors/` — one file per source family. Implement `Connector.start/complete`.
  Register in `registry.py`. Connectors never touch the DB.
- `backend/app/services.py` — all writes (sanitise + audit happen here).
- `backend/app/api/routes.py` — thin HTTP layer.
- `docs/` — features (cubes) and data catalog. Update `docs/data-catalog.md` when adding a source.

## Run
```
docker compose up -d db
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --reload
pytest   # uses SQLite in-memory
```
