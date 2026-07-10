from typing import Any
from io import BytesIO
import json
import os
import re
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
import plantuml
from plantuml import PlantUML, PlantUMLConnectionError


class FixedPlantUMLHTTPError(PlantUMLConnectionError):
    def __init__(self, response, content, *args, **kwdargs):
        self.response = response
        self.content = content
        message = "%d: %s" % (self.response.status, self.response.reason)
        self.message = message
        super().__init__(message, *args, **kwdargs)


plantuml.PlantUMLHTTPError = FixedPlantUMLHTTPError


def _alias_from_id(element_id: str) -> str:
    return "cls_" + re.sub(r"[^A-Za-z0-9_]", "_", str(element_id))


def _safe_text(value: Any, keep_newlines: bool = False) -> str:
    if value is None:
        return ""
    text = str(value)
    if not keep_newlines:
        text = text.strip()
    return text


def _strip_visibility(value: str) -> str:
    value = _safe_text(value)
    if value[:1] in {"+", "-", "#", "~"}:
        return value[1:].strip()
    return value


def _escape_display(value: str) -> str:
    text = _safe_text(value)
    # Preserve explicit newlines from note tags, escape real double quotes.
    text = text.replace('"', '\\"')
    return text


def _get_tag_value(tags: list[dict[str, Any]] | None, tag_name: str) -> str:
    for tag in tags or []:
        if tag.get("name") == tag_name:
            return _safe_text(tag.get("value"))
    return ""


def _get_center_label(connector: dict[str, Any]) -> str:
    for key in ("name", "label", "relation_name"):
        if connector.get(key):
            return _safe_text(connector.get(key))

    rt = _strip_visibility(connector.get("rt"))
    if rt:
        return rt

    label_en = _get_tag_value(connector.get("tags_target"), "label-en")
    if label_en:
        return label_en

    return ""


def _resolve_alias(
    ref_id: str,
    ref_name: str,
    id_to_alias: dict[str, str],
    name_to_aliases: dict[str, list[str]],
    endpoint_kind: str,
    debug: bool = False,
) -> str:
    if ref_id:
        alias = id_to_alias.get(ref_id)
        if alias:
            return alias
        if debug:
            print(f"[WARN] {endpoint_kind}_id introuvable: {ref_id} -> fallback sur le nom")

    matches = name_to_aliases.get(ref_name, [])

    if len(matches) == 1:
        return matches[0]

    if len(matches) > 1:
        chosen = matches[0]
        if debug:
            print(
                f"[WARN] {endpoint_kind}_name ambigu: '{ref_name}' "
                f"-> fallback sur le premier alias déclaré: {chosen}"
            )
        return chosen

    synthetic = f'{endpoint_kind}_missing_' + re.sub(r"[^A-Za-z0-9_]", "_", ref_name or "unknown")
    if debug:
        print(
            f"[WARN] {endpoint_kind}_name introuvable: '{ref_name}' "
            f"-> création d'un placeholder: {synthetic}"
        )
    return synthetic


def _simplify_model_for_visualisation(
    source_json: dict[str, list[dict[str, Any]]],
    max_classes: int = 150,
) -> dict[str, list[dict[str, Any]]]:
    """
    Simplify a large UML-like model so that PlantUML can render it reliably.

    - Drop packages (they add little value for ontology overviews).
    - Keep only uml:Class elements.
    - Limit the number of classes to max_classes by selecting the ones
      involved in the most relationships.
    - Keep only Generalization, Association and Dependency connectors whose
      both ends are in the kept class set.
    """
    elements = source_json.get("elements", [])
    connectors = source_json.get("connectors", [])

    class_elements = [e for e in elements if _safe_text(e.get("type")) == "uml:Class"]

    # Count how many connectors involve each class
    involved_count: dict[str, int] = defaultdict(int)
    for c in connectors:
        sid = _safe_text(c.get("source_id"))
        tid = _safe_text(c.get("target_id"))
        rel = _safe_text(c.get("relationship"))
        if rel not in {"Association", "Generalization", "Dependency"}:
            continue
        involved_count[sid] += 1
        involved_count[tid] += 1

    # Sort classes by involvement then by name for deterministic output
    class_elements.sort(key=lambda e: (-involved_count.get(_safe_text(e.get("ID")), 0), _safe_text(e.get("name"))))

    if len(class_elements) > max_classes:
        class_elements = class_elements[:max_classes]

    kept_ids = {_safe_text(e.get("ID")) for e in class_elements}

    kept_connectors = []
    for c in connectors:
        sid = _safe_text(c.get("source_id"))
        tid = _safe_text(c.get("target_id"))
        rel = _safe_text(c.get("relationship"))
        if rel not in {"Association", "Generalization", "Dependency"}:
            continue
        if sid in kept_ids and tid in kept_ids:
            kept_connectors.append(c)

    return {"elements": class_elements, "connectors": kept_connectors}


def get_image_bytes(
    source_json: dict[str, list[dict[str, Any]]],
    debug: bool = False,
    simplify_large_models: bool = True,
) -> BytesIO:
    if debug:
        print("SOURCE JSON:")
        print(json.dumps(source_json, indent=2, ensure_ascii=False))

    if simplify_large_models:
        # Heuristic: if there are more than ~120 classes the public/local PlantUML
        # servers often reject the request. Simplify before rendering.
        class_count = sum(1 for e in source_json.get("elements", []) if _safe_text(e.get("type")) == "uml:Class")
        if class_count > 120:
            source_json = _simplify_model_for_visualisation(source_json, max_classes=120)

    elements = source_json.get("elements", [])
    connectors = source_json.get("connectors", [])

    plantuml_lines: list[str] = []
    plantuml_lines.append("@startuml")
    plantuml_lines.append("left to right direction")
    plantuml_lines.append("hide empty members")

    id_to_alias: dict[str, str] = {}
    name_to_aliases: dict[str, list[str]] = defaultdict(list)

    for element in elements:
        element_id = _safe_text(element.get("ID"))
        element_name = _safe_text(element.get("name"))
        alias = _alias_from_id(element_id or element_name or f"elem_{len(id_to_alias)}")

        if element_id:
            id_to_alias[element_id] = alias
        if element_name:
            name_to_aliases[element_name].append(alias)

    def render_package(alias: str, element: dict[str, Any]) -> list[str]:
        display_name = _escape_display(_safe_text(element.get("name")))
        return [
            f'package "{display_name}" as {alias} {{',
            '}',
        ]

    def render_class(alias: str, element: dict[str, Any]) -> list[str]:
        note_text = _get_tag_value(element.get("tags"), "note")
        if note_text:
            # Render tagged explanatory elements as a floating PlantUML note.
            # Keep newlines because the note tag may contain intentional line breaks.
            # Use the PlantUML block syntax: "note as alias ... end note"
            lines: list[str] = [f'note as {alias}']
            for line in note_text.split("\n"):
                lines.append(f"  {_safe_text(line, keep_newlines=True)}")
            lines.append("end note")
            return lines

        display_name = _escape_display(_safe_text(element.get("name")))
        attributes = element.get("attributes", []) or []

        lines = [f'class "{display_name}" as {alias} {{']
        for attr in attributes:
            attr_name = _safe_text(attr.get("name"))
            attr_type = _safe_text(attr.get("type")) or "Any"
            lines.append(f"  {attr_name}: {attr_type}")
        lines.append("}")
        return lines

    def render_datatype(alias: str, element: dict[str, Any]) -> list[str]:
        display_name = _escape_display(_safe_text(element.get("name")))
        attributes = element.get("attributes", []) or []

        lines: list[str] = [f'class "<<dataType>>\\n{display_name}" as {alias} {{']
        for attr in attributes:
            attr_name = _safe_text(attr.get("name"))
            attr_type = _safe_text(attr.get("type")) or "Any"
            lines.append(f"  {attr_name}: {attr_type}")
        lines.append("}")
        return lines

    def render_enumeration(alias: str, element: dict[str, Any]) -> list[str]:
        display_name = _escape_display(_safe_text(element.get("name")))
        categories = element.get("categories", []) or []

        lines: list[str] = [f'enum "{display_name}" as {alias} {{']
        for cat in categories:
            lines.append(f"  {_safe_text(cat)}")
        lines.append("}")
        return lines

    plantuml_lines.append("together {")
    for element in elements:
        element_id = _safe_text(element.get("ID")) or _safe_text(element.get("name")) or f"elem_{len(id_to_alias)}"
        alias = id_to_alias.get(element_id)
        if not alias:
            alias = _alias_from_id(element_id)
            id_to_alias[element_id] = alias
        elem_type = _safe_text(element.get("type"))

        if elem_type == "uml:Package":
            plantuml_lines.extend(render_package(alias, element))
        elif elem_type == "uml:DataType":
            plantuml_lines.extend(render_datatype(alias, element))
        elif elem_type == "uml:Enumeration":
            plantuml_lines.extend(render_enumeration(alias, element))
        else:
            # Tout le reste est traité comme une classe (fallback robuste)
            plantuml_lines.extend(render_class(alias, element))
    plantuml_lines.append("}")

    placeholders: set[str] = set()

    for connector in connectors:
        source_id = _safe_text(connector.get("source_id"))
        target_id = _safe_text(connector.get("target_id"))
        source_name = _safe_text(connector.get("source_name"))
        target_name = _safe_text(connector.get("target_name"))
        relationship = _safe_text(connector.get("relationship"))

        # Notes / commentaires Enterprise Architect n'ont pas de sens en UML class diagram
        if relationship in {"NoteLink"}:
            continue

        source_alias = _resolve_alias(
            source_id, source_name, id_to_alias, name_to_aliases, "source", debug=debug
        ) if source_id or source_name else ""
        target_alias = _resolve_alias(
            target_id, target_name, id_to_alias, name_to_aliases, "target", debug=debug
        ) if target_id or target_name else ""

        if not source_alias or not target_alias:
            continue

        # PlantUML rejette une classe avec un nom vide. On ignore les placeholders
        # sans nom affichable ou on les nomme explicitement.
        if source_alias.startswith("source_missing_"):
            if not source_name:
                continue
            if source_alias not in placeholders:
                plantuml_lines.append(f'class "{_escape_display(source_name)}" as {source_alias}')
                placeholders.add(source_alias)

        if target_alias.startswith("target_missing_"):
            if not target_name:
                continue
            if target_alias not in placeholders:
                plantuml_lines.append(f'class "{_escape_display(target_name)}" as {target_alias}')
                placeholders.add(target_alias)

        left_card = _safe_text(connector.get("lb"))
        right_card = _safe_text(connector.get("rb"))

        center_label = _get_center_label(connector)

        if relationship == "Association":
            arrow = "--"
        elif relationship == "Generalization":
            arrow = "<|--"
        elif relationship == "Aggregation":
            arrow = "o--"
        elif relationship == "Composition":
            arrow = "*--"
        elif relationship == "Dependency":
            arrow = "..>"
        else:
            arrow = "--"

        left_txt = f' "{_escape_display(left_card)}"' if left_card else ""
        right_txt = f' "{_escape_display(right_card)}"' if right_card else ""
        center_txt = f" : {_escape_display(center_label)}" if center_label else ""

        plantuml_lines.append(
            f"{source_alias}{left_txt} {arrow}{right_txt} {target_alias}{center_txt}"
        )

    plantuml_lines.append("@enduml")
    plantuml_text = "\n".join(plantuml_lines)

    if debug:
        print("\nPLANTUML:")
        print(plantuml_text)

    # 1. Use the bundled native PlantUML binary first (no external dependency).
    # 2. Fall back to local PlantUML servers.
    # 3. Fall back to the public PlantUML server.
    # 4. Final fallback: a lightweight native SVG renderer.
    last_error = None

    # Try bundled native PlantUML binary first
    try:
        return _render_with_native_plantuml(plantuml_text)
    except Exception as native_error:
        last_error = native_error

    # Try network servers
    plantuml_servers = [
        "http://127.0.0.1:8080/svg/",
        "http://localhost:8080/svg/",
        "http://www.plantuml.com/plantuml/svg/",
    ]
    for server_url in plantuml_servers:
        try:
            server = PlantUML(url=server_url)
            image_bytes = server.processes(plantuml_text)
            return BytesIO(image_bytes)
        except Exception as e:
            last_error = e
            continue

    # Final fallback native SVG renderer (works fully offline).
    try:
        return _render_native_svg(elements, connectors)
    except Exception as fallback_error:
        raise RuntimeError(
            f"PlantUML rendering failed: {last_error}. Native SVG fallback also failed: {fallback_error}. "
            "Check that the native PlantUML binary is present in data_model_utils/native-plantuml-linux-amd64/ "
            "or that a PlantUML server is reachable at http://127.0.0.1:8080/svg/ or http://www.plantuml.com/plantuml/svg/"
        ) from last_error


def _render_with_native_plantuml(plantuml_text: str) -> BytesIO:
    """
    Invoke the bundled native PlantUML binary to convert PlantUML source to SVG.
    Requires the native-plantuml-linux-amd64 directory next to this module.
    """
    module_dir = Path(__file__).resolve().parent
    binary_dir = module_dir / "native-plantuml-linux-amd64"
    binary = binary_dir / "plantuml"

    if not binary.exists():
        raise FileNotFoundError(f"Native PlantUML binary not found: {binary}")

    if not os.access(binary, os.X_OK):
        binary.chmod(binary.stat().st_mode | 0o111)

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / "input.puml"
        output_path = Path(tmpdir) / "input.svg"
        input_path.write_text(plantuml_text, encoding="utf-8")

        env = os.environ.copy()
        env["LD_LIBRARY_PATH"] = str(binary_dir)

        cmd = [
            str(binary),
            "-tsvg",
            "-o", str(tmpdir),
            str(input_path),
        ]
        result = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if not output_path.exists():
            raise RuntimeError(
                f"Native PlantUML did not generate output.\nstdout: {result.stdout}\nstderr: {result.stderr}"
            )

        svg_bytes = output_path.read_bytes()
        if len(svg_bytes) < 100:
            raise RuntimeError("Native PlantUML generated an empty or invalid SVG")

        return BytesIO(svg_bytes)


def _render_native_svg(
    elements: list[dict[str, Any]],
    connectors: list[dict[str, Any]],
) -> BytesIO:
    """
    Render a lightweight native SVG class diagram when PlantUML servers are unreachable.
    Works entirely offline, only needs the Python standard library.
    """

    def escape_xml(text: str) -> str:
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

    # Gather classes/datatypes/enumerations; ignore packages for layout.
    nodes: list[dict[str, Any]] = []
    for element in elements:
        elem_type = _safe_text(element.get("type"))
        if elem_type == "uml:Package":
            continue
        nodes.append(element)

    # Limit to avoid huge diagrams
    max_nodes = 80
    if len(nodes) > max_nodes:
        nodes = nodes[:max_nodes]

    # Layout constants
    node_width = 220
    header_height = 34
    line_height = 20
    attr_limit = 8
    h_gap = 60
    v_gap = 60
    margin = 40

    # Compute each node's height
    for node in nodes:
        attrs = node.get("attributes", []) or []
        categories = node.get("categories", []) or []
        rows: list[str] = []
        elem_type = _safe_text(node.get("type"))
        if elem_type == "uml:Enumeration":
            rows = [escape_xml(_safe_text(c)) for c in categories[:attr_limit]]
        else:
            rows = [f"{escape_xml(_safe_text(a.get('name')))}: {escape_xml(_safe_text(a.get('type')) or 'Any')}"
                    for a in attrs[:attr_limit]]
        if (attrs and len(attrs) > attr_limit) or (categories and len(categories) > attr_limit):
            rows.append("...")
        node["_rows"] = rows
        node["_height"] = max(header_height + 10, header_height + len(rows) * line_height + 10)

    # Grid layout
    cols = max(1, int((len(nodes) ** 0.5) + 0.5))
    positions: dict[str, tuple[int, int, int, int]] = {}
    total_width = margin * 2 + cols * node_width + (cols - 1) * h_gap
    max_bottom = 0
    for i, node in enumerate(nodes):
        col = i % cols
        row = i // cols
        x = margin + col * (node_width + h_gap)
        y = margin + row * (max(header_height + 40, 160) + v_gap)
        # Align y with tallest node in previous column by recomputing later; keep simple grid
        node["_x"] = x
        node["_y"] = y
        positions[node.get("ID") or node.get("name") or f"node_{i}"] = (x, y, node_width, node["_height"])
        max_bottom = max(max_bottom, y + node["_height"])

    # Build alias map (same logic as PlantUML generator)
    id_to_alias: dict[str, str] = {}
    for i, node in enumerate(nodes):
        node_id = _safe_text(node.get("ID")) or _safe_text(node.get("name")) or f"node_{i}"
        id_to_alias[node_id] = _alias_from_id(node_id)

    # Connector targets/arrow styles
    def arrow_marker(rel: str) -> tuple[str, str, str]:
        rel = rel.lower()
        if rel == "generalization":
            return "triangle", "#111827", "#111827"
        if rel == "dependency":
            return "open", "#111827", "#111827"
        if rel == "aggregation":
            return "diamond", "#ffffff", "#111827"
        if rel == "composition":
            return "diamond", "#111827", "#111827"
        return "none", "#111827", "#111827"

    svg_parts: list[str] = []
    svg_parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_width}" height="{max_bottom + margin}" style="background:#f8fafc">')
    svg_parts.append('<defs>')
    svg_parts.append('  <marker id="arrow-none" markerWidth="10" markerHeight="10" refX="20" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,10" stroke="#111827" fill="none"/></marker>')
    svg_parts.append('  <marker id="arrow-triangle" markerWidth="12" markerHeight="12" refX="11" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L12,6 L0,12 Z" fill="#111827" stroke="#111827"/></marker>')
    svg_parts.append('  <marker id="arrow-open" markerWidth="12" markerHeight="12" refX="11" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L12,6 L0,12" fill="none" stroke="#111827"/></marker>')
    svg_parts.append('  <marker id="arrow-diamond" markerWidth="16" markerHeight="12" refX="15" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M0,6 L8,0 L16,6 L8,12 Z" fill="#ffffff" stroke="#111827" id="diamond-white"/></marker>')
    svg_parts.append('  <marker id="arrow-diamond-filled" markerWidth="16" markerHeight="12" refX="15" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M0,6 L8,0 L16,6 L8,12 Z" fill="#111827" stroke="#111827"/></marker>')
    svg_parts.append('</defs>')

    # Draw nodes
    for node in nodes:
        x, y, w, h = node["_x"], node["_y"], node_width, node["_height"]
        elem_type = _safe_text(node.get("type"))
        is_enum = elem_type == "uml:Enumeration"
        is_datatype = elem_type == "uml:DataType"

        # Box
        svg_parts.append(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="#ffffff" stroke="#111827" stroke-width="1.5"/>')
        # Header divider
        svg_parts.append(f'  <line x1="{x}" y1="{y + header_height}" x2="{x + w}" y2="{y + header_height}" stroke="#111827" stroke-width="1.5"/>')

        # Title
        title = _safe_text(node.get("name")) or "Unnamed"
        if is_enum:
            title = f"«enumeration»\n{title}"
        elif is_datatype:
            title = f"«dataType»\n{title}"
        title_y = y + 20
        if "\n" in title:
            title_y = y + 16
        svg_parts.append(f'  <text x="{x + w / 2}" y="{title_y}" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#111827">{escape_xml(title).replace(chr(10), "</text><text x=\"" + str(x + w / 2) + "\" y=\"" + str(title_y + 14) + "\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"12\" font-weight=\"bold\" fill=\"#111827\">")}</text>')

        # Rows
        for ri, row in enumerate(node["_rows"]):
            ry = y + header_height + 16 + ri * line_height
            svg_parts.append(f'  <text x="{x + 10}" y="{ry}" font-family="monospace" font-size="11" fill="#334155">{row}</text>')

    # Draw connectors
    for connector in connectors:
        source_id = _safe_text(connector.get("source_id"))
        target_id = _safe_text(connector.get("target_id"))
        source_name = _safe_text(connector.get("source_name"))
        target_name = _safe_text(connector.get("target_name"))

        source_alias = _resolve_alias(source_id, source_name, id_to_alias, {}, "source") if source_id or source_name else ""
        target_alias = _resolve_alias(target_id, target_name, id_to_alias, {}, "target") if target_id or target_name else ""

        if not source_alias or not target_alias:
            continue
        source_node = next((n for n in nodes if id_to_alias.get(_safe_text(n.get("ID")) or _safe_text(n.get("name"))) == source_alias), None)
        target_node = next((n for n in nodes if id_to_alias.get(_safe_text(n.get("ID")) or _safe_text(n.get("name"))) == target_alias), None)
        if source_node is None or target_node is None:
            continue

        sx = source_node["_x"] + node_width / 2
        sy = source_node["_y"] + source_node["_height"] / 2
        tx = target_node["_x"] + node_width / 2
        ty = target_node["_y"] + target_node["_height"] / 2

        relationship = _safe_text(connector.get("relationship"))
        marker, fill, stroke = arrow_marker(relationship)
        marker_attr = f' marker-end="url(#arrow-{marker})"' if marker != "none" else ""

        # Simple straight line; for grid layout this is usually readable enough
        svg_parts.append(f'  <line x1="{sx}" y1="{sy}" x2="{tx}" y2="{ty}" stroke="#64748b" stroke-width="1.2"{marker_attr}/>')

        label = _get_center_label(connector)
        if label:
            mx = (sx + tx) / 2
            my = (sy + ty) / 2
            svg_parts.append(f'  <rect x="{mx - 2}" y="{my - 9}" width="{len(label) * 6 + 6}" height="14" fill="#f8fafc" opacity="0.9"/>')
            svg_parts.append(f'  <text x="{mx}" y="{my + 3}" font-family="sans-serif" font-size="9" fill="#334155" text-anchor="middle">{escape_xml(label)}</text>')

        # Cardinality labels
        left_card = _safe_text(connector.get("lb"))
        right_card = _safe_text(connector.get("rb"))
        if left_card:
            lx = sx + (tx - sx) * 0.15
            ly = sy + (ty - sy) * 0.15 - 5
            svg_parts.append(f'  <text x="{lx}" y="{ly}" font-family="sans-serif" font-size="9" fill="#64748b" text-anchor="middle">{escape_xml(left_card)}</text>')
        if right_card:
            rx = sx + (tx - sx) * 0.85
            ry = sy + (ty - sy) * 0.85 - 5
            svg_parts.append(f'  <text x="{rx}" y="{ry}" font-family="sans-serif" font-size="9" fill="#64748b" text-anchor="middle">{escape_xml(right_card)}</text>')

    svg_parts.append('</svg>')
    return BytesIO("\n".join(svg_parts).encode("utf-8"))
