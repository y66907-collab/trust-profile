# פיילוט imtrustme: פרופיל מתיבת Gmail

קישור אחד שנשלח ל-8 משתתפים. כל משתתף מחבר את ה-Gmail שלו, ומקבל פרופיל לשכירת דירה. אפשר להסתיר שורות, להגיב, ולסמן מה לא נכון. בסוף נוצר קובץ משוב, והמשתתף רואה בדיוק מה בו לפני ששולח אותו.

**אין שרת.** הדף סטטי. קריאת המעטפות והמנוע רצים בדפדפן של המשתתף, והמנוע הוא Python שרץ ב-Pyodide. שום מייל לא יוצא מהמחשב שלו. הגישה ל-Gmail מתבטלת מיד כשהקריאה נגמרת.

## מה יש כאן

| קובץ | מה הוא עושה |
|---|---|
| `site/index.html`, `app.js`, `style.css` | הדף: פתיחה, פרטים, חיבור, הדוח, שאלות, תצוגת המשוב |
| `site/worker.js` | מריץ את המנוע ב-Pyodide, ברקע |
| `site/engine/engine.py` | המנוע הדטרמיניסטי, אותו מנוע מההדגמה |
| `site/engine/pilot.py` | מעטפות ← פרמטרים לשכירת דירה, וגם רשימת שולחים שהמנוע לא הכיר |
| `site/engine/*.json` | רשימת השולחים, התוויות והחוקים. שולחים רגישים שמורים כ-hash בלבד (`excluded_hashes.json`) |
| `site/config.js` | ההגדרה היחידה: מזהה ה-OAuth של Google |
| `tools/merge_feedback.py` | מאחד את קבצי המשוב לקובץ Excel אחד |
| `test/e2e.js` | בדיקה מלאה ב-Chromium, עם Google ו-Gmail מדומים |

## הקמה (פעם אחת, כ-15 דקות)

### 1. Google Cloud

1. ב-[console.cloud.google.com](https://console.cloud.google.com) פותחים פרויקט חדש בשם `imtrustme-pilot`.
2. ב-**APIs & Services → Library** מחפשים **Gmail API** ומפעילים אותו.
3. ב-**OAuth consent screen** (או **Google Auth Platform**):
   - סוג: **External**. שם האפליקציה: `imtrustme`. ממלאים מייל תמיכה.
   - **Scopes**: מוסיפים `https://www.googleapis.com/auth/gmail.metadata`. זו ההרשאה היחידה.
   - **Test users**: מוסיפים את 8 כתובות ה-Gmail של המשתתפים. רק הן יוכלו להתחבר.
   - משאירים במצב **Testing**. לא שולחים לאימות של Google.
4. ב-**Credentials → Create credentials → OAuth client ID**:
   - סוג: **Web application**.
   - **Authorized JavaScript origins**: `https://y66907-collab.github.io`
   - מעתיקים את ה-**Client ID**.
5. מדביקים את ה-Client ID בקובץ `site/config.js`, בשורה `googleClientId`.

### 2. פרסום הדף

הדף נמצא ב-branch בשם `gh-pages`, ובו רק קבצי `site/`.

1. ב-GitHub נכנסים ל-**Settings → Pages**.
2. בוחרים **Deploy from a branch**, ואז `gh-pages` ו-`/ (root)`.
3. אחרי דקה הדף זמין בכתובת `https://y66907-collab.github.io/trust-profile/`.

כל שינוי ב-`site/` צריך להגיע גם ל-`gh-pages`:

```bash
git subtree push --prefix pilot/site origin gh-pages
```

### 3. שליחה למשתתפים

שולחים את הקישור. בחלון של Google תופיע ההודעה "Google hasn't verified this app". הדף מסביר מראש מה ללחוץ.

## איסוף המשוב

שומרים את כל קבצי `imtrustme-feedback-*.json` בתיקייה אחת, ומריצים:

```bash
pip install openpyxl
python pilot/tools/merge_feedback.py <התיקייה>
```

נוצר `pilot_feedback.xlsx` עם שלושה גיליונות:

- **participants:** שורה לכל משתתף. כמה מהמיילים הגיעו מגופים שהמנוע מכיר (היעד: 80%), מה הוסתר, ומה ענה על השאלות.
- **wrong:** כל שורה שסומנה כלא נכונה, מה המנוע כתב בה, ומה המשתתף אמר.
- **unknown:** שולחים שהמנוע לא הכיר, ממוינים לפי כמה משתתפים קיבלו מהם. השורות הראשונות הן מה שמוסיפים ל-`senders.json` ול-`labels.json` לפני הסבב הבא.

## מה המשוב כולל, ומה לא

- **כולל:** תשובות, השורות שסומנו (שם השורה, ואם סומנה כלא נכונה גם הערך), ספירות, ודומיינים של שולחים לא מוכרים עם תבנית הנושא. בתבנית אין מספרים ואין את שם המשתתף.
- **לא כולל:** תוכן מיילים, כתובות של אנשים פרטיים, ושולחים של בריאות, תרומות, קהילה וילדים. אלה מוסרים לפני שהמשתתף רואה את הרשימה.
- המשתתף יכול להוריד כל פריט לפני שנוצר הקובץ.

## בדיקה מקומית

```bash
cd pilot/test && npm install
python ../tools/tsv_to_rows.py <own address> <envelopes.tsv ...> > rows.json   # git-ignored
ME=<own address> OWNER_HE="<שם>" node e2e.js
```
