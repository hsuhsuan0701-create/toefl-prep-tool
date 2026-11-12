import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  JudgeReportSchema,
  SpeakingGenerationInputSchema,
  SpeakingGenerationPlanSchema,
  WritingGenerationInputSchema,
  WritingGenerationPlanSchema,
} from "@toefl-prep/shared";
import { projectRoot } from "../src/lib/config.js";
import { ArbitrationReasoningSchema } from "../src/services/arbiter.js";
import { VerifierSchema } from "../src/services/generator.js";
import { isCodexStrictOutputSchema } from "../src/services/reasoning/codexRunner.js";
import {
  normalizeProviderJsonSchema,
  toProviderJsonSchema,
  type ProviderSchemaInput,
} from "../src/services/reasoning/jsonSchema.js";

type ZodJsonSchemaInput = ProviderSchemaInput;

const SERVER_SRC = path.join(projectRoot, "server", "src");
/** The one file allowed to call zod's converter: it is what applies the rewrite. */
const CONVERTER = path.join(SERVER_SRC, "services", "reasoning", "jsonSchema.ts");

/** Prose that merely names the converter is not a call, so comments must not trip the guard. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function typescriptSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return typescriptSources(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

describe("toProviderJsonSchema", () => {
  it("rewrites a fixed-length tuple into an array both CLI providers accept", () => {
    const schema = z.object({
      arc: z.tuple([z.string(), z.string(), z.string()]),
    });

    const json = toProviderJsonSchema(schema) as Record<string, never>;

    expect(JSON.stringify(json)).not.toContain("prefixItems");
    expect(json).toMatchObject({
      properties: {
        arc: {
          type: "array",
          items: { type: "string" },
          minItems: 3,
          maxItems: 3,
        },
      },
    });
  });

  it("keeps every member type of a mixed tuple reachable", () => {
    const schema = z.object({
      pair: z.tuple([z.string(), z.number()]),
    });

    const json = toProviderJsonSchema(schema) as Record<string, never>;

    expect(JSON.stringify(json)).not.toContain("prefixItems");
    expect(json).toMatchObject({
      properties: {
        pair: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] },
          minItems: 2,
          maxItems: 2,
        },
      },
    });
  });

  it("leaves an open-ended tuple's tail unbounded and reachable", () => {
    const schema = z.object({
      row: z.tuple([z.string()]).rest(z.number()),
    });

    const json = toProviderJsonSchema(schema) as Record<string, never>;

    expect(JSON.stringify(json)).not.toContain("prefixItems");
    expect(json).toMatchObject({
      properties: {
        row: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] },
          minItems: 1,
        },
      },
    });
    const row = (json as unknown as {
      properties: { row: Record<string, unknown> };
    }).properties.row;
    expect(row).not.toHaveProperty("maxItems");
  });
});

// zod's converter has spelled a closed tuple and a nullable value in two ways each across its
// releases. The providers were only ever sent one of them, so both spellings must leave as that one.
describe("normalizeProviderJsonSchema", () => {
  it("writes a closed tuple the same way with or without `items: false`", () => {
    const bounded = { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 };

    expect(normalizeProviderJsonSchema({ type: "array", prefixItems: [{ type: "string" }, { type: "string" }] })).toEqual(bounded);
    expect(
      normalizeProviderJsonSchema({ type: "array", prefixItems: [{ type: "string" }, { type: "string" }], items: false, minItems: 2, maxItems: 2 }),
    ).toEqual(bounded);
  });

  it("writes a nullable value as an anyOf with a null member, constraints on the member they apply to", () => {
    expect(normalizeProviderJsonSchema({ type: ["string", "null"], maxLength: 9, description: "a rewrite, or null" })).toEqual({
      description: "a rewrite, or null",
      anyOf: [{ type: "string", maxLength: 9 }, { type: "null" }],
    });
    expect(normalizeProviderJsonSchema({ anyOf: [{ type: "string", maxLength: 9 }, { type: "null" }] })).toEqual({
      anyOf: [{ type: "string", maxLength: 9 }, { type: "null" }],
    });
  });

  it("keeps null out of a nullable enum's value list", () => {
    expect(normalizeProviderJsonSchema({ type: ["string", "null"], enum: ["low", "high", null] })).toEqual({
      anyOf: [{ type: "string", enum: ["low", "high"] }, { type: "null" }],
    });
  });

  it("rewrites inside nested properties and array members", () => {
    expect(
      normalizeProviderJsonSchema({
        type: "object",
        properties: { rows: { type: "array", items: { type: ["number", "null"] } } },
      }),
    ).toEqual({
      type: "object",
      properties: { rows: { type: "array", items: { anyOf: [{ type: "number" }, { type: "null" }] } } },
    });
  });
});

/**
 * Every schema this server hands to a reasoning provider. A tuple in any of them fails both CLIs
 * before the model sees the prompt, reported only as the generic `provider` failure kind, so each
 * is checked against the constraints both providers enforce.
 */
const ROUTED_SCHEMAS: readonly (readonly [string, ZodJsonSchemaInput])[] = [
  ["speaking plan", SpeakingGenerationPlanSchema],
  ["writing plan", WritingGenerationPlanSchema],
  ["speaking candidate", SpeakingGenerationInputSchema],
  ["writing candidate", WritingGenerationInputSchema],
  ["build-a-sentence verifier", VerifierSchema],
  ["arbitration", ArbitrationReasoningSchema],
  ["judge report", JudgeReportSchema],
];

function providerViolations(root: object): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("prefixItems" in record) {
      found.push(`${at}: prefixItems is rejected by the Claude CLI validator`);
    }
    if ("$schema" in record) {
      found.push(`${at}: $schema is rejected by the Claude CLI validator`);
    }
    if (record.type === "array" && record.items === undefined) {
      found.push(`${at}: array without items is rejected by OpenAI`);
    }
    if (Array.isArray(record.type)) {
      found.push(`${at}: a type list has never been sent to either provider; nullable is an anyOf`);
    }
    if (record.items === false) {
      found.push(`${at}: \`items: false\` has never been sent to either provider`);
    }
    for (const [key, value] of Object.entries(record)) walk(value, `${at}.${key}`);
  };
  walk(root, "$");
  return found;
}

describe("routed reasoning schemas", () => {
  it.each(ROUTED_SCHEMAS)(
    "%s converts to a schema both providers accept",
    (_name, schema) => {
      const json = toProviderJsonSchema(schema);

      expect(providerViolations(json)).toEqual([]);
      expect(isCodexStrictOutputSchema(json)).toBe(true);
    },
  );
});

describe("structured reasoning schema conversion", () => {
  it("is the only way production code converts a schema for a provider", () => {
    const offenders = typescriptSources(SERVER_SRC)
      .filter((file) => file !== CONVERTER)
      .filter((file) =>
        withoutComments(fs.readFileSync(file, "utf8")).includes("z.toJSONSchema("),
      )
      .map((file) => path.relative(projectRoot, file));

    expect(offenders).toEqual([]);
  });
});
