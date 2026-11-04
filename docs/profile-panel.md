# טבלת פאנל — אילו פיצ'רים אפשר להשיג על פרופיל

שורה אחת לכל אדם (`person_id`). כל עמודה היא פיצ'ר.
כאן מופיע רק **מה אפשר להשיג**. אין כאן מודל ואין מטרה.
אומת מול מקורות ב-13.10.2026. פירוט מלא לכל מקור: [data-catalog.md](data-catalog.md).

**מקרא סטטוס**
- ✅ — אפשר היום, חינם.
- 💰 — אפשר היום, בתשלום או אחרי הליך (הסכם / אישור).
- ⚠️ — אפשר טכנית, אבל תנאי הפלטפורמה או החוק מגבילים.
- ⛔ — אסור או חסום.
- ❓ — צריך לבדוק על מסמך אמיתי.

**דרגת הוכחה**
1. נטען
2. מסמך
3. צד שלישי
4. מקור רשמי

\* = דרגה 4 רק אם מאמתים את החתימה הדיגיטלית של המסמך. אחרת דרגה 2.

---

## 1. זהות

| פיצ'ר | טיפוס | דוגמה | מקור | שיטה | עלות | הליך נדרש | דרגה | סטטוס |
|---|---|---|---|---|---|---|---|---|
| `identity_verified` | bool | true | ספק אימות (ת"ז + סלפי + חיות) | vendor | $0.8–3 לבדיקה + מינימום מ-$49 לחודש | הסכם ספק, DPA, סעיף העברה לחו"ל | 4 | 💰 |
| `full_name` | text | ישראל ישראלי | ספק אימות / תמצית רישום | vendor / guided | כנ"ל / חינם | — | 4 | 💰 / ✅ |
| `birth_year` | int | 1991 | ספק אימות / תמצית רישום | vendor / guided | כנ"ל | — | 4 | 💰 / ✅ |
| `is_adult` | bool | true | נגזר מ-`birth_year` | — | — | — | 4 | ✅ |
| `id_doc_type` | enum | ת"ז / דרכון | ספק אימות | vendor | כנ"ל | — | 4 | 💰 |
| `id_doc_expiry` | date | 2031-05 | ספק אימות | vendor | כנ"ל | — | 4 | 💰 |
| `liveness_passed` | bool | true | ספק אימות | vendor | כנ"ל | — | 4 | 💰 |
| `phone_verified` | bool | true | OTP | SMS / וואטסאפ | ~₪0.95 ב-SMS, ~$0.005 בוואטסאפ | חשבון Twilio / WhatsApp Business | 2 | 💰 |
| `email_verified` | bool | true | Google / Microsoft / Apple | oauth | חינם (Apple: $99 לשנה) | חשבון מפתח | 2 | ✅ |
| `registered_city` | text | חיפה | תמצית רישום, משרד הפנים | guided | חינם | — | 4\* | ✅ |
| `registered_address_since` | date | 2019-03 | תמצית רישום | guided | חינם | — | 4\* | ❓ לבדוק אם התאריך מופיע |

## 2. עבודה והכנסה

| פיצ'ר | טיפוס | דוגמה | מקור | שיטה | עלות | הליך נדרש | דרגה | סטטוס |
|---|---|---|---|---|---|---|---|---|
| `insured_months_total` | int | 94 | ביטוח לאומי: אישור תקופות ביטוח ומעסיקים | guided | חינם | — | 2–4\* | ✅ ❓ חתימה |
| `employers_count` | int | 3 | ביטוח לאומי | guided | חינם | — | 2–4\* | ✅ |
| `employer_file_ids` | list | [9xxxxxxxx] | ביטוח לאומי | guided | חינם | — | 2–4\* | ✅ |
| `employer_names` | list | [אלביט] | ביטוח לאומי / טופס 106 | guided | חינם | — | 2–4\* | ❓ לא בטוח שיש שם בביטוח לאומי. בטופס 106 יש |
| `current_employer_since` | date | 2021-02 | ביטוח לאומי | guided | חינם | — | 2–4\* | ✅ |
| `longest_tenure_months` | int | 48 | ביטוח לאומי | guided | חינם | — | 2–4\* | ✅ |
| `employment_gaps` | list | [2019-06..2019-11] | ביטוח לאומי | guided | חינם | — | 2–4\* | ⚠️ חושף לידה / מילואים. לא מציגים בגיוס |
| `annual_gross_range_by_year` | map | {2024: "180–240K"} | טופס 106, רשות המסים | guided | חינם, 6 שנים אחורה | — | 2–4\* | ✅ ❓ חתימה. שכר = מידע רגיש |
| `monthly_gross_range` | range | 15–20K | תלוש שכר | guided | חינם | — | 2 | ✅ |
| `payslip_matches_btl` | bool | true | הצלבה: תלוש / 106 מול ביטוח לאומי | internal | — | — | 3 | ❓ תלוי בתיק ניכויים משותף |
| `work_email_domain` | text | elbit.co.il | מייל עבודה | magic link | חינם | — | 3 | ✅ |
| `employer_confirmed` | bool | true | אישור מעסיק | referee | חינם | — | 3 | ✅ |
| `employer_confirmed_role` | enum | מפתחת | אישור מעסיק | referee | חינם | — | 3 | ✅ |
| `linkedin_positions` | list | [...] | ייצוא LinkedIn | guided (export) | חינם | — | 1–2 | ✅ (ה-API: ⛔) |
| `linkedin_education` | list | [...] | ייצוא LinkedIn | guided (export) | חינם | — | 1–2 | ✅ |

## 3. מגורים ותשלומים

| פיצ'ר | טיפוס | דוגמה | מקור | שיטה | עלות | הליך נדרש | דרגה | סטטוס |
|---|---|---|---|---|---|---|---|---|
| `lease_city` | text | חיפה | חוזה שכירות | guided | חינם | — | 2 | ✅ |
| `lease_start_date` | date | 2022-08 | חוזה שכירות | guided | חינם | — | 2 | ✅ |
| `landlord_is_registered_owner` | bool | true | נסח טאבו / אישור רמ"י / חברה משכנת | internal / guided | ₪16–17 לנסח, ₪73–81 לרמ"י | אין API. צריך גוש/חלקה | 4 | 💰 חלק מהדירות לא בטאבו |
| `utility_address_city` | text | חיפה | ארנונה / חשמל / גז | guided | חינם | — | 2 | ✅ |
| `utility_payer_is_person` | bool | false | ארנונה / חשמל | guided | חינם | — | 2 | ✅ |
| `utility_since` | date | 2022-09 | ארנונה / חשמל | guided | חינם | — | 2 | ✅ |
| `rent_standing_order_since` | date | 2022-08 | אישור הוראת קבע מהבנק | guided | חינם | — | 2 | ✅ מידע רגיש |
| `rent_amount_range` | range | 4–5K | אישור הוראת קבע | guided | חינם | — | 2 | ✅ מידע רגיש |
| `bank_income_recurring` | bool | — | Open Banking | oauth via TPP | — | רישיון רשות ני"ע | 4 | ⛔ ס' 29 |
| `credit_report_summary` | — | — | דוח ריכוז נתונים, בנק ישראל | guided | חינם פעם בשנה | עו"ד | 4 | ⛔ בגיוס. ⚠️ בשאר עד חוות דעת |

## 4. ממליצים

| פיצ'ר | טיפוס | דוגמה | מקור | שיטה | עלות | הליך נדרש | דרגה | סטטוס |
|---|---|---|---|---|---|---|---|---|
| `referees_count_by_role` | map | {משכיר: 2, מעסיק: 1} | ממליצים | referee | ~$0.005 להודעה | WhatsApp Business. המשתמש שולח מהמספר שלו | 3 | ✅ |
| `referee_answers` | map | {שילם בזמן: כן} | ממליצים, שאלות סגורות | referee | כנ"ל | הודעת פרטיות לממליץ | 3 | ✅ |
| `referee_identity_verified` | bool | true | OTP לממליץ | referee | ~₪0.95 / $0.005 | — | 3 | ✅ |
| `referee_relationship_proven` | bool | true | הממליץ = בעלים בטאבו / המעסיק בביטוח לאומי | internal | ₪16–17 | — | 4 | 💰 |
| `referee_disputed` | bool | false | זכות תגובה של האדם | internal | — | — | — | ✅ |

## 5. מוניטין

| פיצ'ר | טיפוס | דוגמה | מקור | שיטה | עלות | הליך נדרש | דרגה | סטטוס |
|---|---|---|---|---|---|---|---|---|
| `github_account_created` | date | 2015-04 | GitHub | oauth | חינם | OAuth App | 2 | ✅ |
| `github_public_repos` | int | 37 | GitHub | oauth | חינם | — | 2 | ✅ |
| `airbnb_guest_reviews_count` | int | 12 | Airbnb | link + קוד בפרופיל | חינם | בדיקה ידנית | 2 | ✅ ❓ תנאי Airbnb |
| `airbnb_guest_rating` | float | 4.9 | Airbnb | link | חינם | בדיקה ידנית | 2 | ✅ |
| `google_business_rating` | float | 4.7 | Google Places | link / API | ~$35 לכל 1,000 קריאות (1,000 ראשונות חינם) | Business Profile API להוכחת בעלות | 2 | 💰 |
| `professional_license` | enum + date | מתווך, בתוקף עד 2027 | מאגרי רישיונות ממשלתיים | link | חינם | — | 4 | ✅ |

## 6. נוכחות דיגיטלית (רק כניסה, לא ראיה)

| פיצ'ר | טיפוס | דוגמה | מקור | שיטה | עלות | הליך נדרש | דרגה | סטטוס |
|---|---|---|---|---|---|---|---|---|
| `accounts_connected` | list | [google, github] | Google / Microsoft / Apple / GitHub | oauth | חינם | — | 2 | ✅ |
| `facebook_account_exists` | bool | true | Facebook Login | oauth | חינם, בלי App Review | — | 2 | ⚠️ תנאי Meta אוסרים החלטות זכאות |
| `tiktok_account_exists` | bool | true | TikTok Login Kit | oauth | חינם | App review, 3–4 ימים | 2 | ⚠️ ❓ תנאים |
| `instagram_joined_date` | date | 2013 | ייצוא Instagram | guided (export) | חינם | — | 2 | ❓ לבדוק אם מופיע בייצוא |
| `documents_from_drive` | — | — | Google Drive (`drive.file` + Picker) | oauth | חינם | אימות בסיסי, בלי CASA | — | ✅ ערוץ להבאת מסמכים, לא פיצ'ר |
| `documents_from_gmail` | — | — | Gmail | oauth restricted | CASA $540–1,800 לשנה | בדיקת אבטחה שנתית | — | ⚠️ |

## 7. פיצ'רים נגזרים (מחושבים אצלנו)

| פיצ'ר | טיפוס | הסבר |
|---|---|---|
| `completeness_pct` | int | כמה קוביות הוכחו. מד שלמות, לא ציון |
| `max_proof_level_by_cube` | map | הדרגה הגבוהה ביותר בכל קובייה |
| `sources_count` | int | כמה מקורות מחוברים |
| `evidence_age_days` | map | גיל כל ראיה |
| `cross_checks_passed` | list | אילו הצלבות עברו (תלוש מול ביטוח לאומי, חוזה מול טאבו) |
| `last_verified_at` | timestamp | |

## לא בטבלה, לעולם
- מרשם פלילי / תעודת יושר
- דת, לאום, מוצא, מצב משפחתי
- תמונות ביומטריות
- תוכן מרשתות: פוסטים, לייקים, חברים
- שכר מדויק
- כתובת מדויקת
- הוצאה לפועל

---

## סיכום

| קבוצה | ✅ חינם היום | 💰 בתשלום | ⚠️ / ⛔ | ❓ לבדוק |
|---|---|---|---|---|
| זהות | 5 | 5 | — | 1 |
| עבודה | 12 | — | 1 | 2 |
| מגורים ותשלומים | 7 | 1 | 2 | — |
| ממליצים | 4 | 1 | — | — |
| מוניטין | 5 | 1 | — | — |
| נוכחות | 2 | — | 3 | 1 |
| **סה"כ** | **35** | **8** | **6** | **4** |

**הדבר שהכי משפיע על הטבלה:** כ-12 פיצ'רים מגיעים מביטוח לאומי, טופס 106 ותמצית רישום. אם המסמכים האלה חתומים דיגיטלית, הם בדרגה 4. אם לא, הם בדרגה 2. צריך להוריד אחד מכל סוג ולבדוק.
