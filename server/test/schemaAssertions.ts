import { expect } from "vitest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every object key name that appears anywhere in a JSON-like value, through arrays and nested
 * objects. The leak-scan tests (schemas.listening.test.ts, schemas.reading.test.ts) check a stripped
 * Set's keys against an explicit ALLOWED_KEYS list with it: a list of known secret strings catches
 * only what its author thought to list, and says nothing about a new field nobody thought to strip.
 */
export function collectObjectKeys(
  value: unknown,
  keys: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectObjectKeys(nested, keys);
    }
  }
  return keys;
}

// The whole JSON Schema vocabulary collectSchemaKeys understands: the keywords z.toJSONSchema emits
// for ListeningSetSchema and ReadingSetSchema, split into containers (may hold a nested schema, so
// walked) and leaves (scalar constraints, so ignored). Any other keyword throws.
// `additionalProperties` is in neither set: it is a leaf only when its value is a boolean, and a
// schema-valued one (z.record() or .catchall()) is unsupported and checked separately.
const CONTAINER_KEYWORDS = new Set([
  "properties", "items", "prefixItems", "oneOf", "anyOf", "allOf", "$ref", "$defs",
]);
const LEAF_KEYWORDS = new Set([
  "$schema", "type", "required", "const", "enum", "pattern",
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "minItems", "maxItems",
]);

/**
 * Every property key name a zod schema's JSON Schema (`z.toJSONSchema(schema)`) can produce. It walks
 * `properties` (optional keys included: JSON Schema lists them there and only leaves them out of
 * `required`), `items`, `prefixItems` (tuples), `oneOf`/`anyOf`/`allOf` (zod emits `oneOf` for a
 * discriminated union), and `$ref` into `$defs` (what a schema tagged `.meta({id})` and reused in
 * several places becomes).
 *
 * `collectObjectKeys` walks a value, so it cannot see a key no fixture populates, and an optional
 * field is the only kind a Set schema can gain: banked Sets are immutable and re-parsed on every
 * read, so a new required field would make them unloadable. Use this, not `collectObjectKeys`, for
 * the half of a leak scan that must catch a field whether or not a fixture carries it.
 *
 * It fails loudly rather than under-covering: a keyword it does not recognise throws, naming the
 * keyword and its path, and so do the two constructs it cannot walk, a `$ref` other than
 * `#/$defs/<name>` (the bare `"#"` a recursive z.lazy() schema without `.meta({id})` emits) and an
 * `additionalProperties` holding a schema (z.record() or .catchall(), an open-ended key space).
 * Neither occurs in the Listening or Reading schema; one that starts using either fails the leak scan
 * instead of passing with a hole in it. `visited` stops a cyclic definition from looping.
 */
export function collectSchemaKeys(
  jsonSchema: unknown,
  keys: Set<string> = new Set(),
): Set<string> {
  const defs = isRecord(jsonSchema) && isRecord(jsonSchema.$defs) ? jsonSchema.$defs : {};

  const pending: { node: unknown; path: string }[] = [{ node: jsonSchema, path: "$" }];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const { node: current, path } = pending.pop()!;

    if (Array.isArray(current)) {
      current.forEach((item, i) => pending.push({ node: item, path: `${path}[${i}]` }));
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const record = current as Record<string, unknown>;

    if (typeof record.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/.exec(record.$ref);
      const target = match ? defs[match[1]!] : undefined;
      if (!match || target === undefined) {
        throw new Error(
          `collectSchemaKeys: unresolvable $ref "${record.$ref}" at ${path} — only "#/$defs/<name>" ` +
          `refs into a top-level $defs are supported; a bare root self-reference ("#", the shape a ` +
          `recursive z.lazy() schema with no .meta({id}) uses) is deliberately unsupported`,
        );
      }
      pending.push({ node: target, path: `${path} -> $defs.${match[1]}` });
    }

    if (isRecord(record.additionalProperties)) {
      throw new Error(
        `collectSchemaKeys: unsupported construct at ${path} — "additionalProperties" holds a SCHEMA ` +
        `(z.record()'s or .catchall()'s JSON Schema form: an open-ended key->value map this function ` +
        `has no fixed key set to walk), not the boolean every schema here otherwise uses; deliberately ` +
        `unsupported`,
      );
    }

    const properties = record.properties;
    if (isRecord(properties)) {
      for (const key of Object.keys(properties)) keys.add(key);
      for (const [key, schema] of Object.entries(properties)) {
        pending.push({ node: schema, path: `${path}.properties.${key}` });
      }
    }
    for (const containerKey of ["items", "prefixItems", "oneOf", "anyOf", "allOf"] as const) {
      if (record[containerKey] !== undefined) {
        pending.push({ node: record[containerKey], path: `${path}.${containerKey}` });
      }
    }
    if (isRecord(record.$defs)) {
      for (const [name, schema] of Object.entries(record.$defs)) {
        pending.push({ node: schema, path: `$defs.${name}` });
      }
    }

    // A keyword that is neither a known container (walked above) nor a known leaf might hide a
    // subtree, so it fails the calling test rather than being skipped. An `additionalProperties`
    // that reaches this point is a boolean: the schema-valued form has already thrown.
    for (const key of Object.keys(record)) {
      if (key === "additionalProperties") continue;
      if (CONTAINER_KEYWORDS.has(key) || LEAF_KEYWORDS.has(key)) continue;
      throw new Error(
        `collectSchemaKeys: unrecognized JSON Schema construct "${key}" at ${path} — this function ` +
        `cannot verify a schema it cannot fully walk; add "${key}" to CONTAINER_KEYWORDS or ` +
        `LEAF_KEYWORDS in schemaAssertions.ts after deciding whether it can hide a nested schema`,
      );
    }
  }
  return keys;
}

// Asserts that every object in a JSON Schema lists all of its properties as required: the shape the
// strict structured-output schemas sent with a model call must have. It reaches every subschema an
// object can sit in: properties, `items`, `prefixItems`, every branch of `anyOf`, `oneOf` and
// `allOf` (a nullable value is an `anyOf`, a discriminated union a `oneOf`), every definition in
// `$defs`, and the target of each `$ref`. A `$ref` other than `#` or `#/$defs/<name>` throws rather
// than leaving its target unchecked.
export function expectEveryObjectPropertyRequired(schema: unknown): void {
  const defs = isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : {};
  const pending: { node: unknown; path: string }[] = [{ node: schema, path: "$" }];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const { node: current, path } = pending.pop()!;
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, i) => pending.push({ node: item, path: `${path}[${i}]` }));
      continue;
    }

    const record = current as Record<string, unknown>;
    const properties = record.properties;
    if (isRecord(properties)) {
      expect(record.required, `${path}: every property is required`).toEqual(
        expect.arrayContaining(Object.keys(properties)),
      );
      for (const [key, value] of Object.entries(properties)) {
        pending.push({ node: value, path: `${path}.properties.${key}` });
      }
    }
    for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf"] as const) {
      if (record[key] !== undefined) pending.push({ node: record[key], path: `${path}.${key}` });
    }
    if (isRecord(record.$defs)) {
      for (const [name, value] of Object.entries(record.$defs)) {
        pending.push({ node: value, path: `$defs.${name}` });
      }
    }
    if (typeof record.$ref === "string") {
      if (record.$ref === "#") {
        pending.push({ node: schema, path: `${path} -> #` });
      } else {
        const match = /^#\/\$defs\/(.+)$/.exec(record.$ref);
        const target = match ? defs[match[1]!] : undefined;
        if (target === undefined) {
          throw new Error(`expectEveryObjectPropertyRequired: unresolvable $ref "${record.$ref}" at ${path}`);
        }
        pending.push({ node: target, path: `${path} -> $defs.${match![1]}` });
      }
    }
  }
}
