"""Matching logic for the public-registries playground (no network)."""

from fastapi.testclient import TestClient

from app.api import playground
from app.main import app
from app.public_registries import city_matches, name_matches, valid_israeli_id


def test_israeli_id_check_digit():
    assert valid_israeli_id("123456782")
    assert not valid_israeli_id("18")  # too short
    assert valid_israeli_id("000000018")
    assert not valid_israeli_id("123456789")
    assert not valid_israeli_id("")


def test_name_must_contain_every_query_word():
    assert name_matches("דוד  לוי", "דוד לוי")
    assert name_matches("לוי דוד", "דוד לוי")
    assert not name_matches("דוד לויתן", "דוד לוי")
    assert name_matches("Bank Leumi Le-Israel", "bank leumi")
    assert not name_matches("דוד לוי", "")


def test_city_tolerates_spelling_noise():
    assert city_matches("תל אביב -יפו", "תל אביב")
    assert city_matches("חיפה", "חיפה")
    assert not city_matches("חיפה", "חדרה")
    assert not city_matches("", "חיפה")


def test_search_endpoint_never_echoes_id(monkeypatch):
    monkeypatch.setattr(playground, "lookup", lambda he, en, city: {"people": [], "companies": [], "errors": []})
    r = TestClient(app).post("/playground/search", json={"name_he": "דוד לוי", "id_number": "123456782"})
    assert r.status_code == 200
    assert r.json()["id_valid"] is True
    assert "123456782" not in r.text


def test_search_needs_some_name():
    r = TestClient(app).post("/playground/search", json={"city": "חיפה", "id_number": "123456782"})
    assert r.status_code == 422
