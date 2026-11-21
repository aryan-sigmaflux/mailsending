from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    admin, auth, campaigns, contacts, dashboard, domains, integrations, mailboxes, sequences, templates, tracking, verifier,
)

app = FastAPI(title=settings.APP_NAME, version="0.1.0", docs_url="/docs", openapi_url="/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth, admin, dashboard, domains, mailboxes, contacts, templates, sequences, campaigns, verifier, integrations, tracking):
    app.include_router(r.router, prefix=settings.API_PREFIX)


@app.get("/health")
async def health():
    return {"ok": True, "app": settings.APP_NAME}
