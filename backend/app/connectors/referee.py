"""Referees: closed questions, answered by clicking a link. No registration, no free text.

Free text is deliberately not supported (defamation risk, unexplainable scoring).
"""

QUESTIONS: dict[str, list[dict]] = {
    "landlord": [
        {"id": "paid_on_time", "he": "שילם בזמן?", "type": "scale5"},
        {"id": "property_condition", "he": "החזיר את הדירה במצב תקין?", "type": "scale5"},
        {"id": "kept_contract", "he": "עמד בתנאי החוזה?", "type": "yesno"},
        {"id": "left_on_time", "he": "פינה בזמן?", "type": "yesno"},
        {"id": "neighbour_complaints", "he": "היו תלונות משכנים?", "type": "yesno_inverse"},
        {"id": "communication", "he": "תקשורת והיענות", "type": "scale5"},
        {"id": "would_rent_again", "he": "היית משכיר לו שוב?", "type": "yesno"},
    ],
    "employer": [
        {"id": "role_confirmed", "he": "התפקיד שציין נכון?", "type": "yesno"},
        {"id": "reliability", "he": "אמינות", "type": "scale5"},
        {"id": "would_rehire", "he": "היית מעסיק שוב?", "type": "yesno"},
    ],
    "roommate": [
        {"id": "paid_share", "he": "שילם את חלקו בזמן?", "type": "scale5"},
        {"id": "considerate", "he": "התחשבות", "type": "scale5"},
        {"id": "would_live_again", "he": "היית גר איתו שוב?", "type": "yesno"},
    ],
    "client": [
        {"id": "quality", "he": "איכות העבודה", "type": "scale5"},
        {"id": "on_time", "he": "עמד בזמנים?", "type": "yesno"},
        {"id": "would_hire_again", "he": "היית מזמין שוב?", "type": "yesno"},
    ],
}

ROLE_HE = {"landlord": "משכיר קודם", "employer": "מעסיק", "roommate": "שותף לדירה", "client": "לקוח"}


def validate_answers(role: str, answers: dict) -> dict:
    """Keep only known question ids with valid values. Unanswered questions are allowed (skip)."""
    clean = {}
    for q in QUESTIONS[role]:
        v = answers.get(q["id"])
        if v is None:
            continue
        is_bool = isinstance(v, bool)  # note: bool is a subclass of int in Python
        valid_scale = q["type"] == "scale5" and not is_bool and isinstance(v, int) and 1 <= v <= 5
        valid_yesno = q["type"].startswith("yesno") and is_bool
        if valid_scale or valid_yesno:
            clean[q["id"]] = v
    return clean


def summary_he(role: str, answers: dict) -> str:
    yes_keys = [q for q in QUESTIONS[role] if q["type"] == "yesno" and answers.get(q["id"]) is True]
    scales = [answers[q["id"]] for q in QUESTIONS[role] if q["type"] == "scale5" and q["id"] in answers]
    parts = [f"{ROLE_HE[role]} אישר"]
    if scales:
        parts.append(f"ממוצע {sum(scales) / len(scales):.1f}/5")
    if yes_keys:
        parts.append(f"{len(yes_keys)} אישורים חיוביים")
    return " · ".join(parts)
