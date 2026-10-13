from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import router
from app.config import settings
from app.db import Base, engine


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Dev convenience: create tables on start. Replace with Alembic migrations before production.
    if settings.dev_mode:
        Base.metadata.create_all(engine)
    yield


app = FastAPI(title="Trust Profile API", version="0.1.0", lifespan=lifespan)
app.include_router(router)


@app.get("/health")
def health():
    return {"ok": True}
