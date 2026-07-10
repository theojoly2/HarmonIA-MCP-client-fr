from __future__ import annotations

from typing import Any
from io import BytesIO
import json
import re
import uuid
from collections import defaultdict

"""
import_json.py
Convertit des fichiers JSON / JSON-LD / JSON Schema / Table Schema frictionless
en un modèle UML-compatible (éléments + connecteurs) pour visualisation PlantUML.
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _clean_name(name: str) -> str:
    """Nettoie un nom pour l'affichage UML."""
    s = _safe_text(name)
    s = re.sub(r"[<>:\\\"\{\}]", " ", s)
    return s.strip() or "Unnamed"


def _make_id(prefix: str, seed: str) -> str:
    """Génère un ID stable à partir d'une graine."""
    u = uuid.uuid5(uuid.NAMESPACE_URL, str(seed))
    s = str(u).replace("-", "_").upper()
    return f"{prefix}_{s[:24]}"


def _type_from_json_schema(prop_def: dict[str, Any]) -> str:
    """Infère un type UML simple depuis une définition JSON Schema."""
    if not isinstance(prop_def, dict):
        return "Any"
    t = prop_def.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), t[0] if t else None)
    fmt = prop_def.get("format", "")
    if t == "string":
        if fmt in ("date", "date-time"):
            return "DateTime"
        if fmt == "uri":
            return "URI"
        return "String"
    if t == "integer":
        return "Integer"
    if t == "number":
        return "Real"
    if t == "boolean":
        return "Boolean"
    if t == "array":
        return "List"
    if t == "object":
        return "Object"
    if "$ref" in prop_def:
        return "Ref"
    return "Any"


def _is_json_ld(data: dict[str, Any]) -> bool:
    return isinstance(data, dict) and "@context" in data


def _is_json_schema(data: dict[str, Any]) -> bool:
    return isinstance(data, dict) and ("$schema" in data or "properties" in data or "allOf" in data)


def _is_frictionless_table_schema(data: dict[str, Any]) -> bool:
    return isinstance(data, dict) and "fields" in data and isinstance(data.get("fields"), list)


def _expand_prefixed(value: Any, context: dict[str, str]) -> str:
    """Expand a prefixed name like schema:Person using the @context mapping."""
    if not isinstance(value, str):
        return ""
    s = value
    if ":" in s and not s.startswith(("http://", "https://")):
        prefix, local = s.split(":", 1)
        if prefix in context:
            base = context[prefix]
            if base.endswith("/") or base.endswith("#"):
                s = f"{base}{local}"
            else:
                s = f"{base}/{local}"
    return s


def _is_class_type(atype: Any, context: dict[str, str]) -> bool:
    """Return True if atype denotes an RDFS/OWL/SKOS class."""
    expanded = _expand_prefixed(atype, context)
    return str(expanded).endswith("Class") or str(expanded) == str(RDFS_CLASS) or str(expanded) == str(OWL_CLASS)


def _is_property_type(atype: Any, context: dict[str, str]) -> bool:
    """Return True if atype denotes an RDF/OWL/Schema property."""
    expanded = _expand_prefixed(atype, context)
    return str(expanded).endswith("Property") or expanded in _PROPERTY_URIS


RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class"
OWL_CLASS = "http://www.w3.org/2002/07/owl#Class"
RDF_PROPERTY = "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property"
_PROPERTY_URIS = {
    RDF_PROPERTY,
    "http://www.w3.org/2002/07/owl#ObjectProperty",
    "http://www.w3.org/2002/07/owl#DatatypeProperty",
    "http://www.w3.org/2002/07/owl#AnnotationProperty",
    "https://schema.org/Property",
    "http://schema.org/Property",
}

# Schema.org primitive datatypes that should become attributes instead of associations
_SCHEMA_PRIMITIVE_TYPES = {
    "Text": "String",
    "URL": "String",
    "Date": "DateTime",
    "DateTime": "DateTime",
    "Time": "DateTime",
    "Number": "Real",
    "Integer": "Integer",
    "Float": "Real",
    "Double": "Real",
    "Boolean": "Boolean",
}


def _jsonld_label(item: dict[str, Any], fallback: str) -> str:
    label = item.get("rdfs:label") or item.get("label") or item.get("rdfs:comment") or item.get("comment") or fallback
    if isinstance(label, dict):
        label = label.get("@value") or label.get("value") or fallback
    if isinstance(label, list) and label:
        label = label[0]
        if isinstance(label, dict):
            label = label.get("@value") or label.get("value") or fallback
    return _safe_text(label or fallback)


def _ensure_class(model: dict[str, Any], name: str, uri: str | None = None) -> dict[str, Any]:
    """Crée ou récupère une classe dans le modèle."""
    key = _make_id("EAID", uri or name)
    existing = next((e for e in model["elements"] if e.get("ID") == key), None)
    if existing:
        return existing
    cls = {
        "name": _clean_name(name),
        "ID": key,
        "uri": uri,
        "type": "uml:Class",
        "visibility": "public",
        "package": "",
        "tags": [{"name": "uri", "value": uri}] if uri else [],
        "attributes": [],
    }
    model["elements"].append(cls)
    return cls


def _add_attribute(cls: dict[str, Any], name: str, attr_type: str, description: str = "") -> None:
    if not name:
        return
    cls["attributes"].append({
        "name": _clean_name(name),
        "visibility": "public",
        "type": _clean_name(attr_type),
        "uri": None,
        "lower_bounds": "",
        "upper_bounds": "",
        "tags_attribute": [{"name": "description", "value": description}] if description else [],
    })


def _add_connector(
    model: dict[str, Any],
    source_cls: dict[str, Any],
    target_cls: dict[str, Any],
    name: str,
    relationship: str = "Association",
    lb: str = "",
    rb: str = "",
) -> None:
    if source_cls is None or target_cls is None:
        return
    conn_id = _make_id("CONN", f"{source_cls['ID']}:{target_cls['ID']}:{name}")
    model["connectors"].append({
        "connector_id": conn_id,
        "source_id": source_cls["ID"],
        "target_id": target_cls["ID"],
        "source_name": source_cls["name"],
        "target_name": target_cls["name"],
        "relationship": relationship,
        "name": _clean_name(name),
        "uri": None,
        "lb": lb,
        "lt": "",
        "rb": rb,
        "rt": "",
        "tags": [{"name": "connector_id", "value": conn_id}],
        "tags_source": [],
        "tags_target": [],
    })


def _normalize_uri_or_name(ref: Any, context: dict[str, str] | None = None) -> str:
    """Extrait un nom lisible depuis un @id, un $ref ou une clé."""
    if isinstance(ref, str):
        s = ref
    elif isinstance(ref, dict):
        s = ref.get("@id") or ref.get("$ref") or ref.get("name") or ""
    else:
        return ""
    if not s:
        return ""
    # Résoudre les préfixes JSON-LD (schema:Person -> https://schema.org/Person)
    if context and ":" in s:
        prefix, local = s.split(":", 1)
        if prefix in context:
            resolved = context[prefix]
            if resolved.endswith("/") or resolved.endswith("#"):
                s = f"{resolved}{local}"
            else:
                s = f"{resolved}/{local}"
    if "#" in s:
        return s.split("#")[-1]
    if "/" in s:
        return s.rstrip("/").split("/")[-1]
    return s


# ---------------------------------------------------------------------------
# JSON-LD / schema.org parser
# ---------------------------------------------------------------------------

def _parse_json_ld(data: dict[str, Any]) -> dict[str, Any]:
    """Parse un JSON-LD de type schema.org/SKOS (liste ou objet unique)."""
    model: dict[str, Any] = {"elements": [], "connectors": []}

    root_pkg_id = _make_id("EAPK", "jsonld_root")
    model["elements"].append({
        "name": "JSON-LD Model",
        "ID": root_pkg_id,
        "uri": None,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [],
    })

    context: dict[str, str] = {}
    if isinstance(data.get("@context"), dict):
        context = {k: str(v).rstrip("#/") for k, v in data["@context"].items()}

    items = data if isinstance(data, list) else [data]

    # Indexe toutes les classes d'abord
    class_by_name: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        atype = item.get("@type")
        if isinstance(atype, list):
            atype = next((x for x in atype if _is_class_type(x, context)), atype[0])
        if _is_class_type(atype, context):
            name = _normalize_uri_or_name(item.get("@id"), context)
            label = _jsonld_label(item, name)
            uri = item.get("@id")
            cls = {
                "name": _clean_name(label or name),
                "ID": _make_id("EAID", uri or name),
                "uri": uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": root_pkg_id,
                "tags": [{"name": "uri", "value": uri}] if uri else [],
                "attributes": [],
            }
            model["elements"].append(cls)
            class_by_name[cls["name"]] = cls
            class_by_name[uri] = cls

    # Set package on all classes (existing and future)
    def _ensure_class_in_pkg(name: str, uri: str | None = None, external: bool = False) -> dict[str, Any]:
        u = _expand_prefixed(uri or name, context)
        display = _normalize_uri_or_name(name, context)
        key = _make_id("EAID", u or display)
        existing = next((e for e in model["elements"] if e.get("ID") == key), None)
        if existing:
            existing.setdefault("package", root_pkg_id)
            return existing
        cls = {
            "name": _clean_name(display),
            "ID": key,
            "uri": uri,
            "type": "uml:Class",
            "visibility": "public",
            "package": root_pkg_id,
            "tags": [{"name": "uri", "value": uri}] if uri else ([{"name": "uri", "value": u}] if u else []),
            "attributes": [],
        }
        if external:
            cls["tags"].append({"name": "external", "value": "true"})
        model["elements"].append(cls)
        return cls

    # Gère les propriétés et héritages
    for item in items:
        if not isinstance(item, dict):
            continue
        atype = item.get("@type")
        if isinstance(atype, list):
            atype = atype[0]
        if _is_property_type(atype, context):
            name = _normalize_uri_or_name(item.get("@id"), context)
            prop_name = _clean_name(_jsonld_label(item, name))

            domains = item.get("schema:domainIncludes") or item.get("rdfs:domain") or []
            ranges = item.get("schema:rangeIncludes") or item.get("rdfs:range") or []
            if isinstance(domains, dict):
                domains = [domains]
            if isinstance(ranges, dict):
                ranges = [ranges]

            for d in domains:
                d_name = _normalize_uri_or_name(d, context)
                source_cls = class_by_name.get(d_name)
                if source_cls is None:
                    source_cls = _ensure_class_in_pkg(d_name, _expand_prefixed(d, context) if isinstance(d, str) else None, external=True)
                for r in ranges:
                    r_name = _normalize_uri_or_name(r, context)
                    r_expanded = _expand_prefixed(r, context) if isinstance(r, str) else None
                    # Primitive schema.org types => attribute instead of association
                    if r_name and r_name in _SCHEMA_PRIMITIVE_TYPES:
                        attr_type = _SCHEMA_PRIMITIVE_TYPES[r_name]
                        _add_attribute(source_cls, prop_name, attr_type, _jsonld_label(item, ""))
                        continue
                    target_cls = class_by_name.get(r_name)
                    if target_cls is None:
                        target_cls = _ensure_class_in_pkg(r_name, r_expanded, external=True)
                    _add_connector(model, source_cls, target_cls, prop_name)

        elif _is_class_type(atype, context):
            # rdfs:subClassOf
            parent = item.get("rdfs:subClassOf") or item.get("subClassOf")
            if parent:
                name = _normalize_uri_or_name(item.get("@id"), context)
                child_cls = class_by_name.get(name)
                p_name = _normalize_uri_or_name(parent, context)
                parent_cls = class_by_name.get(p_name)
                if parent_cls is None:
                    parent_cls = _ensure_class_in_pkg(p_name, _expand_prefixed(parent, context), external=True)
                if child_cls and parent_cls:
                    _add_connector(model, child_cls, parent_cls, "subClassOf", "Generalization")

    # Ensure every class sits in the root package
    for elem in model["elements"]:
        if elem.get("type") == "uml:Class" and not elem.get("package"):
            elem["package"] = root_pkg_id

    return model


# ---------------------------------------------------------------------------
# JSON Schema parser
# ---------------------------------------------------------------------------

def _collect_all_of_schema(data: dict[str, Any]) -> dict[str, Any]:
    """Fusionne récursivement les blocs allOf en un seul schéma."""
    out: dict[str, Any] = {"properties": {}, "required": []}
    if isinstance(data.get("allOf"), list):
        for sub in data["allOf"]:
            merged = _collect_all_of_schema(sub)
            out["properties"].update(merged.get("properties", {}))
            out["required"].extend(merged.get("required", []))
    if isinstance(data.get("properties"), dict):
        out["properties"].update(data["properties"])
        out["required"].extend(data.get("required", []))
    return out


def _json_schema_to_model(data: dict[str, Any], default_name: str = "Schema") -> dict[str, Any]:
    """Convertit un JSON Schema en modèle UML."""
    model: dict[str, Any] = {"elements": [], "connectors": []}

    root_name = _clean_name(data.get("title") or data.get("name") or default_name)
    root_id = _make_id("EAID", root_name)
    root_pkg_id = _make_id("EAPK", f"pkg:{root_name}")

    model["elements"].append({
        "name": root_name,
        "ID": root_pkg_id,
        "uri": data.get("$id"),
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [{"name": "description", "value": _safe_text(data.get("description"))}] if data.get("description") else [],
    })

    merged = _collect_all_of_schema(data)
    root_cls = {
        "name": root_name,
        "ID": root_id,
        "uri": data.get("$id"),
        "type": "uml:Class",
        "visibility": "public",
        "package": root_pkg_id,
        "tags": [{"name": "description", "value": _safe_text(data.get("description"))}] if data.get("description") else [],
        "attributes": [],
    }
    model["elements"].append(root_cls)

    _parse_schema_object(model, root_cls, merged.get("properties", {}), root_pkg_id, root_name)

    # Gère les définitions / $defs
    for key in ("definitions", "$defs"):
        defs = data.get(key, {})
        if isinstance(defs, dict):
            for name, sub_schema in defs.items():
                _parse_schema_object(model, None, {name: sub_schema}, root_pkg_id, name)

    return model


def _parse_schema_object(
    model: dict[str, Any],
    parent_cls: dict[str, Any] | None,
    properties: dict[str, Any],
    pkg_id: str,
    parent_name: str,
) -> None:
    """Parse un objet JSON Schema en classe/attributs/associations."""
    for prop_name, prop_def in properties.items():
        if not isinstance(prop_def, dict):
            continue
        prop_type = _type_from_json_schema(prop_def)

        # Objet complexe => classe séparée + association
        if prop_def.get("type") == "object" and "properties" in prop_def:
            nested_name = _clean_name(prop_name)
            nested_id = _make_id("EAID", f"{parent_name}.{prop_name}")
            nested_cls = {
                "name": nested_name,
                "ID": nested_id,
                "uri": None,
                "type": "uml:Class",
                "visibility": "public",
                "package": pkg_id,
                "tags": [],
                "attributes": [],
            }
            model["elements"].append(nested_cls)
            _parse_schema_object(model, nested_cls, prop_def["properties"], pkg_id, f"{parent_name}.{prop_name}")
            if parent_cls:
                _add_connector(model, parent_cls, nested_cls, prop_name, lb="1", rb="1")
            continue

        # Array d'objets => classe séparée + association *
        if prop_def.get("type") == "array" and isinstance(prop_def.get("items"), dict):
            items = prop_def["items"]
            if items.get("type") == "object" and "properties" in items:
                nested_name = _clean_name(prop_name)
                nested_id = _make_id("EAID", f"{parent_name}.{prop_name}")
                nested_cls = {
                    "name": nested_name,
                    "ID": nested_id,
                    "uri": None,
                    "type": "uml:Class",
                    "visibility": "public",
                    "package": pkg_id,
                    "tags": [],
                    "attributes": [],
                }
                model["elements"].append(nested_cls)
                _parse_schema_object(model, nested_cls, items["properties"], pkg_id, f"{parent_name}.{prop_name}")
                if parent_cls:
                    _add_connector(model, parent_cls, nested_cls, prop_name, lb="0..1", rb="*")
                continue
            if "$ref" in items:
                target_name = _normalize_uri_or_name(items["$ref"])
                target_cls = _ensure_class(model, target_name)
                if parent_cls:
                    _add_connector(model, parent_cls, target_cls, prop_name, lb="0..1", rb="*")
                continue

        # $ref simple
        if "$ref" in prop_def:
            target_name = _normalize_uri_or_name(prop_def["$ref"])
            target_cls = _ensure_class(model, target_name)
            if parent_cls:
                _add_connector(model, parent_cls, target_cls, prop_name)
            continue

        # Enum => énumération
        if "enum" in prop_def and prop_def["enum"]:
            enum_name = _clean_name(f"{parent_name}_{prop_name}")
            enum_id = _make_id("EAID", enum_name)
            enum_cls = {
                "name": enum_name,
                "ID": enum_id,
                "uri": None,
                "type": "uml:Enumeration",
                "visibility": "public",
                "package": pkg_id,
                "categories": [str(x) for x in prop_def["enum"]],
                "tags": [],
            }
            model["elements"].append(enum_cls)
            if parent_cls:
                _add_connector(model, parent_cls, enum_cls, prop_name)
            continue

        # Attribut simple
        if parent_cls:
            _add_attribute(
                parent_cls,
                prop_name,
                prop_type,
                _safe_text(prop_def.get("description")),
            )


# ---------------------------------------------------------------------------
# Frictionless Table Schema parser
# ---------------------------------------------------------------------------

def _frictionless_to_model(data: dict[str, Any], default_name: str = "Table") -> dict[str, Any]:
    """Convertit un Table Schema frictionless en classe avec attributs."""
    model: dict[str, Any] = {"elements": [], "connectors": []}

    root_name = _clean_name(data.get("name") or data.get("title") or default_name)
    root_pkg_id = _make_id("EAPK", f"pkg:{root_name}")
    root_id = _make_id("EAID", root_name)

    model["elements"].append({
        "name": root_name,
        "ID": root_pkg_id,
        "uri": data.get("uri") or data.get("homepage"),
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [{"name": "description", "value": _safe_text(data.get("description"))}] if data.get("description") else [],
    })

    cls = {
        "name": root_name,
        "ID": root_id,
        "uri": data.get("uri") or data.get("homepage"),
        "type": "uml:Class",
        "visibility": "public",
        "package": root_pkg_id,
        "tags": [{"name": "description", "value": _safe_text(data.get("description"))}] if data.get("description") else [],
        "attributes": [],
    }
    model["elements"].append(cls)

    for field in data.get("fields", []):
        if not isinstance(field, dict):
            continue
        field_type = field.get("type", "string")
        if field_type == "integer":
            attr_type = "Integer"
        elif field_type == "number":
            attr_type = "Real"
        elif field_type == "boolean":
            attr_type = "Boolean"
        elif field_type in ("date", "datetime", "time"):
            attr_type = "DateTime"
        else:
            attr_type = "String"
        _add_attribute(
            cls,
            field.get("name") or field.get("title"),
            attr_type,
            _safe_text(field.get("description")),
        )

    return model


# ---------------------------------------------------------------------------
# Generic JSON (FIWARE / Smart Data Models) parser
# ---------------------------------------------------------------------------

def _smart_data_model_to_model(data: dict[str, Any], default_name: str = "Model") -> dict[str, Any]:
    """Convertit un Smart Data Model FIWARE (JSON Schema-like) en modèle UML."""
    # Ces modèles sont en fait des JSON Schemas enrichis
    return _json_schema_to_model(data, default_name=default_name)


def _generic_json_to_model(data: Any, default_name: str = "JSON") -> dict[str, Any]:
    """Fallback pour tout autre JSON : arborescence de classes/clés."""
    model: dict[str, Any] = {"elements": [], "connectors": []}

    root_pkg_id = _make_id("EAPK", f"pkg:{default_name}")
    root_id = _make_id("EAID", default_name)
    model["elements"].append({
        "name": default_name,
        "ID": root_pkg_id,
        "uri": None,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [],
    })

    def _walk(obj: Any, parent_cls: dict[str, Any] | None, parent_name: str) -> None:
        if isinstance(obj, dict):
            cls = parent_cls if parent_cls else _ensure_class(model, parent_name)
            if not parent_cls:
                cls["package"] = root_pkg_id
            for k, v in obj.items():
                if isinstance(v, dict):
                    nested_name = _clean_name(k)
                    nested_cls = _ensure_class(model, f"{parent_name}.{k}")
                    nested_cls["package"] = root_pkg_id
                    model["elements"].append(nested_cls) if nested_cls not in model["elements"] else None
                    _add_connector(model, cls, nested_cls, k)
                    _walk(v, nested_cls, f"{parent_name}.{k}")
                elif isinstance(v, list) and v and isinstance(v[0], dict):
                    nested_name = _clean_name(k)
                    nested_cls = _ensure_class(model, f"{parent_name}.{k}")
                    nested_cls["package"] = root_pkg_id
                    _add_connector(model, cls, nested_cls, k, lb="0..1", rb="*")
                    _walk(v[0], nested_cls, f"{parent_name}.{k}")
                else:
                    _add_attribute(cls, k, type(v).__name__ if v is not None else "Any")
        elif isinstance(obj, list):
            if obj and isinstance(obj[0], dict):
                _walk(obj[0], parent_cls, parent_name)

    _walk(data, None, default_name)

    # Supprime les doublons introduits par _ensure_class
    seen_ids: set[str] = set()
    unique_elements = []
    for e in model["elements"]:
        eid = e.get("ID")
        if eid and eid in seen_ids:
            continue
        seen_ids.add(eid)
        unique_elements.append(e)
    model["elements"] = unique_elements

    return model


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def json_to_json(data: dict[str, Any] | list[Any], filename: str = "document.json") -> dict[str, Any]:
    """
    Convertit n'importe quel document JSON/JSON-LD en modèle UML-compatible.
    Retourne un dict avec la clé 'xmi' contenant elements + connectors.
    """
    base_name = re.sub(r"\.[^.]+$", "", filename)

    if isinstance(data, list) and all(isinstance(x, dict) for x in data):
        # Peut être une liste JSON-LD
        if any("@context" in x or "@id" in x or "@type" in x for x in data):
            model = _parse_json_ld(data)
        else:
            model = _generic_json_to_model(data, default_name=base_name)
    elif isinstance(data, dict):
        if _is_json_ld(data):
            model = _parse_json_ld(data)
        elif _is_frictionless_table_schema(data):
            model = _frictionless_to_model(data, default_name=base_name)
        elif _is_json_schema(data):
            model = _json_schema_to_model(data, default_name=base_name)
        else:
            model = _generic_json_to_model(data, default_name=base_name)
    else:
        model = {"elements": [], "connectors": []}

    return {
        "xmi": model,
        "source_format": "json",
        "json_raw": json.dumps(data, ensure_ascii=False, indent=2),
    }


def json_file_to_model(uploaded_file: BytesIO, filename: str = "document.json") -> dict[str, Any]:
    """
    Lit un fichier JSON/JSON-LD depuis un BytesIO et retourne le modèle UML.
    """
    uploaded_file.seek(0)
    text = uploaded_file.read().decode("utf-8", errors="replace")
    data = json.loads(text)
    return json_to_json(data, filename=filename)
