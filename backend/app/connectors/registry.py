from app.connectors.base import Connector
from app.connectors.google import GoogleConnector
from app.connectors.guided import BituachLeumiWork, RentalContract
from app.connectors.phone import PhoneConnector

_ALL: list[Connector] = [
    PhoneConnector(),
    GoogleConnector(),
    BituachLeumiWork(),
    RentalContract(),
]

REGISTRY: dict[str, Connector] = {c.key: c for c in _ALL}


def get(key: str) -> Connector | None:
    return REGISTRY.get(key)
