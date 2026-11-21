import re
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy import select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Domain, Mailbox
from app.schemas import ORM
from app.services import limits
from app.services.dns_checker import check_domain

router = APIRouter(prefix="/domains", tags=["domains"])

DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$")


class DomainIn(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def clean(cls, v: str) -> str:
        v = v.strip().lower().removeprefix("http://").removeprefix("https://").split("/")[0].removeprefix("www.")
        if not DOMAIN_RE.match(v):
            raise ValueError("Enter a valid domain, e.g. example.com")
        return v


class DomainOut(ORM):
    id: uuid.UUID
    name: str
    verified: bool
    verify_token: str
    health_score: int | None
    last_check: dict | None
    checked_at: datetime | None
    created_at: datetime
    mailbox_count: int = 0


async def _out(db, d: Domain) -> DomainOut:
    n = len((await db.execute(select(Mailbox.id).where(Mailbox.domain_id == d.id))).all())
    return DomainOut.model_validate(d).model_copy(update={"mailbox_count": n})


async def run_check(db, d: Domain) -> Domain:
    result = await check_domain(d.name, d.verify_token)
    d.last_check = result
    d.health_score = result["score"]
    d.checked_at = datetime.now(timezone.utc)
    if result["ownership"] and result["ownership"]["status"] == "pass":
        d.verified = True
    await db.commit()
    await db.refresh(d)
    return d


@router.get("", response_model=list[DomainOut])
async def list_domains(user: CurrentUser, db: DB):
    rows = (await db.execute(select(Domain).where(Domain.user_id == user.id).order_by(Domain.created_at))).scalars().all()
    return [await _out(db, d) for d in rows]


@router.post("", response_model=DomainOut, status_code=201)
async def add_domain(body: DomainIn, user: CurrentUser, db: DB):
    if (await db.execute(select(Domain).where(Domain.user_id == user.id, Domain.name == body.name))).scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "Domain already added")
    await limits.ensure_can_add_domain(db, user)
    d = Domain(user_id=user.id, name=body.name, verify_token=secrets.token_hex(12))
    db.add(d)
    await db.flush()
    # Link existing mailboxes on this domain.
    for mb in (await db.execute(select(Mailbox).where(Mailbox.user_id == user.id, Mailbox.domain_id.is_(None)))).scalars():
        if mb.email.endswith("@" + body.name):
            mb.domain_id = d.id
    await db.commit()
    await run_check(db, d)
    return await _out(db, d)


@router.post("/{domain_id}/check", response_model=DomainOut)
async def recheck(domain_id: uuid.UUID, user: CurrentUser, db: DB):
    d = await get_owned(db, Domain, domain_id, user)
    return await _out(db, await run_check(db, d))


@router.delete("/{domain_id}", status_code=204)
async def delete_domain(domain_id: uuid.UUID, user: CurrentUser, db: DB):
    d = await get_owned(db, Domain, domain_id, user)
    await db.delete(d)
    await db.commit()


@router.get("/lookup")
async def lookup(user: CurrentUser, domain: str = Query(..., min_length=3, max_length=253)):
    """Ad-hoc checker for any domain (not saved)."""
    try:
        name = DomainIn(name=domain).name
    except ValidationError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter a valid domain, e.g. example.com")
    return await check_domain(name)
