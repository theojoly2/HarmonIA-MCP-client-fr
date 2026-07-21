from __future__ import annotations

from typing import Any
from io import BytesIO
import re

"""
import_sql.py
Parseur minimaliste de DDL SQL pour extraire un modèle UML (tables, colonnes,
clés primaires, clés étrangères) depuis des fichiers .sql.
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _clean_name(name: str) -> str:
    s = _safe_text(name).strip("[]\"'`")
    s = re.sub(r"[\s\{\}<>:\\\"]", " ", s)
    return s.strip() or "Unnamed"


def _make_id(prefix: str, seed: str) -> str:
    import uuid
    u = uuid.uuid5(uuid.NAMESPACE_URL, str(seed))
    s = str(u).replace("-", "_").upper()
    return f"{prefix}_{s[:24]}"


def _sql_type_to_uml(sql_type: str) -> str:
    t = sql_type.lower()
    if "char" in t or "text" in t or "varchar" in t or "json" in t or "uuid" in t:
        return "String"
    if "int" in t or "serial" in t:
        return "Integer"
    if "bool" in t:
        return "Boolean"
    if "float" in t or "double" in t or "real" in t or "numeric" in t or "decimal" in t:
        return "Real"
    if "date" in t or "time" in t:
        return "DateTime"
    return "String"


def _extract_table_blocks(sql: str) -> list[dict[str, Any]]:
    """Découpe le SQL en blocs CREATE TABLE."""
    blocks: list[dict[str, Any]] = []

    # Supprime les commentaires de ligne et blocs
    sql = re.sub(r"--.*?\n", "\n", sql)
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)

    pattern = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w\.\"\[\]`]+)\s*\((.*?)\)\s*;",
        re.IGNORECASE | re.DOTALL,
    )

    for match in pattern.finditer(sql):
        table_name = _clean_name(match.group(1))
        body = match.group(2)
        blocks.append({"table": table_name, "body": body})

    return blocks


def _parse_table_body(table_name: str, body: str) -> dict[str, Any]:
    """Parse le corps d'un CREATE TABLE."""
    table_id = _make_id("EAID", f"table:{table_name}")
    cls = {
        "name": table_name,
        "ID": table_id,
        "uri": None,
        "type": "uml:Class",
        "visibility": "public",
        "package": "",
        "tags": [],
        "attributes": [],
    }

    pk_columns: set[str] = set()
    fks: list[dict[str, Any]] = []

    # Découpe en lignes en gérant les parenthèses imbriquées approximativement
    lines: list[str] = []
    current = ""
    depth = 0
    for char in body:
        if char == "(":
            depth += 1
            current += char
        elif char == ")":
            depth -= 1
            current += char
        elif char == "," and depth == 0:
            lines.append(current.strip())
            current = ""
        else:
            current += char
    if current.strip():
        lines.append(current.strip())

    for line in lines:
        line = line.strip()
        if not line:
            continue

        upper = line.upper()

        # PRIMARY KEY inline
        pk_match = re.match(r"CONSTRAINT\s+[\w\"\[\]`]+\s+PRIMARY\s+KEY\s*\(([^)]+)\)", line, re.IGNORECASE)
        if pk_match:
            for col in pk_match.group(1).split(","):
                pk_columns.add(_clean_name(col))
            continue

        inline_pk = re.match(r"([\w\"\[\]`]+)\s+[^,]*PRIMARY\s+KEY", line, re.IGNORECASE)
        if inline_pk:
            pk_columns.add(_clean_name(inline_pk.group(1)))
            continue

        # FOREIGN KEY
        fk_match = re.match(
            r"CONSTRAINT\s+[\w\"\[\]`]+\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([\w\.\"\[\]`]+)\s*(?:\(([^)]+)\))?",
            line,
            re.IGNORECASE,
        )
        if fk_match:
            local_cols = [_clean_name(c) for c in fk_match.group(1).split(",")]
            ref_table = _clean_name(fk_match.group(2))
            ref_cols = [_clean_name(c) for c in fk_match.group(3).split(",")] if fk_match.group(3) else []
            fks.append({
                "local": local_cols[0] if local_cols else "",
                "ref_table": ref_table,
                "ref_col": ref_cols[0] if ref_cols else "id",
            })
            continue

        # Colonne normale
        col_match = re.match(r"([\w\"\[\]`]+)\s+([\w\(\),\s]+)(?:\s+.*)?$", line)
        if col_match:
            col_name = _clean_name(col_match.group(1))
            col_type = col_match.group(2).strip()
            # Ignore les mots-clés réservés commençant une ligne sans nom de colonne
            if col_name.upper() in ("CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"):
                continue
            cls["attributes"].append({
                "name": col_name,
                "visibility": "public",
                "type": _sql_type_to_uml(col_type),
                "uri": None,
                "lower_bounds": "",
                "upper_bounds": "",
                "tags_attribute": [],
            })
            # inline REFERENCES
            if "REFERENCES" in upper:
                ref_match = re.search(r"REFERENCES\s+([\w\.\"\[\]`]+)", line, re.IGNORECASE)
                if ref_match:
                    fks.append({
                        "local": col_name,
                        "ref_table": _clean_name(ref_match.group(1)),
                        "ref_col": "id",
                    })

    return {
        "class": cls,
        "pk_columns": pk_columns,
        "fks": fks,
    }


def sql_to_model(uploaded_file: BytesIO, filename: str = "document.sql") -> dict[str, Any]:
    """
    Parse un fichier SQL DDL et retourne un modèle UML-compatible.
    """
    uploaded_file.seek(0)
    sql = uploaded_file.read().decode("utf-8", errors="replace")

    blocks = _extract_table_blocks(sql)

    model: dict[str, Any] = {"elements": [], "connectors": []}
    pkg_id = _make_id("EAPK", f"pkg:{filename}")
    model["elements"].append({
        "name": re.sub(r"\.[^.]+$", "", filename),
        "ID": pkg_id,
        "uri": None,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [],
    })

    table_by_name: dict[str, dict[str, Any]] = {}

    for block in blocks:
        parsed = _parse_table_body(block["table"], block["body"])
        cls = parsed["class"]
        cls["package"] = pkg_id
        pk_cols = parsed["pk_columns"]

        # Marque les PK dans les tags
        for attr in cls["attributes"]:
            if attr["name"] in pk_cols:
                attr["tags_attribute"].append({"name": "isPrimaryKey", "value": "true"})
                attr["type"] = "PK"

        model["elements"].append(cls)
        table_by_name[cls["name"]] = cls
        table_by_name[block["table"]] = cls

    # Connecteurs FK
    for block in blocks:
        parsed = _parse_table_body(block["table"], block["body"])
        source_cls = table_by_name.get(block["table"])
        if not source_cls:
            continue
        for fk in parsed["fks"]:
            target_cls = table_by_name.get(fk["ref_table"])
            if not target_cls:
                target_cls = {
                    "name": fk["ref_table"],
                    "ID": _make_id("EAID", f"table:{fk['ref_table']}"),
                    "uri": None,
                    "type": "uml:Class",
                    "visibility": "public",
                    "package": pkg_id,
                    "tags": [],
                    "attributes": [],
                }
                table_by_name[fk["ref_table"]] = target_cls
                model["elements"].append(target_cls)
            conn_id = _make_id("CONN", f"{source_cls['ID']}:{target_cls['ID']}:{fk['local']}")
            model["connectors"].append({
                "connector_id": conn_id,
                "source_id": source_cls["ID"],
                "target_id": target_cls["ID"],
                "source_name": source_cls["name"],
                "target_name": target_cls["name"],
                "relationship": "Association",
                "name": _clean_name(fk["local"]),
                "uri": None,
                "lb": "*",
                "lt": "",
                "rb": "1",
                "rt": "",
                "tags": [{"name": "connector_id", "value": conn_id}],
                "tags_source": [],
                "tags_target": [],
            })

    return {
        "xmi": model,
        "source_format": "sql",
        "sql_raw": sql,
    }
