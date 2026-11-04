from app.connectors.base import Connector
from app.connectors.github import GitHubConnector
from app.connectors.google import GoogleConnector
from app.connectors.guided import BituachLeumiWork, RentalContract
from app.connectors.phone import PhoneConnector
from app.connectors.telegram import TelegramConnector

_ALL: list[Connector] = [
    PhoneConnector(),
    GoogleConnector(),
    GitHubConnector(),
    TelegramConnector(),
    BituachLeumiWork(),
    RentalContract(),
]

REGISTRY: dict[str, Connector] = {c.key: c for c in _ALL}


def get(key: str) -> Connector | None:
    return REGISTRY.get(key)
