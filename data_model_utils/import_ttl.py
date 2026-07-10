from __future__ import annotations

from typing import Any
from io import BytesIO

import rdflib
import json
import re
import uuid

"""
ttl_to_uml_json.py
Convert an OWL/RDF ontology in Turtle (TTL) to an Enterprise Architect-like UML JSON.

- Classes (owl:Class)  -> elements of type "uml:Class"
- ObjectProperties     -> connectors of type "Association" (domain -> range)
- DatatypeProperties   -> attributes on the domain class
- rdfs:subClassOf      -> connectors of type "Generalization" (child -> parent)
- owl:Ontology         -> root Package (name from rdfs:label @en if present)

IDs are deterministic per URI (uuid5), prefixed EA-like: EAPK_ for packages, EAID_ for classes.
"""

from rdflib import Graph, Namespace, RDF, RDFS, OWL, XSD, URIRef, Literal, BNode

# Namespaces that often appear
SKOS = Namespace("http://www.w3.org/2004/02/skos/core#")
FOAF = Namespace("http://xmlns.com/foaf/0.1/")
UML_META = Namespace("urn:ai4semantics:uml:")

# Property types that should be treated as UML properties/attributes/connectors
PROPERTY_TYPE_URIS = {
    str(OWL.ObjectProperty),
    str(OWL.DatatypeProperty),
    str(OWL.AnnotationProperty),
    str(OWL.FunctionalProperty),
    str(OWL.InverseFunctionalProperty),
    str(OWL.SymmetricProperty),
    str(OWL.TransitiveProperty),
    str(RDF.Property),
}

# Class-like types that should be treated as UML classes
CLASS_TYPE_URIS = {
    str(OWL.Class),
    str(RDFS.Class),
}

# Known non-class instance types to skip when building instance models
_NON_ONTOLOGY_INSTANCE_TYPES = {
    str(OWL.Ontology),
    str(OWL.Class),
    str(RDFS.Class),
    str(OWL.ObjectProperty),
    str(OWL.DatatypeProperty),
    str(OWL.AnnotationProperty),
    str(OWL.FunctionalProperty),
    str(OWL.InverseFunctionalProperty),
    str(OWL.SymmetricProperty),
    str(OWL.TransitiveProperty),
    str(RDF.Property),
    str(OWL.Restriction),
    str(OWL.NamedIndividual),
}


# ---------- Helpers ----------

def ea_id(prefix: str, uri: str) -> str:
    """
    EA-like deterministic ID from a URI: EAID/EAPK + UUID5 (underscored groups, uppercased).
    """
    u = uuid.uuid5(uuid.NAMESPACE_URL, str(uri))
    s = str(u).replace('-', '_').upper()
    return f"{prefix}_{s}"


def local_name(uri: URIRef) -> str:
    """
    Derive a human-friendly name from a URI: last segment after '/' or '#'.
    Falls back to the full URI if the local segment is empty.
    """
    s = str(uri)
    if '#' in s:
        local = s.split('#')[-1]
    else:
        local = s.rstrip('/').split('/')[-1]
    return local.strip() or s


def get_label(g: Graph, s: URIRef, lang: str = "en") -> str | None:
    vals = list(g.objects(s, RDFS.label))
    if not vals:
        return None
    # prefer requested language
    for v in vals:
        if isinstance(v, Literal) and v.language == lang:
            return str(v)
    # fallback to first literal/string
    return str(vals[0])


def get_comment(g: Graph, s: URIRef, lang: str = "en") -> str | None:
    vals = list(g.objects(s, RDFS.comment))
    if not vals:
        return None
    for v in vals:
        if isinstance(v, Literal) and v.language == lang:
            return str(v)
    return str(vals[0])


def get_literal_value(g: Graph, s: URIRef, p: URIRef) -> str | None:
    """Safely extract a raw string from a given triple property."""
    vals = list(g.objects(s, p))
    if not vals:
        return None
    return str(vals[0])


def primitive_from_range(r: URIRef) -> str | None:
    """
    Map RDF/XSD types to UML primitive names; None means treat as classifier name.
    Extend as needed.
    """
    s = str(r)
    if s in (str(RDFS.Literal), str(RDF.langString)):
        return "String"
    # Common XSD mappings
    xsd_map = {
        str(XSD.string): "String",
        str(XSD.boolean): "Boolean",
        str(XSD.integer): "Integer",
        str(XSD.int): "Integer",
        str(XSD.long): "Integer",
        str(XSD.float): "Real",
        str(XSD.double): "Real",
        str(XSD.decimal): "Real",
        str(XSD.date): "Date",
        str(XSD.dateTime): "DateTime",
        str(XSD.time): "Time",
        str(XSD.gYear): "String",       # could be a specialized type
        str(XSD.gYearMonth): "String",
        str(XSD.anyURI): "URI",
    }
    return xsd_map.get(s)


def role_name_from_label(label: str | None) -> str | None:
    """
    EA diagrams often show role names like '+isAbout'. We'll prefix with '+' if label exists.
    """
    if not label:
        return None
    return f"+{label}"


# ---------- Extraction ----------

def extract_ontology_package(g: Graph, custom_name: str | None = None) -> dict:
    # Identify owl:Ontology subject(s)
    ontos = list(g.subjects(RDF.type, OWL.Ontology))
    if ontos:
        onto = ontos[0]
        name = custom_name or get_label(g, onto, "en") or local_name(onto)
        pkg_uri = str(onto)
    else:
        # Fallback package when no owl:Ontology triple is present
        name = custom_name or "Generated"
        pkg_uri = f"urn:pkg:{name}"
    pkg_id = ea_id("EAPK", pkg_uri)
    return {
        "name": name,
        "ID": pkg_id,
        "uri": pkg_uri,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": []
    }


def _is_anonymous_uri(uri: str) -> bool:
    """Detect rdflib-generated names for anonymous blank nodes."""
    # rdflib uses skolem URIs like urn:skolem:...
    if uri.startswith("urn:skolem:"):
        return True
    # rdflib creates names starting with 'n' + hex chars for blank node skolemization.
    # Real URIs contain separators (/ # :); skolem IDs do not.
    if not any(sep in uri for sep in ("/", "#", ":")):
        if re.match(r"^n[a-f0-9]{8,}$", uri):
            return True
    return False


def _is_anonymous_ref(ref: URIRef | BNode) -> bool:
    """True if the RDF reference points to an anonymous blank node / skolem URI."""
    return isinstance(ref, BNode) or (isinstance(ref, URIRef) and _is_anonymous_uri(str(ref)))


def build_model(g: Graph, package_name: str | None = None) -> dict:
    model = {"elements": [], "connectors": []}

    # Root package
    root_pkg = extract_ontology_package(g, custom_name=package_name)
    model["elements"].append(root_pkg)
    root_pkg_id = root_pkg["ID"]

    # Index classes for quick lookup
    class_elems: dict[str, dict] = {}

    # 1) Classes (OWL.Class and RDFS.Class)
    for cls_type in (OWL.Class, RDFS.Class):
        for cls in g.subjects(RDF.type, cls_type):
            uri = str(cls)
            if uri in class_elems:
                continue
            # Skip anonymous OWL restrictions / blank nodes
            if _is_anonymous_ref(cls):
                continue
            name = get_label(g, cls, "en") or local_name(cls)
            cls_id = ea_id("EAID", uri)
            tags = [{"name": "uri", "value": uri}]
            comment = get_comment(g, cls, "en")
            if comment:
                tags.append({"name": "definition-en", "value": comment})
            label = get_label(g, cls, "en")
            if label:
                tags.append({"name": "label-en", "value": label})

            # Optional: usage scope tag aligned to many SEMIC models
            tags.append({"name": "class-usage-scope", "value": "main"})

            elem = {
                "name": name,
                "ID": cls_id,
                "uri": uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": root_pkg_id,
                "tags": tags,
                "attributes": []
            }
            class_elems[uri] = elem
            model["elements"].append(elem)

    # Helper to ensure a class element exists for non-primitive ranges
    def ensure_class(uri_ref: URIRef | BNode):
        u = str(uri_ref)
        if u not in class_elems:
            # Skip anonymous OWL restrictions / blank nodes
            if _is_anonymous_ref(uri_ref):
                return None
            name = get_label(g, uri_ref, "en") or local_name(uri_ref)
            cls_id = ea_id("EAID", u)
            tags = [{"name": "uri", "value": u}]
            comment = get_comment(g, uri_ref, "en")
            if comment:
                tags.append({"name": "definition-en", "value": comment})
            label = get_label(g, uri_ref, "en")
            if label:
                tags.append({"name": "label-en", "value": label})
            elem = {
                "name": name,
                "ID": cls_id,
                "uri": u,
                "type": "uml:Class",
                "visibility": "public",
                "package": root_pkg_id,
                "tags": tags,
                "attributes": []
            }
            class_elems[u] = elem
            model["elements"].append(elem)
        return class_elems[u]

    # Helper: classify whether a property is a datatype-like property
    def is_datatype_property(prop: URIRef) -> bool:
        for t in g.objects(prop, RDF.type):
            if str(t) in {str(OWL.DatatypeProperty), str(OWL.AnnotationProperty), str(OWL.FunctionalProperty)}:
                # Annotation/Functional can be either; check range to decide
                continue
        # If any range is a primitive or RDF/XSD literal, treat as attribute
        for rng in g.objects(prop, RDFS.range):
            if primitive_from_range(rng) or str(rng) in (str(RDFS.Literal), str(RDF.langString)):
                return True
        return False

    # Collect property URIs and their types once
    property_uris: dict[str, set[str]] = {}
    for prop_uri_ref, prop_type_ref in g.subject_objects(RDF.type):
        prop_uri = str(prop_uri_ref)
        prop_type = str(prop_type_ref)
        if prop_type in PROPERTY_TYPE_URIS:
            property_uris.setdefault(prop_uri, set()).add(prop_type)

    # 2) Datatype / Annotation / Functional properties whose range is primitive -> attributes
    for prop_uri, prop_types in property_uris.items():
        prop = URIRef(prop_uri)
        prop_label = get_label(g, prop, "en")
        prop_comment = get_comment(g, prop, "en")

        domains = list(g.objects(prop, RDFS.domain))
        ranges = list(g.objects(prop, RDFS.range))

        # Only create attributes when we have a domain and a primitive-like range
        if not domains:
            continue
        if not ranges:
            continue
        if not any(primitive_from_range(rng) or str(rng) in (str(RDFS.Literal), str(RDF.langString)) for rng in ranges):
            continue

        for domain in domains:
            domain_elem = ensure_class(domain)
            if domain_elem is None:
                continue

            for rng in ranges:
                primitive = primitive_from_range(rng)
                if primitive or str(rng) in (str(RDFS.Literal), str(RDF.langString)):
                    attr_type = primitive or "String"
                else:
                    continue

                attr_name = prop_label or local_name(prop)
                attr_tags = [{"name": "uri", "value": prop_uri}]
                if prop_label:
                    attr_tags.append({"name": "label-en", "value": prop_label})
                if prop_comment:
                    attr_tags.append({"name": "definition-en", "value": prop_comment})

                # FunctionalProperty cardinality defaults to 0..1
                lower_bounds = get_literal_value(g, prop, UML_META.lowerBound) or ""
                upper_bounds = get_literal_value(g, prop, UML_META.upperBound) or ""
                if not upper_bounds and str(OWL.FunctionalProperty) in prop_types:
                    upper_bounds = "1"

                domain_elem["attributes"].append({
                    "name": attr_name,
                    "visibility": "public",
                    "type": attr_type,
                    "uri": prop_uri,
                    "lower_bounds": lower_bounds,
                    "upper_bounds": upper_bounds,
                    "tags_attribute": attr_tags
                })

    # 3) Object / mixed properties -> associations
    def should_be_association(prop_uri: str, prop_types: set[str]) -> bool:
        """True if this property has a domain and at least one non-primitive range."""
        prop = URIRef(prop_uri)
        domains = list(g.objects(prop, RDFS.domain))
        if not domains:
            return False
        for rng in g.objects(prop, RDFS.range):
            if not primitive_from_range(rng) and str(rng) not in (str(RDFS.Literal), str(RDF.langString)):
                return True
        return False

    for prop_uri, prop_types in property_uris.items():
        if not should_be_association(prop_uri, prop_types):
            continue

        prop = URIRef(prop_uri)
        prop_label = get_label(g, prop, "en")
        prop_comment = get_comment(g, prop, "en")

        domains = list(g.objects(prop, RDFS.domain))
        ranges = list(g.objects(prop, RDFS.range))

        relationship = get_literal_value(g, prop, UML_META.relationshipType) or "Association"

        # FunctionalProperty -> 0..1 on the target side by default
        is_functional = str(OWL.FunctionalProperty) in prop_types

        for domain in domains:
            domain_elem = ensure_class(domain)
            if domain_elem is None:
                continue
            for rng in ranges:
                if primitive_from_range(rng) or str(rng) in (str(RDFS.Literal), str(RDF.langString)):
                    continue
                range_elem = ensure_class(rng)
                if range_elem is None:
                    continue

                connector_id = ea_id("CONN", f"{str(domain)}:{str(rng)}:{prop_uri}")

                tgt_tags = [{"name": "uri", "value": prop_uri}, {"name": "connector_id", "value": connector_id}]
                if prop_comment:
                    tgt_tags.append({"name": "definition-en", "value": prop_comment})
                if prop_label:
                    tgt_tags.append({"name": "label-en", "value": prop_label})

                right_multiplicity = get_literal_value(g, prop, UML_META.rightMultiplicity) or ""
                if not right_multiplicity and is_functional:
                    right_multiplicity = "0..1"

                connector = {
                    "connector_id": connector_id,
                    "source_id": domain_elem["ID"],
                    "target_id": range_elem["ID"],
                    "source_name": domain_elem["name"],
                    "target_name": range_elem["name"],
                    "relationship": relationship,
                    "name": prop_label or local_name(prop),
                    "uri": prop_uri,
                    "lb": get_literal_value(g, prop, UML_META.leftMultiplicity) or "",
                    "lt": get_literal_value(g, prop, UML_META.leftRole) or "",
                    "rb": right_multiplicity,
                    "rt": get_literal_value(g, prop, UML_META.rightRole) or role_name_from_label(prop_label) or "",
                    "tags": [{"name": "connector_id", "value": connector_id}],
                    "tags_source": [],
                    "tags_target": tgt_tags
                }
                model["connectors"].append(connector)

    # 4) rdfs:subClassOf -> generalizations
    for child, parent in g.subject_objects(RDFS.subClassOf):
        if isinstance(parent, URIRef):
            child_elem = ensure_class(child)
            parent_elem = ensure_class(parent)
            if child_elem is None or parent_elem is None:
                continue

            connector_id = ea_id("CONN", f"{str(child)}:{str(parent)}:subClassOf")

            gen = {
                "connector_id": connector_id,
                "source_id": child_elem["ID"],
                "target_id": parent_elem["ID"],
                "source_name": child_elem["name"],
                "target_name": parent_elem["name"],
                "relationship": "Generalization",
                "name": "subClassOf",
                "uri": "http://www.w3.org/2000/01/rdf-schema#subClassOf",
                "lb": "",
                "lt": "",
                "rb": "",
                "rt": "",
                "tags": [{"name": "connector_id", "value": connector_id}],
                "tags_source": [],
                "tags_target": [{"name": "connector_id", "value": connector_id}]
            }
            model["connectors"].append(gen)

    # 5) rdfs:subPropertyOf -> dependency-like connectors (optional, helps visualise taxonomy)
    for child, parent in g.subject_objects(RDFS.subPropertyOf):
        if isinstance(parent, URIRef) and str(parent) != prop_uri:
            child_prop_label = get_label(g, child, "en") or local_name(child)
            parent_prop_label = get_label(g, parent, "en") or local_name(parent)

            # Resolve child as class/domain if possible, otherwise skip
            child_domains = list(g.objects(child, RDFS.domain)) or []
            parent_domains = list(g.objects(parent, RDFS.domain)) or []
            if not child_domains or not parent_domains:
                continue

            source_elem = ensure_class(child_domains[0])
            target_elem = ensure_class(parent_domains[0])
            if source_elem is None or target_elem is None:
                continue

            connector_id = ea_id("CONN", f"{str(child)}:{str(parent)}:subPropertyOf")

            model["connectors"].append({
                "connector_id": connector_id,
                "source_id": source_elem["ID"],
                "target_id": target_elem["ID"],
                "source_name": source_elem["name"],
                "target_name": target_elem["name"],
                "relationship": "Dependency",
                "name": f"subPropertyOf ({child_prop_label} -> {parent_prop_label})",
                "uri": "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
                "lb": "",
                "lt": "",
                "rb": "",
                "rt": "",
                "tags": [{"name": "connector_id", "value": connector_id}],
                "tags_source": [],
                "tags_target": [{"name": "connector_id", "value": connector_id}],
            })

    return model


def build_model_from_instances(g: Graph, package_name: str | None = None) -> dict:
    """
    Build a UML-ish model from concrete RDF instances (NamedIndividuals, foaf:Person, etc.).
    This is only useful for data/instance-oriented TTL files, not for ontologies.
    """
    model = {"elements": [], "connectors": []}

    root_pkg = extract_ontology_package(g, custom_name=package_name)
    model["elements"].append(root_pkg)
    root_pkg_id = root_pkg["ID"]

    onto_uri = None
    ontos = list(g.subjects(RDF.type, OWL.Ontology))
    if ontos:
        onto_uri = str(ontos[0])

    # If the graph is clearly an ontology (has owl:Ontology and many classes/properties),
    # do not turn concrete instances into UML classes; that pollutes the class diagram.
    ontology_class_count = sum(
        1 for _ in g.subjects(RDF.type, OWL.Class)
    ) + sum(1 for _ in g.subjects(RDF.type, RDFS.Class))
    property_count = sum(
        1 for s, t in g.subject_objects(RDF.type)
        if str(t) in PROPERTY_TYPE_URIS
    )
    if onto_uri is not None and (ontology_class_count > 0 or property_count > 0):
        # Treat as a pure ontology: skip instance modelling.
        return model

    instance_types: dict[str, str] = {}
    for s, o in g.subject_objects(RDF.type):
        s_uri = str(s)
        o_uri = str(o)
        if o_uri in _NON_ONTOLOGY_INSTANCE_TYPES or s_uri == onto_uri:
            continue
        instance_types[s_uri] = o_uri

    if not instance_types:
        for s in g.subjects():
            s_uri = str(s)
            if s_uri == onto_uri:
                continue
            if (s, RDF.type, None) not in g:
                instance_types[s_uri] = ""

    if not instance_types:
        return model

    type_packages: dict[str, str] = {}
    for type_uri in set(instance_types.values()):
        if not type_uri:
            continue
        type_name = local_name(URIRef(type_uri))
        type_label = get_label(g, URIRef(type_uri), "en") or type_name
        pkg_id = ea_id("EAPK", type_uri)
        type_packages[type_uri] = pkg_id
        model["elements"].append({
            "name": type_label,
            "ID": pkg_id,
            "uri": type_uri,
            "type": "uml:Package",
            "visibility": "public",
            "package": root_pkg_id,
            "tags": [{"name": "uri", "value": type_uri}],
        })

    element_by_uri: dict[str, dict] = {}
    for s_uri, type_uri in instance_types.items():
        s_ref = URIRef(s_uri)
        name = get_label(g, s_ref, "en") or local_name(s_ref)
        cls_id = ea_id("EAID", s_uri)
        tags = [{"name": "uri", "value": s_uri}]
        comment = get_comment(g, s_ref, "en")
        if comment:
            tags.append({"name": "definition-en", "value": comment})

        pkg_id = type_packages.get(type_uri, root_pkg_id)

        elem = {
            "name": name,
            "ID": cls_id,
            "uri": s_uri,
            "type": "uml:Class",
            "visibility": "public",
            "package": pkg_id,
            "tags": tags,
            "attributes": [],
        }
        element_by_uri[s_uri] = elem
        model["elements"].append(elem)

    # Iterate over a snapshot of keys so we can create missing target elements on the fly
    for s_uri in list(element_by_uri.keys()):
        elem = element_by_uri[s_uri]
        s_ref = URIRef(s_uri)
        for p, o in g.predicate_objects(s_ref):
            p_uri = str(p)
            if p_uri in (str(RDF.type),):
                continue

            if isinstance(o, Literal):
                attr_name = local_name(URIRef(p_uri))
                attr_type = "String"
                if o.datatype:
                    mapped = primitive_from_range(o.datatype)
                    if mapped:
                        attr_type = mapped
                elem["attributes"].append({
                    "name": attr_name,
                    "visibility": "public",
                    "type": attr_type,
                    "uri": p_uri,
                    "lower_bounds": "",
                    "upper_bounds": "",
                    "tags_attribute": [{"name": "uri", "value": p_uri}],
                })
            elif isinstance(o, URIRef):
                o_uri = str(o)
                target_elem = element_by_uri.get(o_uri)
                if target_elem is None:
                    target_name = get_label(g, o, "en") or local_name(o)
                    target_id = ea_id("EAID", o_uri)
                    target_elem = {
                        "name": target_name,
                        "ID": target_id,
                        "uri": o_uri,
                        "type": "uml:Class",
                        "visibility": "public",
                        "package": root_pkg_id,
                        "tags": [{"name": "uri", "value": o_uri}],
                        "attributes": [],
                    }
                    element_by_uri[o_uri] = target_elem
                    model["elements"].append(target_elem)

                rel_name = local_name(URIRef(p_uri))
                rel_label = get_label(g, URIRef(p_uri), "en") or rel_name
                connector_id = ea_id("CONN", f"{s_uri}:{o_uri}:{p_uri}")

                model["connectors"].append({
                    "connector_id": connector_id,
                    "source_id": elem["ID"],
                    "target_id": target_elem["ID"],
                    "source_name": elem["name"],
                    "target_name": target_elem["name"],
                    "relationship": "Association",
                    "name": rel_label,
                    "uri": p_uri,
                    "lb": "",
                    "lt": "",
                    "rb": "",
                    "rt": "",
                    "tags": [{"name": "connector_id", "value": connector_id}],
                    "tags_source": [],
                    "tags_target": [{"name": "uri", "value": p_uri}, {"name": "connector_id", "value": connector_id}],
                })

    return model


def _repair_ttl_text(text: str) -> str:
    """
    Attempt to repair common TTL corruptions found in some LOV dump files.
    These files sometimes contain Python byte-string artifacts (e.g. b'...')
    or stray caret characters inside URIs/literals.
    """
    # Remove control chars except newlines/tabs
    text = "".join(c for c in text if c == "\n" or c == "\t" or ord(c) >= 32)

    # Fix Python byte-string artifacts around URIs and prefixed names.
    # Examples seen in the wild:
    #   ns3:creator <http://...bernard-vatant'^b'> ;
    #   ...b'3:creator <http://...bernard-vatant'^b'> ;
    # We remove isolated b' / 'b / ^b that appear to be artifacts.

    # Remove stray single quotes and carets that are not part of valid Turtle syntax
    # Heuristic: replace patterns like <...'b> with <...>
    text = re.sub(r"<'?b?(\w+)", r"<\1", text)
    text = re.sub(r"b?'(\w+)>", r"\1>", text)

    # Remove any standalone b' or 'b not inside a string literal. We do this carefully:
    # Split by string literal regions, process only outside.
    result_parts: list[str] = []
    i = 0
    while i < len(text):
        if text[i] == '"':
            # find closing quote (skip escaped)
            j = i + 1
            while j < len(text):
                if text[j] == "\\" and j + 1 < len(text):
                    j += 2
                elif text[j] == '"':
                    j += 1
                    break
                else:
                    j += 1
            result_parts.append(text[i:j])
            i = j
        else:
            result_parts.append(text[i])
            i += 1

    outside = True
    cleaned_parts: list[str] = []
    for part in result_parts:
        if part.startswith('"') and part.endswith('"'):
            cleaned_parts.append(part)
        else:
            # Remove artifact patterns outside string literals
            cleaned = re.sub(r"\bb'", "", part)
            cleaned = re.sub(r"'\bb", "", cleaned)
            cleaned = re.sub(r"\^b", "", cleaned)
            cleaned = cleaned.replace("'", "")
            cleaned_parts.append(cleaned)

    text = "".join(cleaned_parts)

    # Collapse multiple spaces and normalize whitespace around punctuation
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r" ;", ";", text)
    text = re.sub(r" \.", ".", text)
    text = re.sub(r" ,", ",", text)
    text = text.replace(" ;", ";").replace(" .", ".")

    return text


def _resolve_prefixed_ttl(name: str, prefixes: dict[str, str]) -> rdflib.URIRef | None:
    """Resolve a Turtle prefixed name or URI into a URIRef."""
    name = name.strip()
    if name.startswith("<") and name.endswith(">"):
        return rdflib.URIRef(name[1:-1])
    if ":" in name:
        prefix, local = name.split(":", 1)
        base = prefixes.get(prefix)
        if base:
            return rdflib.URIRef(base + local)
    return None


def _parse_ttl_regex(text: str) -> rdflib.Graph:
    """
    Fallback parser for severely broken TTL files.
    Extracts simple N-Triples-like statements from a cleaned text.
    Handles prefixed names and URI references.
    """
    g = rdflib.Graph()

    # Extract prefix declarations
    prefixes: dict[str, str] = {}
    for match in re.finditer(r"@prefix\s+(\w+):\s*<([^>]+)>\s*\.", text, re.IGNORECASE):
        prefixes[match.group(1)] = match.group(2)

    # Remove line continuations inside string literals that span multiple physical lines
    # by replacing inner newlines within quotes with spaces. This is a best-effort cleanup.
    cleaned_lines: list[str] = []
    in_string = False
    current = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not in_string:
            current = line
        else:
            current += " " + line.strip()

        # Toggle string state for unescaped quotes
        i = 0
        while i < len(current):
            if current[i] == "\\" and i + 1 < len(current):
                i += 2
            elif current[i] == '"':
                in_string = not in_string
                i += 1
            else:
                i += 1

        if not in_string:
            cleaned_lines.append(current)
            current = ""

    # Pattern for simple triples with explicit subject/predicate/object
    triple_re = re.compile(
        r"(<[^>]+>|\w+:[^\s;.,]+)\s+"
        r"(<[^>]+>|\w+:[^\s;.,]+)\s+"
        r"(<[^>]+>|\"[^\"]*\"|\w+:[^\s;.,]+|\d+)\s*\."
    )

    for line in cleaned_lines:
        for match in triple_re.finditer(line):
            s, p, o = match.group(1), match.group(2), match.group(3)
            s_node = _resolve_prefixed_ttl(s, prefixes)
            p_node = _resolve_prefixed_ttl(p, prefixes)
            if s_node is None or p_node is None:
                continue

            if o.startswith("<") and o.endswith(">"):
                o_node = rdflib.URIRef(o[1:-1])
            elif o.startswith('"') and o.endswith('"'):
                o_node = rdflib.Literal(o[1:-1])
            elif ":" in o:
                resolved = _resolve_prefixed_ttl(o, prefixes)
                o_node = resolved if resolved else rdflib.Literal(o)
            else:
                try:
                    o_node = rdflib.Literal(int(o))
                except ValueError:
                    o_node = rdflib.Literal(o)

            g.add((s_node, p_node, o_node))

    return g


def _ttl_text_to_model(text: str) -> dict[str, Any]:
    """
    Best-effort UML model extraction directly from TTL text, without rdflib.
    Handles classes, object/datatype properties, domains/ranges, subClassOf.
    """
    model: dict[str, Any] = {"elements": [], "connectors": []}

    prefixes: dict[str, str] = {}
    for match in re.finditer(r"@prefix\s+(\w+):\s*<([^>]+)>\s*\.", text, re.IGNORECASE):
        prefixes[match.group(1)] = match.group(2)

    def resolve(name: str) -> str:
        name = name.strip()
        if name.startswith("<") and name.endswith(">"):
            return name[1:-1]
        if ":" in name:
            prefix, local = name.split(":", 1)
            base = prefixes.get(prefix)
            if base:
                return base + local
        return name

    def local_name(uri: str) -> str:
        if "#" in uri:
            local = uri.split("#")[-1]
        else:
            local = uri.rstrip("/").split("/")[-1]
        return local.strip() or uri.strip() or "Unnamed"

    def class_id(uri: str) -> str:
        return ea_id("EAID", uri)

    # Root package
    ontos = list(re.finditer(r"(<[^>]+>|\w+:[^\s]+)\s+a\s+owl:Ontology", text, re.IGNORECASE))
    root_name = "TTL Model"
    root_uri = "urn:ttl:model"
    if ontos:
        root_uri = resolve(ontos[0].group(1))
        root_name = local_name(root_uri)
    root_pkg_id = ea_id("EAPK", root_uri)
    model["elements"].append({
        "name": root_name,
        "ID": root_pkg_id,
        "uri": root_uri,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [],
    })

    class_by_uri: dict[str, dict[str, Any]] = {}

    # Classes
    for match in re.finditer(r"(<[^>]+>|\w+:[^\s]+)\s+a\s+(owl:Class|rdfs:Class)\s*[;.]", text, re.IGNORECASE):
        uri = resolve(match.group(1))
        if _is_anonymous_uri(uri):
            continue
        cls = {
            "name": local_name(uri),
            "ID": class_id(uri),
            "uri": uri,
            "type": "uml:Class",
            "visibility": "public",
            "package": root_pkg_id,
            "tags": [{"name": "uri", "value": uri}],
            "attributes": [],
        }
        class_by_uri[uri] = cls
        model["elements"].append(cls)

    # Labels and comments
    label_re = re.compile(r"(<[^>]+>|\w+:[^\s]+)\s+rdfs:label\s+\"([^\"]+)\"", re.IGNORECASE)
    for match in label_re.finditer(text):
        uri = resolve(match.group(1))
        cls = class_by_uri.get(uri)
        if cls:
            cls["name"] = match.group(2)

    # Object properties -> associations
    prop_re = re.compile(
        r"(<[^>]+>|\w+:[^\s]+)\s+a\s+owl:ObjectProperty\s*;?",
        re.IGNORECASE,
    )
    for match in prop_re.finditer(text):
        prop_uri = resolve(match.group(1))
        # Find domain/range in the surrounding statement block
        block = text[match.end():]
        end = re.search(r"\.\s*(?=\n\s*<|\n\s*\w+:|\Z)", block)
        block = block[:end.start()] if end else block[:500]
        domains = re.findall(r"rdfs:domain\s+(<[^>]+>|\w+:[^\s;.,]+)", block, re.IGNORECASE)
        ranges = re.findall(r"rdfs:range\s+(<[^>]+>|\w+:[^\s;.,]+)", block, re.IGNORECASE)
        label_match = re.search(r"rdfs:label\s+\"([^\"]+)\"", block, re.IGNORECASE)
        prop_name = label_match.group(1) if label_match else local_name(prop_uri)

        for d in domains:
            d_uri = resolve(d)
            s_cls = class_by_uri.get(d_uri)
            if s_cls is None and not _is_anonymous_uri(d_uri):
                s_cls = {
                    "name": local_name(d_uri),
                    "ID": class_id(d_uri),
                    "uri": d_uri,
                    "type": "uml:Class",
                    "visibility": "public",
                    "package": root_pkg_id,
                    "tags": [{"name": "uri", "value": d_uri}],
                    "attributes": [],
                }
                class_by_uri[d_uri] = s_cls
                model["elements"].append(s_cls)
            for r in ranges:
                r_uri = resolve(r)
                if _is_anonymous_uri(r_uri):
                    continue
                t_cls = class_by_uri.get(r_uri)
                if t_cls is None:
                    t_cls = {
                        "name": local_name(r_uri),
                        "ID": class_id(r_uri),
                        "uri": r_uri,
                        "type": "uml:Class",
                        "visibility": "public",
                        "package": root_pkg_id,
                        "tags": [{"name": "uri", "value": r_uri}],
                        "attributes": [],
                    }
                    class_by_uri[r_uri] = t_cls
                    model["elements"].append(t_cls)
                if s_cls:
                    conn_id = ea_id("CONN", f"{s_cls['ID']}:{t_cls['ID']}:{prop_uri}")
                    model["connectors"].append({
                        "connector_id": conn_id,
                        "source_id": s_cls["ID"],
                        "target_id": t_cls["ID"],
                        "source_name": s_cls["name"],
                        "target_name": t_cls["name"],
                        "relationship": "Association",
                        "name": prop_name,
                        "uri": prop_uri,
                        "lb": "",
                        "lt": "",
                        "rb": "",
                        "rt": "",
                        "tags": [{"name": "uri", "value": prop_uri}, {"name": "connector_id", "value": conn_id}],
                        "tags_source": [],
                        "tags_target": [],
                    })

    # Datatype properties -> attributes
    dp_re = re.compile(
        r"(<[^>]+>|\w+:[^\s]+)\s+a\s+owl:DatatypeProperty\s*;?",
        re.IGNORECASE,
    )
    for match in dp_re.finditer(text):
        prop_uri = resolve(match.group(1))
        block = text[match.end():]
        end = re.search(r"\.\s*(?=\n\s*<|\n\s*\w+:|\Z)", block)
        block = block[:end.start()] if end else block[:500]
        domains = re.findall(r"rdfs:domain\s+(<[^>]+>|\w+:[^\s;.,]+)", block, re.IGNORECASE)
        ranges = re.findall(r"rdfs:range\s+((?:xsd|rdfs):[^\s;.,]+|\w+:[^\s;.,]+)", block, re.IGNORECASE)
        label_match = re.search(r"rdfs:label\s+\"([^\"]+)\"", block, re.IGNORECASE)
        attr_name = label_match.group(1) if label_match else local_name(prop_uri)
        attr_type = "String"
        if ranges:
            rng = ranges[0]
            if "integer" in rng.lower() or "int" in rng.lower():
                attr_type = "Integer"
            elif "boolean" in rng.lower():
                attr_type = "Boolean"
            elif "float" in rng.lower() or "double" in rng.lower() or "decimal" in rng.lower():
                attr_type = "Real"
            elif "date" in rng.lower():
                attr_type = "DateTime"
        for d in domains:
            d_uri = resolve(d)
            s_cls = class_by_uri.get(d_uri)
            if s_cls is None and not _is_anonymous_uri(d_uri):
                s_cls = {
                    "name": local_name(d_uri),
                    "ID": class_id(d_uri),
                    "uri": d_uri,
                    "type": "uml:Class",
                    "visibility": "public",
                    "package": root_pkg_id,
                    "tags": [{"name": "uri", "value": d_uri}],
                    "attributes": [],
                }
                class_by_uri[d_uri] = s_cls
                model["elements"].append(s_cls)
            if s_cls:
                s_cls["attributes"].append({
                    "name": attr_name,
                    "visibility": "public",
                    "type": attr_type,
                    "uri": prop_uri,
                    "lower_bounds": "",
                    "upper_bounds": "",
                    "tags_attribute": [{"name": "uri", "value": prop_uri}],
                })

    # subClassOf
    sub_re = re.compile(
        r"(\<[^\>]+\>|\w+:[^\s]+)\s+rdfs:subClassOf\s+(\<[^\>]+\>|\w+:[^\s]+)\s*[;.]",
        re.IGNORECASE,
    )
    for match in sub_re.finditer(text):
        child_uri = resolve(match.group(1))
        parent_uri = resolve(match.group(2))
        if _is_anonymous_uri(child_uri) or _is_anonymous_uri(parent_uri):
            continue
        child = class_by_uri.get(child_uri)
        parent = class_by_uri.get(parent_uri)
        if child is None:
            child = {
                "name": local_name(child_uri),
                "ID": class_id(child_uri),
                "uri": child_uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": root_pkg_id,
                "tags": [{"name": "uri", "value": child_uri}],
                "attributes": [],
            }
            class_by_uri[child_uri] = child
            model["elements"].append(child)
        if parent is None:
            parent = {
                "name": local_name(parent_uri),
                "ID": class_id(parent_uri),
                "uri": parent_uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": root_pkg_id,
                "tags": [{"name": "uri", "value": parent_uri}],
                "attributes": [],
            }
            class_by_uri[parent_uri] = parent
            model["elements"].append(parent)
        conn_id = ea_id("CONN", f"{child['ID']}:{parent['ID']}:subClassOf")
        model["connectors"].append({
            "connector_id": conn_id,
            "source_id": child["ID"],
            "target_id": parent["ID"],
            "source_name": child["name"],
            "target_name": parent["name"],
            "relationship": "Generalization",
            "name": "subClassOf",
            "uri": "http://www.w3.org/2000/01/rdf-schema#subClassOf",
            "lb": "",
            "lt": "",
            "rb": "",
            "rt": "",
            "tags": [{"name": "connector_id", "value": conn_id}],
            "tags_source": [],
            "tags_target": [],
        })

    # Fallback for catalog-like TTL files (e.g. LOV dataset): turn typed instances into classes
    if not any(e.get("type") == "uml:Class" for e in model["elements"]):
        _build_instance_model_from_text(text, prefixes, model, root_pkg_id, resolve, local_name, class_id)

    return model


def _build_instance_model_from_text(
    text: str,
    prefixes: dict[str, str],
    model: dict[str, Any],
    root_pkg_id: str,
    resolve: Any,
    local_name: Any,
    class_id: Any,
) -> None:
    """
    When no OWL classes are declared, build a model from typed RDF instances.
    Each distinct rdf:type becomes a class; instances become objects/attributes.
    """
    type_re = re.compile(
        r"(\<[^\>]+\>|\w+:[^\s]+)\s+a\s+(\<[^\>]+\>|\w+:[^\s;.,]+)",
        re.IGNORECASE,
    )
    instances_by_type: dict[str, list[str]] = {}
    for match in type_re.finditer(text):
        s_uri = resolve(match.group(1))
        t_uri = resolve(match.group(2))
        if _is_anonymous_uri(s_uri) or _is_anonymous_uri(t_uri):
            continue
        if t_uri in {
            str(OWL.Ontology),
            str(OWL.Class),
            str(RDFS.Class),
            str(OWL.ObjectProperty),
            str(OWL.DatatypeProperty),
            str(RDF.Property),
        }:
            continue
        instances_by_type.setdefault(t_uri, []).append(s_uri)

    if not instances_by_type:
        return

    type_classes: dict[str, dict[str, Any]] = {}
    for type_uri, instances in instances_by_type.items():
        type_name = local_name(type_uri)
        type_cls = {
            "name": type_name,
            "ID": class_id(type_uri),
            "uri": type_uri,
            "type": "uml:Class",
            "visibility": "public",
            "package": root_pkg_id,
            "tags": [{"name": "uri", "value": type_uri}],
            "attributes": [{"name": "uri", "type": "URI"}],
        }
        type_classes[type_uri] = type_cls
        model["elements"].append(type_cls)

    # Add a few sample instances as attributes and simple relationships
    instance_cls_map: dict[str, dict[str, Any]] = {}
    for type_uri, instances in instances_by_type.items():
        type_cls = type_classes[type_uri]
        for inst_uri in instances[:50]:  # limit to avoid huge diagrams
            inst_name = local_name(inst_uri)
            inst_id = class_id(inst_uri)
            inst_cls = {
                "name": inst_name,
                "ID": inst_id,
                "uri": inst_uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": root_pkg_id,
                "tags": [{"name": "uri", "value": inst_uri}],
                "attributes": [],
            }
            instance_cls_map[inst_uri] = inst_cls
            model["elements"].append(inst_cls)
            conn_id = ea_id("CONN", f"{inst_id}:{type_cls['ID']}:type")
            model["connectors"].append({
                "connector_id": conn_id,
                "source_id": inst_id,
                "target_id": type_cls["ID"],
                "source_name": inst_cls["name"],
                "target_name": type_cls["name"],
                "relationship": "Generalization",
                "name": "type",
                "uri": str(RDF.type),
                "lb": "",
                "lt": "",
                "rb": "",
                "rt": "",
                "tags": [{"name": "connector_id", "value": conn_id}],
                "tags_source": [],
                "tags_target": [],
            })



def ttl_to_json(uploaded_file: BytesIO) -> dict[str, Any]:
    """
    Imports a TTL file, parses it as an RDF graph, and serializes to JSON-LD and TTL.

    :param uploaded_file: The uploaded TTL file (BytesIO).
    :return: A dict with "ttl" (JSON-LD as Python objects), "ttl_raw" (TTL string), and "xmi" (Unified elements structure).
    """
    try:
        # Ensure pointer at start
        uploaded_file.seek(0)
        data_bytes = uploaded_file.read()
        uploaded_file.seek(0)

        text = data_bytes.decode("utf-8", errors="replace")

        g = rdflib.Graph()
        # Use parse(data=...) to avoid rdflib treating input as a filename
        try:
            g.parse(data=text, format="ttl")
        except Exception as parse_error:
            # Try to repair common corruptions and parse again
            repaired = _repair_ttl_text(text)
            g2 = rdflib.Graph()
            try:
                g2.parse(data=repaired, format="ttl")
                g = g2
            except Exception:
                # Last resort: line-by-line extraction on repaired text
                g3 = _parse_ttl_regex(repaired)
                if len(g3) == 0:
                    # If regex fallback also yields nothing, try direct model extraction
                    model = _ttl_text_to_model(repaired)
                    if not model.get("elements"):
                        raise parse_error
                    return {
                        "ttl": {},
                        "ttl_raw": text,
                        "xmi": model,
                    }
                g = g3

        # Serialize the graph to JSON-LD (string), then to Python dict
        json_ld_data: str = g.serialize(format="json-ld", indent=4)
        json_data = json.loads(json_ld_data) if json_ld_data else {}

        ttl_raw_bytes = g.serialize(format="ttl")
        ttl_raw = ttl_raw_bytes.decode("utf-8") if isinstance(ttl_raw_bytes, (bytes, bytearray)) else str(ttl_raw_bytes)

        xmi = build_model(g)

        instances_xmi = build_model_from_instances(g)
        if instances_xmi.get("elements") and len(instances_xmi["elements"]) > 1:
            xmi_elements = xmi.get("elements", [])
            xmi_connectors = xmi.get("connectors", [])
            existing_ids = {e.get("ID") for e in xmi_elements}
            for elem in instances_xmi.get("elements", []):
                if elem.get("ID") not in existing_ids:
                    xmi_elements.append(elem)
                    existing_ids.add(elem.get("ID"))
            existing_conn_keys = {
                (c.get("source_id"), c.get("target_id"), c.get("name"))
                for c in xmi_connectors
            }
            for conn in instances_xmi.get("connectors", []):
                key = (conn.get("source_id"), conn.get("target_id"), conn.get("name"))
                if key not in existing_conn_keys:
                    xmi_connectors.append(conn)
                    existing_conn_keys.add(key)
            xmi["elements"] = xmi_elements
            xmi["connectors"] = xmi_connectors

        return {
            "ttl": json_data,
            "ttl_raw": ttl_raw,
            "xmi": xmi,
        }
    except Exception as e:
        # Let caller show a friendly message
        raise
