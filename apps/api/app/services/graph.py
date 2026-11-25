"""Sequence graph helpers: validation and traversal.

Node types
  start      – entry point (exactly one)
  send       – data: {template_ids: [...], same_thread: bool}; random even pick per lead
  wait       – data: {days, hours, minutes, working_days_only}
  condition  – outgoing edges use sourceHandle "yes"/"no". data.check is one of
                 opened | clicked | replied            engagement with earlier emails in this campaign
                 researched                            the lead's website research has finished
                 site_issue  {issues: [code], match: any|all}   website audit found these issues
                 metric      {metric, op: lt|lte|gt|gte|eq|neq, value}   research number (score, keyword volume, bids…)
                 field       {field, op: equals|not_equals|contains|empty|not_empty|lt|lte|gt|gte, value}  any lead value
               Leads without finished research take "No" on research checks.
"""

NODE_TYPES = {"start", "send", "wait", "condition"}
ENGAGEMENT_CHECKS = {"opened", "clicked", "replied"}
RESEARCH_CHECKS = {"researched", "site_issue", "metric"}
CONDITION_CHECKS = ENGAGEMENT_CHECKS | RESEARCH_CHECKS | {"field"}
NUMERIC_OPS = {"lt", "lte", "gt", "gte", "eq", "neq"}
FIELD_OPS = {"equals", "not_equals", "contains", "empty", "not_empty", "lt", "lte", "gt", "gte"}


def condition_errors(label: str, d: dict) -> list[str]:
    from app.services.research import METRICS
    from app.services.site_audit import ISSUES

    check = d.get("check")
    if check not in CONDITION_CHECKS:
        return [f"'{label}' has an unknown check '{check}'"]
    if check == "site_issue":
        codes = d.get("issues") or []
        if not codes:
            return [f"'{label}' — pick at least one website issue"]
        bad = [c for c in codes if c not in ISSUES]
        if bad:
            return [f"'{label}' checks unknown website issue(s): {', '.join(bad)}"]
    if check == "metric":
        if d.get("metric") not in METRICS:
            return [f"'{label}' — pick a research metric to compare"]
        if d.get("op") not in NUMERIC_OPS:
            return [f"'{label}' — pick a comparison (less than, greater than…)"]
        try:
            float(d.get("value"))
        except (TypeError, ValueError):
            return [f"'{label}' — enter a number to compare against"]
    if check == "field":
        if not str(d.get("field") or "").strip():
            return [f"'{label}' — pick the lead field to check"]
        if d.get("op") not in FIELD_OPS:
            return [f"'{label}' — pick how to compare the field"]
        if d.get("op") in ("equals", "not_equals", "contains", "lt", "lte", "gt", "gte") and str(d.get("value") or "") == "":
            return [f"'{label}' — enter a value to compare the field with"]
    return []


def nodes_by_id(graph: dict) -> dict[str, dict]:
    return {n["id"]: n for n in graph.get("nodes", [])}


def next_node(graph: dict, node_id: str, handle: str | None = None) -> str | None:
    for e in graph.get("edges", []):
        if e.get("source") == node_id and (handle is None or (e.get("sourceHandle") or "yes") == handle):
            return e.get("target")
    return None


def start_node(graph: dict) -> str | None:
    for n in graph.get("nodes", []):
        if n.get("type") == "start":
            return n["id"]
    return None


def validate(graph: dict, template_ids: set[str] | None = None) -> list[str]:
    errors: list[str] = []
    nodes = graph.get("nodes", [])
    by_id = nodes_by_id(graph)
    starts = [n for n in nodes if n.get("type") == "start"]
    if len(starts) != 1:
        errors.append("The sequence needs exactly one Start node")
    for n in nodes:
        t, d, label = n.get("type"), n.get("data") or {}, n.get("data", {}).get("label") or n.get("type")
        if t not in NODE_TYPES:
            errors.append(f"Unknown node type '{t}'")
            continue
        if t == "send":
            ids = d.get("template_ids") or []
            if not ids:
                errors.append(f"'{label}' has no template selected")
            elif template_ids is not None and any(i not in template_ids for i in ids):
                errors.append(f"'{label}' references a deleted template")
        if t == "wait":
            total = int(d.get("days") or 0) * 1440 + int(d.get("hours") or 0) * 60 + int(d.get("minutes") or 0)
            if total <= 0:
                errors.append(f"'{label}' wait must be longer than 0 minutes")
        if t == "condition":
            errors.extend(condition_errors(label, d))
    for e in graph.get("edges", []):
        if e.get("source") not in by_id or e.get("target") not in by_id:
            errors.append("An edge points to a missing node")
    if starts and not any(n.get("type") == "send" for n in nodes):
        errors.append("Add at least one Send Mail node")
    if starts and not next_node(graph, starts[0]["id"]):
        errors.append("Connect the Start node to the first step")
    # cycle guard: walk from start, a node visited twice on one path means a loop
    if starts:
        def walk(nid: str, path: set[str]) -> bool:
            if nid in path:
                return True
            path = path | {nid}
            return any(walk(e["target"], path) for e in graph.get("edges", []) if e.get("source") == nid)
        if walk(starts[0]["id"], set()):
            errors.append("The sequence contains a loop")
    return errors


def single_template_graph(template_ids: list[str]) -> dict:
    """Single-template campaigns run through the same engine as a 2-node graph."""
    return {
        "nodes": [
            {"id": "start", "type": "start", "data": {}},
            {"id": "send", "type": "send", "data": {"template_ids": template_ids, "label": "Send"}},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "send"}],
    }


def first_send_nodes(graph: dict) -> list[dict]:
    """Send nodes that can be a lead's FIRST email (no earlier send on some path from Start)."""
    by_id, out, seen = nodes_by_id(graph), [], set()
    stack = [start_node(graph)]
    while stack:
        nid = stack.pop()
        if not nid or nid in seen:
            continue
        seen.add(nid)
        node = by_id.get(nid)
        if not node:
            continue
        if node.get("type") == "send":
            out.append(node)
            continue  # anything after this isn't a first email on this path
        stack.extend(e["target"] for e in graph.get("edges", []) if e.get("source") == nid)
    return out


def template_ids_in(graph: dict) -> list[str]:
    ids: list[str] = []
    for n in graph.get("nodes", []):
        if n.get("type") == "send":
            ids.extend(n.get("data", {}).get("template_ids") or [])
    return list(dict.fromkeys(ids))


DEFAULT_SEND_LABELS = {"", "send", "send mail"}


def send_steps(graph: dict) -> dict[str, int]:
    """Step number of every reachable Send node: how many emails a lead has received once it runs (1 = first email).
    Branches share numbers, e.g. the Yes and No follow-ups after a condition are both step 2."""
    by_id, steps = nodes_by_id(graph), {}
    best: dict[str, int] = {}
    queue = [(start_node(graph), 0)]
    while queue:
        nid, sends = queue.pop(0)
        node = by_id.get(nid) if nid else None
        if not node or best.get(nid, 1 << 30) <= sends:
            continue
        best[nid] = sends
        if node.get("type") == "send":
            sends += 1
            steps[nid] = sends
        queue.extend((e.get("target"), sends) for e in graph.get("edges", []) if e.get("source") == nid)
    return steps


def stage_of(graph: dict | None, node_id: str | None) -> dict:
    """Which stage of the campaign a sent email belongs to: {node_id, step, of, name}."""
    graph = graph or {}
    steps = send_steps(graph)
    node = nodes_by_id(graph).get(node_id or "") or {}
    name = ((node.get("data") or {}).get("label") or "").strip()
    return {"node_id": node_id, "step": steps.get(node_id or ""), "of": max(steps.values(), default=0) or None,
            "name": None if name.lower() in DEFAULT_SEND_LABELS else name}


def campaign_graph(c) -> dict:
    """The graph a campaign's emails were sent from: frozen at launch; a never-launched single-template campaign
    is its 1-step graph."""
    if c.graph_snapshot:
        return c.graph_snapshot
    return single_template_graph([str(t) for t in c.template_ids or []]) if c.kind == "single" else {}
