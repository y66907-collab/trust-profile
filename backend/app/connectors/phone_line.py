"""Line-type pre-check for a phone number (Veriphone), used before sending an SMS code.

Internal only: tells us whether a number is a valid mobile line so we don't pay for SMS that can't arrive.
The result is never stored and never shown. The carrier is by number prefix, not the current carrier.
Free tier: 1,000 lookups / month. Needs TP_VERIPHONE_KEY; without it the check is skipped.
"""

import json
import urllib.parse
import urllib.request

from app.config import settings

API = "https://api.veriphone.io/v2/verify"


def _veriphone(phone: str) -> dict:
    q = urllib.parse.urlencode({"phone": phone, "default_country": "IL"})
    req = urllib.request.Request(
        f"{API}?{q}", headers={"Authorization": f"Bearer {settings.veriphone_key}", "User-Agent": "trust-profile/0.1"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


# Overridable for tests
fetch = _veriphone


def line_info(phone: str) -> dict | None:
    """{'type', 'carrier', 'country_code'} for a valid number, else None. Never raises: a failed check is just absent."""
    if not settings.veriphone_key:
        return None
    try:
        r = fetch(phone)
    except (OSError, ValueError):
        return None
    if r.get("status") != "success" or not r.get("phone_valid"):
        return None
    return {"type": r.get("phone_type") or "unknown", "carrier": r.get("carrier") or "", "country_code": r.get("country_code") or ""}
