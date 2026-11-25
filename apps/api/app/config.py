"""Application configuration — loaded from environment variables via pydantic-settings."""

from functools import cached_property

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── App ─────────────────────────────────────────
    APP_NAME: str = "Sigmaflux Mail"
    APP_ENV: str = "development"
    API_PREFIX: str = "/api/v1"
    PUBLIC_API_URL: str = "http://localhost:8010"
    WEB_URL: str = "http://localhost:3010"
    CORS_ORIGINS: str = "http://localhost:3010"

    # ── Database / Redis ────────────────────────────
    DATABASE_URL: str = "postgresql+asyncpg://sfmail:sfmail_password@localhost:5440/sfmail"
    REDIS_URL: str = "redis://localhost:6390/0"

    # ── Security ────────────────────────────────────
    JWT_SECRET: str = "change-me"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 14
    ENCRYPTION_KEY: str = ""

    SUPERADMIN_EMAIL: str = "admin@example.com"
    SUPERADMIN_PASSWORD: str = "change-me"

    # ── OAuth providers ─────────────────────────────
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    MICROSOFT_CLIENT_ID: str = ""
    MICROSOFT_CLIENT_SECRET: str = ""
    MICROSOFT_TENANT: str = "common"

    # ── Verifier ────────────────────────────────────
    VERIFIER_HELO_DOMAIN: str = "verify.example.com"
    VERIFIER_MAIL_FROM: str = "check@verify.example.com"
    VERIFIER_SMTP_TIMEOUT: float = 10.0

    # ── Worker ──────────────────────────────────────
    ENGINE_TICK_SECONDS: int = 20
    REPLY_POLL_SECONDS: int = 120
    ENGINE_BATCH_SIZE: int = 50
    RESEARCH_TICK_SECONDS: int = 5

    @cached_property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def oauth_redirect_base(self) -> str:
        return f"{self.PUBLIC_API_URL}{self.API_PREFIX}/mailboxes/oauth"


settings = Settings()
