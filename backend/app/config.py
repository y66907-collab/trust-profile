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

    # GitHub OAuth App (https://github.com/settings/developers). Callback: {public_base_url}/oauth/github/callback
    github_client_id: str = ""
    github_client_secret: str = ""
    # Telegram bot (@BotFather). Login Widget needs the bot's domain set via /setdomain.
    telegram_bot_token: str = ""
    telegram_bot_username: str = ""
    # Veriphone (https://veriphone.io): internal pre-check that a number is a real mobile before sending SMS
    veriphone_key: str = ""

    # SMS for phone codes: "console" (dev, nothing sent) | "smsto" | "twilio"
    sms_provider: str = "console"
    smsto_api_key: str = ""
    smsto_sender_id: str = ""      # optional; alphanumeric needs pre-registration in Israel
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from: str = ""          # Twilio number (+1...) or approved alphanumeric sender


settings = Settings()
