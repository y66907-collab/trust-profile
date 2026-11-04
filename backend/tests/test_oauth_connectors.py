"""GitHub and Telegram connectors: server-side verification, no network."""

import hashlib
import hmac
import time

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.connectors import github
from app.connectors.base import ConnectorError
from app.connectors.github import GitHubConnector
from app.connectors.telegram import TelegramConnector, estimated_join_year, verify_login
from app.main import app

BOT_TOKEN = "123456:TEST-BOT-TOKEN"


def sign_telegram(data: dict, token: str = BOT_TOKEN) -> dict:
    check = "\n".join(f"{k}={data[k]}" for k in sorted(data))
    secret = hashlib.sha256(token.encode()).digest()
    return {**data, "hash": hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()}


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "github_client_id", "gh-id")
    monkeypatch.setattr(settings, "github_client_secret", "gh-secret")
    monkeypatch.setattr(settings, "telegram_bot_token", BOT_TOKEN)
    monkeypatch.setattr(settings, "telegram_bot_username", "creds_test_bot")


# ---------- Telegram ----------

def test_telegram_accepts_valid_signature():
    data = sign_telegram({"id": 7_000_000_000, "first_name": "Noa", "username": "noa", "auth_date": int(time.time())})
    drafts = TelegramConnector().complete("p1", data)
    assert drafts[0].field == "telegram_account"
    assert drafts[0].value["username"] == "noa"
    assert drafts[0].value["estimated_join_year"] == 2024
    assert drafts[0].proof_level == 2


def test_telegram_rejects_tampered_payload():
    data = sign_telegram({"id": 7_000_000_000, "username": "noa", "auth_date": int(time.time())})
    data["username"] = "someone_else"
    with pytest.raises(ConnectorError, match="signature"):
        verify_login(data, BOT_TOKEN)


def test_telegram_rejects_wrong_bot_and_stale_login():
    data = sign_telegram({"id": 1, "auth_date": int(time.time())}, token="other-bot")
    with pytest.raises(ConnectorError):
        verify_login(data, BOT_TOKEN)
    old = sign_telegram({"id": 1, "auth_date": int(time.time()) - 3600})
    with pytest.raises(ConnectorError, match="expired"):
        verify_login(old, BOT_TOKEN)


def test_estimated_join_year_is_monotonic():
    assert estimated_join_year(1_000) == 2013
    assert estimated_join_year(400_000_000) == 2017
    assert estimated_join_year(6_000_000_000) == 2023
    assert estimated_join_year(99_000_000_000) == 2025


# ---------- GitHub ----------

def test_github_state_round_trip_and_tamper():
    state = github._state("person-42")
    assert github.person_from_state(state) == "person-42"
    with pytest.raises(ConnectorError):
        github.person_from_state("person-43." + state.split(".")[1])


def test_github_complete_uses_server_side_lookup(monkeypatch):
    monkeypatch.setattr(GitHubConnector, "exchange_code", staticmethod(lambda code: {"access_token": "tok"} if code == "good" else {"error": "bad_verification_code"}))
    monkeypatch.setattr(GitHubConnector, "fetch_user", staticmethod(lambda tok: {"login": "noa-dev", "created_at": "2015-04-02T10:00:00Z", "public_repos": 37, "followers": 12}))
    c = GitHubConnector()
    drafts = c.complete("p1", {"code": "good"})
    assert drafts[0].value == {"login": "noa-dev", "created_at": "2015-04-02", "public_repos": 37, "followers": 12}
    assert "2015" in drafts[0].display
    with pytest.raises(ConnectorError, match="bad_verification_code"):
        c.complete("p1", {"code": "wrong"})


def test_github_start_builds_redirect_with_signed_state():
    res = GitHubConnector().start("p1", {})
    assert res.kind == "redirect"
    assert "client_id=gh-id" in res.data["url"]
    assert "state=p1." in res.data["url"]


# ---------- end to end through the callback ----------

@pytest.fixture()
def client(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.db import Base, get_session

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)

    def _s():
        with Session() as s:
            yield s

    app.dependency_overrides[get_session] = _s
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_telegram_callback_stores_evidence(client):
    pid = client.post("/persons", json={"display_name": "נועה"}).json()["id"]
    data = sign_telegram({"id": 5_950_000_000, "first_name": "Noa", "auth_date": int(time.time())})
    r = client.get("/oauth/telegram/callback", params={"person": pid, **data})
    assert r.status_code == 200, r.text
    me = client.get(f"/persons/{pid}/me").json()
    assert [e["source"] for e in me["evidence"]] == ["soc.telegram"]
    assert me["evidence"][0]["value"]["estimated_join_year"] == 2023
    assert "presence" in me["completeness"]["done"]


def test_github_callback_rejects_forged_state(client):
    r = client.get("/oauth/github/callback", params={"code": "x", "state": "someone.deadbeef"})
    assert r.status_code == 400
