import csv
import io
import json
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Contact, ContactList, Suppression, list_contacts
from app.models.contact import STANDARD_FIELDS
from app.schemas import ORM
from app.services import limits
from app.services.renderer import ALIASES, norm_key

router = APIRouter(tags=["contacts"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
FIELD_LEN = {"first_name": 120, "last_name": 120, "city": 120, "country": 120, "phone": 60, "company": 200, "title": 200}


def _clip(k: str, v):
    return v[: FIELD_LEN.get(k, 255)] if isinstance(v, str) else v


class ListIn(BaseModel):
    name: str
    description: str = ""


class ListOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    source: str
    columns: list
    created_at: datetime
    contact_count: int = 0


class ContactOut(ORM):
    id: uuid.UUID
    email: str
    first_name: str
    last_name: str
    company: str
    title: str
    phone: str
    website: str
    linkedin_url: str
    city: str
    country: str
    fields: dict
    source: str
    verify_status: str
    verify_reason: str
    unsubscribed: bool
    created_at: datetime


class ContactIn(BaseModel):
    email: EmailStr
    first_name: str = ""
    last_name: str = ""
    company: str = ""
    title: str = ""
    fields: dict = {}
    list_id: uuid.UUID | None = None


async def _count_in_list(db, list_id) -> int:
    return (await db.execute(select(func.count()).select_from(list_contacts).where(list_contacts.c.list_id == list_id))).scalar_one()


# ── Lists ───────────────────────────────────────────────────────

@router.get("/lists", response_model=list[ListOut])
async def get_lists(user: CurrentUser, db: DB):
    rows = (await db.execute(
        select(ContactList, func.count(list_contacts.c.contact_id))
        .outerjoin(list_contacts, list_contacts.c.list_id == ContactList.id)
        .where(ContactList.user_id == user.id).group_by(ContactList.id).order_by(ContactList.created_at.desc())
    )).all()
    return [ListOut.model_validate(lst).model_copy(update={"contact_count": n}) for lst, n in rows]


@router.post("/lists", response_model=ListOut, status_code=201)
async def create_list(body: ListIn, user: CurrentUser, db: DB):
    lst = ContactList(user_id=user.id, name=body.name.strip() or "Untitled list", description=body.description)
    db.add(lst)
    await db.commit()
    await db.refresh(lst)
    return lst


@router.patch("/lists/{list_id}", response_model=ListOut)
async def rename_list(list_id: uuid.UUID, body: ListIn, user: CurrentUser, db: DB):
    lst = await get_owned(db, ContactList, list_id, user)
    lst.name, lst.description = body.name.strip() or lst.name, body.description
    await db.commit()
    return ListOut.model_validate(lst).model_copy(update={"contact_count": await _count_in_list(db, lst.id)})


@router.delete("/lists/{list_id}", status_code=204)
async def delete_list(list_id: uuid.UUID, user: CurrentUser, db: DB, delete_contacts: bool = False):
    lst = await get_owned(db, ContactList, list_id, user)
    if delete_contacts:
        ids = select(list_contacts.c.contact_id).where(list_contacts.c.list_id == lst.id)
        await db.execute(delete(Contact).where(Contact.user_id == user.id, Contact.id.in_(ids)))
    await db.delete(lst)
    await db.commit()


def _map_header(h: str) -> str:
    """CSV header → standard field name, or a cleaned custom field name."""
    k = norm_key(h)
    for f in STANDARD_FIELDS:
        if norm_key(f) == k:
            return f
    if k in ("emailaddress", "mail", "workemail", "emailid"):
        return "email"
    if k in ALIASES and ALIASES[k] in STANDARD_FIELDS:
        return ALIASES[k]
    return h.strip()


@router.post("/lists/{list_id}/import")
async def import_csv(
    list_id: uuid.UUID, user: CurrentUser, db: DB,
    file: UploadFile = File(...),
    mapping: str = Form("{}", description='Optional JSON {"CSV Header": "first_name" | "custom name" | ""}'),
):
    lst = await get_owned(db, ContactList, list_id, user)
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "CSV is larger than 20 MB")
    text = raw.decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    headers = reader.fieldnames or []
    user_map: dict = json.loads(mapping or "{}")
    col_map = {h: (user_map[h] if h in user_map else _map_header(h)) for h in headers}
    if "email" not in col_map.values():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No email column found — map one of the columns to 'email'")

    remaining = await limits.contacts_remaining(db, user)
    suppressed = set((await db.execute(select(Suppression.email).where(Suppression.user_id == user.id))).scalars())
    stats = {"rows": 0, "imported": 0, "updated": 0, "invalid": 0, "duplicates": 0, "suppressed": 0, "over_limit": 0}
    custom_cols: set[str] = set(lst.columns or [])
    seen: set[str] = set()

    for row in reader:
        stats["rows"] += 1
        values = {"fields": {}}
        for h, target in col_map.items():
            if not target:
                continue
            v = (row.get(h) or "").strip()
            if target in STANDARD_FIELDS:
                values[target] = v
            elif v:
                values["fields"][target] = v
                custom_cols.add(target)
        email = (values.get("email") or "").lower()
        if not EMAIL_RE.match(email):
            stats["invalid"] += 1
            continue
        if email in seen:
            stats["duplicates"] += 1
            continue
        seen.add(email)
        if email in suppressed:
            stats["suppressed"] += 1
        values["email"] = email
        existing = (await db.execute(select(Contact).where(Contact.user_id == user.id, Contact.email == email))).scalar_one_or_none()
        if existing:
            for k, v in values.items():
                if k == "fields":
                    existing.fields = {**(existing.fields or {}), **v}
                elif v and k != "email":
                    setattr(existing, k, _clip(k, v))
            contact = existing
            stats["updated"] += 1
        else:
            if remaining <= 0:
                stats["over_limit"] += 1
                continue
            contact = Contact(user_id=user.id, source="csv", **{k: _clip(k, v) for k, v in values.items()})
            db.add(contact)
            await db.flush()
            remaining -= 1
            stats["imported"] += 1
        await db.execute(insert(list_contacts).values(list_id=lst.id, contact_id=contact.id).on_conflict_do_nothing())

    lst.columns = sorted(custom_cols)
    lst.source = "csv" if lst.source == "manual" else lst.source
    await db.commit()
    return {**stats, "columns": col_map}


@router.post("/lists/{list_id}/preview-headers")
async def preview_headers(list_id: uuid.UUID, user: CurrentUser, db: DB, file: UploadFile = File(...)):
    await get_owned(db, ContactList, list_id, user)
    text = (await file.read(256 * 1024)).decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    sample = [row for _, row in zip(range(3), reader)]
    headers = reader.fieldnames or []
    return {"headers": [{"name": h, "suggested": _map_header(h), "sample": [r.get(h, "") for r in sample]} for h in headers]}


# ── Contacts ────────────────────────────────────────────────────

@router.get("/contacts")
async def get_contacts(
    user: CurrentUser, db: DB,
    list_id: uuid.UUID | None = None, q: str = "", status_filter: str = Query("", alias="status"),
    page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
):
    stmt = select(Contact).where(Contact.user_id == user.id)
    if list_id:
        stmt = stmt.join(list_contacts, list_contacts.c.contact_id == Contact.id).where(list_contacts.c.list_id == list_id)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(Contact.email.like(like), func.lower(Contact.first_name).like(like),
                              func.lower(Contact.last_name).like(like), func.lower(Contact.company).like(like)))
    if status_filter:
        stmt = stmt.where(Contact.verify_status == status_filter)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Contact.created_at.desc()).offset((page - 1) * size).limit(size))).scalars().all()
    return {"total": total, "items": [ContactOut.model_validate(c) for c in rows]}


@router.post("/contacts", response_model=ContactOut, status_code=201)
async def add_contact(body: ContactIn, user: CurrentUser, db: DB):
    email = body.email.lower()
    c = (await db.execute(select(Contact).where(Contact.user_id == user.id, Contact.email == email))).scalar_one_or_none()
    if not c:
        if await limits.contacts_remaining(db, user) <= 0:
            raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, f"Contact limit reached ({user.max_contacts})")
        c = Contact(user_id=user.id, email=email)
        db.add(c)
    c.first_name, c.last_name, c.company, c.title = body.first_name, body.last_name, body.company, body.title
    c.fields = {**(c.fields or {}), **body.fields}
    await db.flush()
    if body.list_id:
        await get_owned(db, ContactList, body.list_id, user)
        await db.execute(insert(list_contacts).values(list_id=body.list_id, contact_id=c.id).on_conflict_do_nothing())
    await db.commit()
    await db.refresh(c)
    return c


@router.delete("/contacts/{contact_id}", status_code=204)
async def delete_contact(contact_id: uuid.UUID, user: CurrentUser, db: DB):
    c = await get_owned(db, Contact, contact_id, user)
    await db.delete(c)
    await db.commit()


@router.get("/variables")
async def variables(user: CurrentUser, db: DB):
    """Every variable available to templates: standard fields + custom columns across lists."""
    custom: set[str] = set()
    for cols in (await db.execute(select(ContactList.columns).where(ContactList.user_id == user.id))).scalars():
        custom.update(cols or [])
    standard = [
        {"key": "FirstName", "label": "First name"}, {"key": "LastName", "label": "Last name"},
        {"key": "FullName", "label": "Full name"}, {"key": "Email", "label": "Email"},
        {"key": "Company", "label": "Company"}, {"key": "Title", "label": "Job title"},
        {"key": "Website", "label": "Website"}, {"key": "City", "label": "City"}, {"key": "Country", "label": "Country"},
        {"key": "LinkedinUrl", "label": "LinkedIn URL"}, {"key": "Phone", "label": "Phone"},
    ]
    system = [{"key": "sender_name", "label": "Sender name"}, {"key": "unsubscribe_url", "label": "Unsubscribe link"}]
    return {"standard": standard, "custom": [{"key": c, "label": c} for c in sorted(custom)], "system": system}


# ── Suppression list ───────────────────────────────────────────

class SuppressIn(BaseModel):
    emails: list[str]
    reason: str = "manual"


@router.get("/suppressions")
async def list_suppressions(user: CurrentUser, db: DB, q: str = ""):
    stmt = select(Suppression).where(Suppression.user_id == user.id)
    if q:
        stmt = stmt.where(Suppression.email.like(f"%{q.lower()}%"))
    rows = (await db.execute(stmt.order_by(Suppression.created_at.desc()).limit(1000))).scalars().all()
    return [{"email": s.email, "reason": s.reason, "created_at": s.created_at} for s in rows]


@router.post("/suppressions", status_code=204)
async def add_suppressions(body: SuppressIn, user: CurrentUser, db: DB):
    for e in {e.strip().lower() for e in body.emails if EMAIL_RE.match(e.strip())}:
        await db.execute(insert(Suppression).values(user_id=user.id, email=e, reason=body.reason).on_conflict_do_nothing())
    await db.commit()


@router.delete("/suppressions/{email}", status_code=204)
async def remove_suppression(email: str, user: CurrentUser, db: DB):
    await db.execute(delete(Suppression).where(Suppression.user_id == user.id, Suppression.email == email.lower()))
    await db.commit()
