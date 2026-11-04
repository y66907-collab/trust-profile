"""Phone OTP: SMS sending, Veriphone pre-check, abuse limits (no network)."""

import pytest

from app.config import settings
from app.connectors import phone, phone_line, sms
from app.connectors.base import ConnectorError
from app.connectors.phone import PhoneConnector
from app.connectors.registry import REGISTRY


@pytest.fixture()
def outbox(monkeypatch):
    """A real provider, but every SMS lands here instead of on a phone."""
    sent = []
    monkeypatch.setattr(settings, "sms_provider", "smsto")
    monkeypatch.setattr(settings, "smsto_api_key", "k")
    monkeypatch.setitem(sms.PROVIDERS, "smsto", lambda to, text: sent.append((to, text)))
    return sent


def code_from(text: str) -> str:
    return text.rsplit("#", 1)[1].strip()


@pytest.mark.parametrize("raw,expected", [
    ("0521234567", "+972521234567"),
    ("052-123-4567", "+972521234567"),
    ("+972 52 123 4567", "+972521234567"),
    ("972521234567", "+972521234567"),
    ("036400000", None),       # landline
    ("12345", None),
    ("", None),
])
def test_normalize_il_mobile(raw, expected):
    assert sms.normalize_il_mobile(raw) == expected


def test_console_mode_returns_code_and_sends_nothing():
    res = PhoneConnector().start("p1", {"phone": "0521234567"})
    assert res.data["dev_code"].isdigit()
    assert res.data["sent_to"].endswith("4567")


def test_real_provider_sends_sms_and_hides_code(outbox):
    c = PhoneConnector()
    res = c.start("p1", {"phone": "052-123-4567"})
    assert "dev_code" not in res.data
    [(to, text)] = outbox
    assert to == "+972521234567"
    assert "Creds" in text and text.splitlines()[-1].startswith("@localhost #")  # WebOTP autofill line
    drafts = c.complete("p1", {"code": code_from(text)})
    assert drafts[0].value == {"phone_hash": phone._h("+972521234567"), "last4": "4567"}


def test_landline_rejected_before_paying_for_sms(outbox, monkeypatch):
    monkeypatch.setattr(settings, "veriphone_key", "v")
    monkeypatch.setattr(phone_line, "fetch", lambda p: {"status": "success", "phone_valid": True, "phone_type": "voip"})
    with pytest.raises(ConnectorError, match="נייד"):
        PhoneConnector().start("p1", {"phone": "0521234567"})
    assert outbox == []


def test_veriphone_result_is_never_stored(outbox, monkeypatch):
    monkeypatch.setattr(settings, "veriphone_key", "v")
    monkeypatch.setattr(phone_line, "fetch", lambda p: {"status": "success", "phone_valid": True, "phone_type": "mobile", "carrier": "Partner"})
    c = PhoneConnector()
    c.start("p1", {"phone": "0521234567"})
    drafts = c.complete("p1", {"code": code_from(outbox[0][1])})
    assert [d.field for d in drafts] == ["phone_verified"]
    assert "Partner" not in str(drafts[0].value)


def test_resend_cooldown_and_hourly_cap(outbox, monkeypatch):
    clock = [1_000_000.0]
    monkeypatch.setattr(phone.time, "time", lambda: clock[0])
    c = PhoneConnector()
    c.start("p1", {"phone": "0521234567"})
    with pytest.raises(ConnectorError, match="שניות"):
        c.start("p1", {"phone": "0521234567"})
    for _ in range(4):
        clock[0] += 61
        c.start("p1", {"phone": "0521234567"})
    clock[0] += 61
    with pytest.raises(ConnectorError, match="שעה"):
        c.start("p1", {"phone": "0521234567"})
    assert len(outbox) == 5


def test_wrong_code_attempts_and_expiry(outbox, monkeypatch):
    clock = [1_000_000.0]
    monkeypatch.setattr(phone.time, "time", lambda: clock[0])
    c = PhoneConnector()
    c.start("p1", {"phone": "0521234567"})
    for _ in range(4):
        with pytest.raises(ConnectorError, match="שגוי"):
            c.complete("p1", {"code": "000000"})
    with pytest.raises(ConnectorError, match="ניסיונות"):
        c.complete("p1", {"code": "000000"})
    # a new code that expires
    clock[0] += 61
    c.start("p1", {"phone": "0521234567"})
    clock[0] += phone.CODE_TTL + 1
    with pytest.raises(ConnectorError, match="פג"):
        c.complete("p1", {"code": code_from(outbox[-1][1])})


def test_sms_failure_is_reported_and_nothing_pending(monkeypatch):
    monkeypatch.setattr(settings, "sms_provider", "smsto")
    monkeypatch.setattr(settings, "smsto_api_key", "k")

    def boom(to, text):
        raise sms.SmsError("401: bad key")

    monkeypatch.setitem(sms.PROVIDERS, "smsto", boom)
    with pytest.raises(ConnectorError, match="נכשלה"):
        PhoneConnector().start("p1", {"phone": "0521234567"})
    assert "p1" not in phone._pending


def test_sources_report_readiness(monkeypatch):
    monkeypatch.setattr(settings, "sms_provider", "smsto")
    monkeypatch.setattr(settings, "smsto_api_key", "")
    p = REGISTRY["id.phone"].describe()
    assert p["ready"] is False and "TP_SMSTO_API_KEY" in p["not_ready_reason"]
    gh = REGISTRY["rep.github"].describe()
    assert gh["ready"] is False and "TP_GITHUB_CLIENT_ID" in gh["not_ready_reason"]
    assert REGISTRY["work.btl"].describe()["ready"] is False
