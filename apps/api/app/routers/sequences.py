import uuid
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.core.deps import DB, CurrentUser, get_owned
from app.models import Sequence, Template
from app.schemas import ORM
from app.services import graph as g

router = APIRouter(prefix="/sequences", tags=["sequences"])


def default_graph() -> dict:
    return {
        "nodes": [
            {"id": "start", "type": "start", "position": {"x": 80, "y": 200}, "data": {"label": "Start"}},
            {"id": "send-1", "type": "send", "position": {"x": 360, "y": 180}, "data": {"label": "Email 1", "template_ids": [], "same_thread": True}},
            {"id": "wait-1", "type": "wait", "position": {"x": 660, "y": 190},
             "data": {"label": "Wait", "days": 2, "hours": 0, "minutes": 0, "working_days_only": True}},
            {"id": "send-2", "type": "send", "position": {"x": 940, "y": 180}, "data": {"label": "Follow-up", "template_ids": [], "same_thread": True}},
        ],
        "edges": [
            {"id": "e1", "source": "start", "target": "send-1"},
            {"id": "e2", "source": "send-1", "target": "wait-1"},
            {"id": "e3", "source": "wait-1", "target": "send-2"},
        ],
    }


class SequenceIn(BaseModel):
    name: str
    description: str = ""
    graph: dict | None = None


class SequenceOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    graph: dict
    created_at: datetime
    updated_at: datetime


async def _template_ids(db, user) -> set[str]:
    return {str(i) for i in (await db.execute(select(Template.id).where(Template.user_id == user.id))).scalars()}


@router.get("", response_model=list[SequenceOut])
async def list_sequences(user: CurrentUser, db: DB):
    return (await db.execute(select(Sequence).where(Sequence.user_id == user.id).order_by(Sequence.updated_at.desc()))).scalars().all()


@router.post("", response_model=SequenceOut, status_code=201)
async def create_sequence(body: SequenceIn, user: CurrentUser, db: DB):
    s = Sequence(user_id=user.id, name=body.name.strip() or "Untitled sequence", description=body.description,
                 graph=body.graph or default_graph())
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return s


@router.get("/{sequence_id}", response_model=SequenceOut)
async def get_sequence(sequence_id: uuid.UUID, user: CurrentUser, db: DB):
    return await get_owned(db, Sequence, sequence_id, user)


@router.put("/{sequence_id}")
async def save_sequence(sequence_id: uuid.UUID, body: SequenceIn, user: CurrentUser, db: DB):
    s = await get_owned(db, Sequence, sequence_id, user)
    s.name = body.name.strip() or s.name
    s.description = body.description
    if body.graph is not None:
        s.graph = body.graph
    await db.commit()
    await db.refresh(s)
    return {"sequence": SequenceOut.model_validate(s), "errors": g.validate(s.graph, await _template_ids(db, user))}


@router.post("/{sequence_id}/validate")
async def validate_sequence(sequence_id: uuid.UUID, user: CurrentUser, db: DB):
    s = await get_owned(db, Sequence, sequence_id, user)
    return {"errors": g.validate(s.graph, await _template_ids(db, user))}


@router.post("/{sequence_id}/duplicate", response_model=SequenceOut, status_code=201)
async def duplicate_sequence(sequence_id: uuid.UUID, user: CurrentUser, db: DB):
    src = await get_owned(db, Sequence, sequence_id, user)
    s = Sequence(user_id=user.id, name=f"{src.name} (copy)", description=src.description, graph=src.graph)
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return s


@router.delete("/{sequence_id}", status_code=204)
async def delete_sequence(sequence_id: uuid.UUID, user: CurrentUser, db: DB):
    s = await get_owned(db, Sequence, sequence_id, user)
    await db.delete(s)
    await db.commit()
