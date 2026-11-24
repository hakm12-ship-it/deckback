"""A small JSON Schema validator for harness/fidelity/results.schema.json (no new dependency: the harness has no
`jsonschema` package, and the global constraints add none).

    validate(instance, schema) -> [problem, ...]      # empty: valid

It supports the keywords that schema uses, with their JSON Schema 2020-12 meaning: ``type`` (a name or a list),
``const``, ``enum``, ``properties``, ``required``, ``additionalProperties`` (false or a schema), ``items``,
``maxItems``, ``uniqueItems``, ``pattern`` (``re.search``), ``maxLength``, ``minimum``, ``maximum``, ``anyOf``,
``oneOf``, ``if`` / ``then`` / ``else`` and local ``$ref`` (``#/$defs/<name>``). Annotations (``$schema``, ``$id``,
``title``, ``description``, ``$comment``, ``$defs``) are ignored. Any other keyword raises ValueError, so the schema
cannot quietly rely on a rule nothing checks.

A problem names the JSON pointer and the rule, never the value found there: a value that breaks the privacy rules
(a private file name in place of an id) must not be printed by the check that catches it.
"""

import re

ANNOTATIONS = {"$schema", "$id", "title", "description", "$comment", "$defs"}
KEYWORDS = {"type", "const", "enum", "properties", "required", "additionalProperties", "items", "maxItems",
            "uniqueItems", "pattern", "maxLength", "minimum", "maximum", "anyOf", "oneOf", "if", "then", "else",
            "$ref"} | ANNOTATIONS


def _is_type(value, name):
    if name == "null":
        return value is None
    if name == "boolean":
        return isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "string":
        return isinstance(value, str)
    if name == "array":
        return isinstance(value, list)
    if name == "object":
        return isinstance(value, dict)
    raise ValueError(f"unknown type {name!r} in the schema")


def _equal(a, b):
    """JSON equality: booleans are not numbers."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def _resolve(root, ref):
    if not ref.startswith("#/"):
        raise ValueError(f"only local $ref is supported, got {ref!r}")
    node = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def _pointer(path):
    return "/" + "/".join(str(p) for p in path) if path else "/"


def _check(value, schema, root, path, out):
    if schema is True:
        return
    if schema is False:
        out.append(f"{_pointer(path)}: not allowed")
        return
    extra = set(schema) - KEYWORDS
    if extra:
        raise ValueError(f"unsupported schema keyword(s) {sorted(extra)} at {_pointer(path)}")
    where = _pointer(path)
    if "$ref" in schema:
        _check(value, _resolve(root, schema["$ref"]), root, path, out)
    if "type" in schema:
        names = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_is_type(value, name) for name in names):
            out.append(f"{where}: not of type {'/'.join(names)}")
            return
    if "const" in schema and not _equal(value, schema["const"]):
        out.append(f"{where}: not the required constant")
    if "enum" in schema and not any(_equal(value, option) for option in schema["enum"]):
        out.append(f"{where}: not one of the allowed values")
    if isinstance(value, str):
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            out.append(f"{where}: longer than {schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            out.append(f"{where}: does not match the pattern {schema['pattern']}")
    if _is_type(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            out.append(f"{where}: below the minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            out.append(f"{where}: above the maximum {schema['maximum']}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                out.append(f"{where}: missing property {key!r}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                _check(item, properties[key], root, path + [key], out)
            elif "additionalProperties" in schema:
                additional = schema["additionalProperties"]
                if additional is False:
                    out.append(f"{where}: unexpected property (not in the schema)")
                else:
                    _check(item, additional, root, path + [key], out)
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            out.append(f"{where}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems"):
            for i, a in enumerate(value):
                if any(_equal(a, b) for b in value[:i]):
                    out.append(f"{where}: items are not unique")
                    break
        if "items" in schema:
            for index, item in enumerate(value):
                _check(item, schema["items"], root, path + [index], out)
    if "anyOf" in schema:
        if not any(not _sub(value, option, root, path) for option in schema["anyOf"]):
            out.append(f"{where}: matches none of anyOf")
    if "oneOf" in schema:
        matches = sum(1 for option in schema["oneOf"] if not _sub(value, option, root, path))
        if matches != 1:
            out.append(f"{where}: matches {matches} of oneOf (need exactly 1)")
    if "if" in schema:
        branch = "then" if not _sub(value, schema["if"], root, path) else "else"
        if branch in schema:
            _check(value, schema[branch], root, path, out)


def _sub(value, schema, root, path):
    problems = []
    _check(value, schema, root, path, problems)
    return problems


def validate(instance, schema):
    """Problems of `instance` against `schema` (see the module docstring); [] when it is valid."""
    problems = []
    _check(instance, schema, schema, [], problems)
    return problems
