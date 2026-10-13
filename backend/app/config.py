from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="TP_", extra="ignore")

    database_url: str = "postgresql+psycopg://trust:trust@localhost:5432/trust"
    public_base_url: str = "http://localhost:8000"

    # Retention: evidence expires after this many days unless refreshed
    evidence_retention_days: int = 365 * 3
    # Default share link lifetime
    share_default_days: int = 7

    # Dev mode: OTP codes are returned in the API response instead of sent by SMS
    dev_mode: bool = True


settings = Settings()
