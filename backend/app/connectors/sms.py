"""Outbound SMS. One function, provider chosen by TP_SMS_PROVIDER:

- console: nothing is sent; the code is returned to the client (dev only)
- smsto:   sms.to   (Bearer API key; free credits on sign-up)
- twilio:  Twilio   (Account SID + auth token + sender)
"""

import base64
import json
import re
import urllib.parse
import urllib.request

from app.config import settings


class SmsError(Exception):
    pass


def normalize_il_mobile(raw: str) -> str | None:
    """Israeli mobile in any common form -> E.164 (+9725XXXXXXXX), else None."""
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("972"):
        digits = "0" + digits[3:]
    return f"+972{digits[1:]}" if re.fullmatch(r"05\d{8}", digits) else None


def _post(url: str, headers: dict[str, str], data: bytes) -> dict:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "trust-profile/0.1", **headers})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise SmsError(f"{e.code}: {e.read()[:200]!r}") from e
    except OSError as e:
        raise SmsError(str(e)) from e


def _smsto(to: str, text: str) -> None:
    body = {"to": to, "message": text}
    if settings.smsto_sender_id:
        body["sender_id"] = settings.smsto_sender_id
    r = _post("https://api.sms.to/sms/send",
              {"Authorization": f"Bearer {settings.smsto_api_key}", "Content-Type": "application/json"},
              json.dumps(body).encode())
    if r.get("success") is False:
        raise SmsError(r.get("message", "sms.to rejected the message"))


def _twilio(to: str, text: str) -> None:
    sid = settings.twilio_account_sid
    auth = base64.b64encode(f"{sid}:{settings.twilio_auth_token}".encode()).decode()
    _post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
          {"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
          urllib.parse.urlencode({"To": to, "From": settings.twilio_from, "Body": text}).encode())


PROVIDERS = {"smsto": _smsto, "twilio": _twilio}


def is_console() -> bool:
    return settings.sms_provider not in PROVIDERS


def not_ready_reason() -> str | None:
    p = settings.sms_provider
    if p == "smsto" and not settings.smsto_api_key:
        return "חסר TP_SMSTO_API_KEY ב-.env"
    if p == "twilio" and not (settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_from):
        return "חסרים TP_TWILIO_ACCOUNT_SID / TP_TWILIO_AUTH_TOKEN / TP_TWILIO_FROM ב-.env"
    return None


def send(to_e164: str, text: str) -> None:
    PROVIDERS[settings.sms_provider](to_e164, text)
