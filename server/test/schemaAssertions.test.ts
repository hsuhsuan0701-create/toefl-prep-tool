import { z } from "zod";
import { describe, expect, it } from "vitest";
import { collectSchemaKeys, expectEveryObjectPropertyRequired } from "./schemaAssertions.js";

// collectSchemaKeys on small synthetic schemas, independent of what the Listening and Reading schemas
// look like. A schema-driven leak scan is only as trustworthy as the walker's coverage of JSON Schema
// constructs: one it skips silently is as much a blind spot as a key no fixture populates.

describe("collectSchemaKeys", () => {
  it("walks nested objects and arrays, collecting every property key regardless of depth", () => {
    const schema = z.object({
      id: z.string(),
      items: z.array(z.object({ nested: z.string() })),
    });
    expect(collectSchemaKeys(z.toJSONSchema(schema))).toEqual(new Set(["id", "items", "nested"]));
  });

  it("walks a discriminated union's oneOf branches", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("gap"), gapId: z.string() }),
    ]);
    expect(collectSchemaKeys(z.toJSONSchema(schema))).toEqual(new Set(["type", "text", "gapId"]));
  });

  it("walks a tuple's prefixItems", () => {
    const schema = z.object({ pair: z.tuple([z.string(), z.object({ nested: z.string() })]) });
    expect(collectSchemaKeys(z.toJSONSchema(schema))).toEqual(new Set(["pair", "nested"]));
  });

  // A schema used in more than one place and given `.meta({id})` (an ordinary way to dedupe the JSON
  // Schema shown to a model) becomes `$ref: "#/$defs/<id>"` at each use instead of being inlined. A
  // walker that did not follow the ref would never see a field on it, here `secret`.
  it("resolves $ref into $defs — the shape a .meta({id}) schema reused in multiple places produces", () => {
    const Reused = z.object({ id: z.string(), secret: z.string() }).meta({ id: "Reused" });
    const schema = z.object({
      a: Reused,
      b: z.array(Reused),
    });
    const keys = collectSchemaKeys(z.toJSONSchema(schema));
    expect(keys).toContain("secret"); // proves $ref resolution actually reaches the referenced fields
    expect(keys).toEqual(new Set(["a", "b", "id", "secret"]));
  });

  // A keyword the walker has no classification for must throw, not return an incomplete key set.
  // Raw JSON Schema rather than zod output, so the test does not depend on what zod emits.
  it("throws on a JSON Schema keyword it has no classification for, rather than silently skipping it", () => {
    const unclassified = { type: "object", patternProperties: { "^x-": { type: "string" } } };
    expect(() => collectSchemaKeys(unclassified)).toThrow(/patternProperties/);
  });

  // z.record() and .catchall() put a schema in `additionalProperties` (an open-ended key space) where
  // z.object() puts a boolean. Unsupported, and unused in the Listening and Reading schemas, so it
  // throws.
  it("throws on z.record()'s additionalProperties-as-schema construct", () => {
    const schema = z.object({ id: z.string(), extras: z.record(z.string(), z.string()) });
    expect(() => collectSchemaKeys(z.toJSONSchema(schema))).toThrow(/additionalProperties/);
  });

  it("throws on .catchall()'s additionalProperties-as-schema construct", () => {
    const schema = z.object({ id: z.string() }).catchall(z.string());
    expect(() => collectSchemaKeys(z.toJSONSchema(schema))).toThrow(/additionalProperties/);
  });

  // A recursive schema without .meta({id}) refers to itself with a bare "#" rather than a
  // "#/$defs/<name>" ref. The walker does not resolve that form (the Listening and Reading schemas
  // never use it), so it throws rather than skipping the recursive branch.
  it("throws on an unresolvable $ref (a bare root self-reference, the shape z.lazy() uses)", () => {
    const Category: z.ZodType = z.object({
      name: z.string(),
      get subcategories() {
        return z.array(Category);
      },
    });
    expect(() => collectSchemaKeys(z.toJSONSchema(Category))).toThrow(/\$ref/);
  });
});

// expectEveryObjectPropertyRequired guards the strict structured-output schemas sent with a model
// call, where an optional property is a refused schema. An object it never reaches is an object it
// never checks, so each subschema position below hides one optional property and must fail.
describe("expectEveryObjectPropertyRequired", () => {
  const strict = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  const loose = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false };

  it("passes a schema whose every object requires all of its properties", () => {
    expect(() => expectEveryObjectPropertyRequired({
      type: "object",
      properties: { one: strict, many: { type: "array", items: strict }, either: { oneOf: [strict, strict] } },
      required: ["one", "many", "either"],
    })).not.toThrow();
  });

  it.each([
    ["a nested property", { type: "object", properties: { x: loose }, required: ["x"] }],
    ["an array's items", { type: "array", items: loose }],
    ["a tuple's prefixItems", { type: "array", prefixItems: [strict, loose] }],
    ["an anyOf branch", { anyOf: [loose, { type: "null" }] }],
    ["a oneOf branch (a discriminated union)", { oneOf: [strict, loose] }],
    ["an allOf branch", { allOf: [loose] }],
    ["a $defs entry reached through $ref", { type: "object", properties: { x: { $ref: "#/$defs/Loose" } }, required: ["x"], $defs: { Loose: loose } }],
  ])("finds an optional property inside %s", (_where, schema) => {
    expect(() => expectEveryObjectPropertyRequired(schema)).toThrow();
  });

  it("finds an optional property in what zod emits for a discriminated union", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("gap"), gapId: z.string().optional() }),
    ]);
    expect(() => expectEveryObjectPropertyRequired(z.toJSONSchema(schema))).toThrow();
  });

  it("throws on a $ref it cannot resolve rather than leaving its target unchecked", () => {
    expect(() => expectEveryObjectPropertyRequired({ $ref: "#/definitions/Elsewhere" })).toThrow(/unresolvable \$ref/);
  });
});
