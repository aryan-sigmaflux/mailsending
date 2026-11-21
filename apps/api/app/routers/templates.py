import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from app.core.crypto import decrypt_str
from app.core.deps import DB, CurrentUser, get_owned
from app.models import Contact, Integration, Template
from app.schemas import ORM
from app.services import ai, renderer

router = APIRouter(prefix="/templates", tags=["templates"])


class TemplateIn(BaseModel):
    name: str
    subject: str = ""
    body_html: str = ""
    track_opens: bool = True
    track_clicks: bool = True


class TemplateOut(ORM):
    id: uuid.UUID
    name: str
    subject: str
    body_html: str
    track_opens: bool
    track_clicks: bool
    variables: list
    created_at: datetime
    updated_at: datetime


class PreviewIn(BaseModel):
    subject: str
    body_html: str
    contact_id: uuid.UUID | None = None


class AssistIn(BaseModel):
    instruction: str  # e.g. "write a cold email to HR heads about our payroll tool"
    subject: str = ""
    body_html: str = ""
    mode: str = "write"  # write | rewrite | shorten


@router.get("", response_model=list[TemplateOut])
async def list_templates(user: CurrentUser, db: DB):
    return (await db.execute(select(Template).where(Template.user_id == user.id).order_by(Template.updated_at.desc()))).scalars().all()


@router.post("", response_model=TemplateOut, status_code=201)
async def create_template(body: TemplateIn, user: CurrentUser, db: DB):
    t = Template(user_id=user.id, **body.model_dump(), variables=renderer.extract_variables(body.subject, body.body_html))
    t.name = t.name.strip() or "Untitled template"
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


@router.get("/{template_id}", response_model=TemplateOut)
async def get_template(template_id: uuid.UUID, user: CurrentUser, db: DB):
    return await get_owned(db, Template, template_id, user)


@router.put("/{template_id}", response_model=TemplateOut)
async def update_template(template_id: uuid.UUID, body: TemplateIn, user: CurrentUser, db: DB):
    t = await get_owned(db, Template, template_id, user)
    for k, v in body.model_dump().items():
        setattr(t, k, v)
    t.name = t.name.strip() or "Untitled template"
    t.variables = renderer.extract_variables(body.subject, body.body_html)
    await db.commit()
    await db.refresh(t)
    return t


@router.post("/{template_id}/duplicate", response_model=TemplateOut, status_code=201)
async def duplicate_template(template_id: uuid.UUID, user: CurrentUser, db: DB):
    src = await get_owned(db, Template, template_id, user)
    t = Template(user_id=user.id, name=f"{src.name} (copy)", subject=src.subject, body_html=src.body_html,
                 track_opens=src.track_opens, track_clicks=src.track_clicks, variables=src.variables)
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


@router.delete("/{template_id}", status_code=204)
async def delete_template(template_id: uuid.UUID, user: CurrentUser, db: DB):
    t = await get_owned(db, Template, template_id, user)
    await db.delete(t)
    await db.commit()


@router.post("/preview")
async def preview(body: PreviewIn, user: CurrentUser, db: DB):
    contact = await get_owned(db, Contact, body.contact_id, user) if body.contact_id else None
    if contact is None:
        contact = (await db.execute(select(Contact).where(Contact.user_id == user.id).limit(1))).scalar_one_or_none()
    subject, html = renderer.render(body.subject, body.body_html, contact, sender_name=user.full_name, seed=7)
    variables = renderer.extract_variables(body.subject, body.body_html)
    missing = renderer.missing_variables(variables, renderer.contact_context(contact)) if contact else variables
    return {"subject": subject, "html": html, "contact": contact.email if contact else None,
            "variables": variables, "missing": missing}


@router.post("/assist")
async def assist(body: AssistIn, user: CurrentUser, db: DB):
    integ = (await db.execute(
        select(Integration).where(Integration.user_id == user.id, Integration.kind == "ai")
        .order_by(Integration.is_default.desc(), Integration.created_at)
    )).scalars().first()
    if not integ:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Connect an AI provider in Settings → Integrations first")
    system = (
        "You write concise, personal B2B cold emails that land in the inbox: plain language, no hype, "
        "no spam trigger words, one clear call to action, under 120 words. Keep any {{Variables}} exactly as written. "
        "Reply ONLY with JSON: {\"subject\": \"...\", \"body_html\": \"<p>...</p>\"}."
    )
    prompt = {
        "write": f"Write a cold email. Brief: {body.instruction}",
        "rewrite": f"Rewrite this email. Instruction: {body.instruction}\nSubject: {body.subject}\nBody HTML: {body.body_html}",
        "shorten": f"Make this email shorter and punchier.\nSubject: {body.subject}\nBody HTML: {body.body_html}",
    }.get(body.mode, body.instruction)
    try:
        text = await ai.complete(integ.provider, decrypt_str(integ.secret_enc), prompt, model=(integ.config or {}).get("model"),
                                 base_url=(integ.config or {}).get("base_url"), system=system)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI provider error — {type(e).__name__}: {e}")
    import json
    import re
    m = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        data = {}
    return {"subject": data.get("subject", body.subject), "body_html": data.get("body_html") or f"<p>{text}</p>"}
