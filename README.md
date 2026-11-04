# Trust Profile · פרופיל אמון

**ארנק אמון אישי:** אדם מחבר בכמה לחיצות את המקורות שמוכיחים מי הוא, ושולח למי שצריך לסמוך עליו קישור לפרופיל מאומת.

- [פיצ'רים — קובייה אחר קובייה](docs/features.md)
- [קטלוג מקורות מידע — מה אפשר לאסוף, באיזו דרגה, ומה זה עולה](docs/data-catalog.md)
- [רגולציה ונהלים לפני השקה](docs/procedures.md)

## מה יש כבר בקוד

| רכיב | מצב |
|---|---|
| מודל נתונים: אדם, הסכמות, ראיות עם דרגת הוכחה, ממליצים, קישורי שיתוף, צפיות, יומן ביקורת | ✅ |
| ממשק מחברים (Connector) + מסנן "מה לא שומרים" | ✅ |
| טלפון OTP (במצב פיתוח הקוד חוזר בתשובה) | ✅ |
| Google OAuth | שלד |
| הורדה מונחית: ביטוח לאומי, חוזה שכירות | שלד: מקבל שדות מחולצים. הפרסר עוד לא נכתב |
| ממליצים: שאלות סגורות לפי תפקיד, בלי הרשמה | ✅ |
| הצלבת משכיר לטאבו → דרגה 4 | ממשק. צריך לחבר את שליפת הנסח |
| שיתוף: לפי הקשר, תוקף, חד-פעמי, ביטול, יומן צפיות | ✅ |
| "מה נשמר עליי", מחיקה לפי מקור, תפוגה | ✅ |
| Frontend | עוד לא |

## הרצה מקומית (VS Code)

```bash
git clone https://github.com/y66907-collab/trust-profile
cd trust-profile
docker compose up -d db

cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Mac/Linux
pip install -e ".[dev]"
copy ..\.env.example .env       # Windows   (cp ../.env.example .env on Mac/Linux)

uvicorn app.main:app --reload
```

- תיעוד API חי: http://localhost:8000/docs
- לנסות את כל הזרימה: פתחי את `backend/requests.http` (תוסף REST Client) ולחצי Send על כל בקשה
- טסטים: `pytest` (רץ על SQLite, לא צריך Docker)

## הצעדים הבאים

1. פרסר מסמכים להורדה מונחית (PDF → שדות), מתחילים מביטוח לאומי
2. חיבור שליפת נסח טאבו להצלבת משכירים
3. שליחת וואטסאפ לממליצים
4. Frontend: שלושת המסכים (בנייה, שיתוף, צד המקבל)
5. ספק אימות זהות (AU10TIX / Persona) — דורש הסכם
6. Alembic במקום create_all
