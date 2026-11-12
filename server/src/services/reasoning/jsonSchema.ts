import { z } from "zod";

/**
 * `z.toJSONSchema` is overloaded (schema or registry); naming the schema arm directly keeps
 * callers from resolving to the registry overload.
 */
export type ProviderSchemaInput = z.core.$ZodType;

/**
 * Every structured reasoning route hands its JSON Schema to a CLI provider, and both
 * providers reject a zod tuple's draft-2020-12 `prefixItems`: the Claude CLI's validator
 * fails the whole schema with "unknown keyword", and the OpenAI structured-output API
 * answers 400 "array schema missing items". Both refusals land before any model sees the
 * prompt, and the route reports only the generic `provider` failure kind, so an unrewritten
 * tuple reads as a provider outage. Rewrite it to the bounded-array form both accept; the
 * zod `parse` at the boundary still enforces the exact tuple.
 *
 * The result is the same whichever way the installed zod spells a construct. zod has written a
 * closed tuple both with and without `items: false`, and a nullable value both as
 * `anyOf: [T, { type: "null" }]` and as `type: [T, "null"]`; the providers have only ever been
 * sent the `anyOf` form and a tuple without a boolean schema, so those are the forms that leave
 * here.
 */
export function toProviderJsonSchema(schema: ProviderSchemaInput): object {
  return normalizeProviderJsonSchema(z.toJSONSchema(schema)) as object;
}

/** The rewrite itself, over a JSON Schema document in any of the spellings zod has produced. */
export function normalizeProviderJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeProviderJsonSchema);
  if (node === null || typeof node !== "object") return node;

  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    rewritten[key] = normalizeProviderJsonSchema(value);
  }

  const prefixItems = rewritten.prefixItems;
  if (Array.isArray(prefixItems)) {
    delete rewritten.prefixItems;
    // A `.rest()` tuple emits its open tail as `items` beside the fixed prefix. That tail
    // is a real member type, and it is what makes the array unbounded. `items: false` is the
    // other spelling of "no tail".
    const tail = rewritten.items === false ? undefined : rewritten.items;
    rewritten.items = unifyMembers(
      tail === undefined ? prefixItems : [...prefixItems, tail],
    );
    rewritten.minItems = prefixItems.length;
    if (tail === undefined) rewritten.maxItems = prefixItems.length;
  }
  return Array.isArray(rewritten.type) ? splitTypeUnion(rewritten, rewritten.type) : rewritten;
}

/** Keywords that describe a value rather than constrain it; they stay beside the `anyOf`. */
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples", "deprecated", "readOnly", "writeOnly"]);

/**
 * `{ type: ["string", "null"], maxLength: 9 }` becomes
 * `{ anyOf: [{ type: "string", maxLength: 9 }, { type: "null" }] }`: one member per type, the
 * constraints on the members they can apply to.
 */
function splitTypeUnion(node: Record<string, unknown>, types: readonly unknown[]): Record<string, unknown> {
  const annotations: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") continue;
    (ANNOTATION_KEYWORDS.has(key) ? annotations : constraints)[key] = value;
  }
  // An `enum` beside a type union lists null among its values; the null member needs no list.
  if (Array.isArray(constraints.enum)) constraints.enum = constraints.enum.filter((value) => value !== null);
  return {
    ...annotations,
    anyOf: types.map((type) => (type === "null" ? { type: "null" } : { ...constraints, type })),
  };
}

/**
 * `items` applies to every position, so a mixed tuple has to widen to the union of its
 * member types rather than to whichever type happens to sit first.
 */
function unifyMembers(members: readonly unknown[]): unknown {
  const unique: unknown[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const key = JSON.stringify(member);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(member);
  }
  return unique.length === 1 ? unique[0] : { anyOf: unique };
}
