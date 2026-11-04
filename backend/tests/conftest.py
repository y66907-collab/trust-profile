"""Tests never touch real providers: .env may hold live keys (SMS, Veriphone, OAuth)."""

import pytest

from app.config import settings
from app.connectors import phone


@pytest.fixture(autouse=True)
def offline_providers(monkeypatch):
    monkeypatch.setattr(settings, "sms_provider", "console")
    monkeypatch.setattr(settings, "veriphone_key", "")
    monkeypatch.setattr(settings, "github_client_id", "")
    monkeypatch.setattr(settings, "github_client_secret", "")
    monkeypatch.setattr(settings, "telegram_bot_token", "")
    monkeypatch.setattr(settings, "telegram_bot_username", "")
    phone._pending.clear()
    phone._sends.clear()
