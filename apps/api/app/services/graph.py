"""Sequence graph helpers: validation and traversal.

Node types
  start      – entry point (exactly one)
  send       – data: {template_ids: [...], same_thread: bool}; random even pick per lead
  wait       – data: {days, hours, minutes, working_days_only}
  condition  – data: {check: opened|clicked|replied, within_days?}; outgoing edges use sourceHandle "yes"/"no"
"""

NODE_TYPES = {"start", "send", "wait", "condition"}


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
        if t == "condition" and d.get("check") not in ("opened", "clicked", "replied"):
            errors.append(f"'{label}' must check opened, clicked or replied")
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
