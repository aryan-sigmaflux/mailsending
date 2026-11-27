"""One-off emails composed by hand (outside any campaign), with the same tracking and reply detection."""

import uuid
from datetime import datetime, timezone

import aiosmtplib
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Contact, Mailbox, Message, Template
from app.services import limits, outreach, renderer, transport

router = APIRouter(prefix="/messages", tags=["messages"])


class ComposeIn(BaseModel):
    mailbox_id: uuid.UUID
    to: EmailStr
    subject: str = Field(min_length=1, max_length=500)
    body_html: str = Field(min_length=1)
    template_id: uuid.UUID | None = None
    track_opens: bool = True
    track_clicks: bool = False


@router.post("/send", status_code=201)
async def send_one(body: ComposeIn, user: CurrentUser, db: DB):
    mb = await get_owned(db, Mailbox, body.mailbox_id, user)
    if mb.status == "paused":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This mailbox is paused")
    if body.template_id:
        await get_owned(db, Template, body.template_id, user)
    to = str(body.to).strip().lower()
    entry = await outreach.blocked(db, user.id, to)
    if entry:
        what = "domain" if entry["entry"].startswith("@") else "address"
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"{to} is on your do-not-contact list ({entry['label'].lower()} — {what} {entry['entry']})")
    if await limits.sending_capacity(db, user) <= 0:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "You've reached your daily or monthly sending limit")

    # If the recipient is a known lead, {{variables}} resolve from their record.
    contact = (await db.execute(
        select(Contact).where(Contact.user_id == user.id, func.lower(Contact.email) == to).limit(1)
    )).scalar_one_or_none()

    msg_id = uuid.uuid4()
    subject, html = renderer.render(
        body.subject, body.body_html, contact, message_id=msg_id, track_opens=body.track_opens,
        track_clicks=body.track_clicks, sender_name=mb.from_name, sender_email=mb.email, signature_html=mb.signature_html,
    )
    header_id = transport.new_message_id(mb)
    email = transport.build_message(mb, to=to, subject=subject, html=html, text=renderer.html_to_text(html), message_id=header_id)
    try:
        await transport.send(mb, email)
    except aiosmtplib.SMTPRecipientsRefused as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"The recipient was refused: {e}") from e
    except Exception as e:  # noqa: BLE001
        await db.commit()  # keep a refreshed OAuth token, if any
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Send failed — {type(e).__name__}: {e}") from e

    now = datetime.now(timezone.utc)
    db.add(Message(
        id=msg_id, user_id=user.id, contact_id=contact.id if contact else None, mailbox_id=mb.id,
        template_id=body.template_id, to_email=to, subject=subject, body_html=html, message_id_header=header_id,
        status="sent", sent_at=now,
    ))
    mb.last_sent_at, mb.last_error = now, None
    await limits.bump_usage(db, user.id, emails=1)
    await db.commit()
    return {"id": msg_id, "to": to, "subject": subject, "sent_at": now}


@router.get("/single")
async def single_messages(user: CurrentUser, db: DB, size: int = Query(10, le=50)):
    """Recently composed one-off emails and how they did."""
    rows = (await db.execute(
        select(Message, Mailbox.email).outerjoin(Mailbox, Mailbox.id == Message.mailbox_id)
        .where(Message.user_id == user.id, Message.campaign_id.is_(None)).order_by(Message.sent_at.desc()).limit(size)
    )).all()
    return [{"id": m.id, "to": m.to_email, "subject": m.subject, "mailbox": mb, "status": m.status, "sent_at": m.sent_at,
             "opened_at": m.opened_at, "clicked_at": m.clicked_at, "replied_at": m.replied_at, "open_count": m.open_count}
            for m, mb in rows]
