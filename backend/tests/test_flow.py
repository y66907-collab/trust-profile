"""End-to-end happy path on SQLite: person -> connect -> referee -> share -> view."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import services
from app.db import Base, get_session
from app.main import app


class FakeTabu:
    def owners(self, gush, helka, sub_helka=None):
        return ["דוד כהן"] if (gush, helka) == ("6666", "123") else []


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)

    def _s():
        with Session() as s:
            yield s

    app.dependency_overrides[get_session] = _s
    services.tabu_lookup = FakeTabu()
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_full_flow(client):
    pid = client.post("/persons", json={"display_name": "נועה לוי"}).json()["id"]

    # phone OTP (dev mode returns the code)
    code = client.post(f"/persons/{pid}/connect/id.phone/start", json={"phone": "0521234567"}).json()["data"]["dev_code"]
    r = client.post(f"/persons/{pid}/connect/id.phone/complete", json={"code": code})
    assert r.status_code == 200 and r.json()["stored"][0]["proof_level"] == 2

    # guided download: Bituach Leumi (parser stub -> pre-extracted fields)
    r = client.post(f"/persons/{pid}/connect/work.btl/complete", json={"extracted": {
        "periods": [{"employer": "אלפא בע\"מ", "months": 30}, {"employer": "בטא", "months": 42}],
        "religion": "should be dropped",
    }})
    assert r.json()["stored"][0]["proof_level"] == 4

    # forbidden field never stored
    me = client.get(f"/persons/{pid}/me").json()
    assert all("religion" not in str(e["value"]) for e in me["evidence"])

    # referee: previous landlord who is the registered owner -> level 4
    link = client.post(f"/persons/{pid}/referees", json={
        "role": "landlord", "name": "דוד כהן", "contact": "0549999999", "city": "חיפה", "gush_helka": "6666-123",
    }).json()["link"]
    form = client.get(link).json()
    assert form["role"] == "landlord" and len(form["questions"]) >= 5
    r = client.post(link, json={"paid_on_time": 5, "would_rent_again": True, "free_text": "ignored"})
    assert r.json()["proof_level"] == 4
    assert client.get(link).status_code == 404  # one answer per link

    # share for rental, one-time
    share = client.post(f"/persons/{pid}/shares", json={"context": "rental", "one_time": True}).json()
    view = client.get(share["link"]).json()
    assert view["name"] == "נועה לוי"
    assert {i["kind"] for i in view["items"]} == {"identity", "work", "reference"}
    assert all("value" not in i for i in view["items"])  # viewer never sees raw values
    assert client.get(share["link"]).status_code == 404  # one-time

    # completeness is a meter, not a score
    assert 0 < me["completeness"]["percent"] <= 100


def test_referee_rejects_bool_as_score():
    from app.connectors.referee import validate_answers

    clean = validate_answers("landlord", {"paid_on_time": True, "would_rent_again": 3, "kept_contract": False})
    assert clean == {"kept_contract": False}


def test_revoke_source_deletes_evidence(client):
    pid = client.post("/persons", json={"display_name": "x"}).json()["id"]
    code = client.post(f"/persons/{pid}/connect/id.phone/start", json={"phone": "0500000000"}).json()["data"]["dev_code"]
    client.post(f"/persons/{pid}/connect/id.phone/complete", json={"code": code})
    assert client.delete(f"/persons/{pid}/sources/id.phone").json()["deleted"] == 1
    assert client.get(f"/persons/{pid}/me").json()["evidence"] == []
