import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The design system's one hard rule: every .ts, .tsx and .css file under client/src (GUARDED below)
// uses only the semantic tokens from index.css (bg-sheet, text-ink, text-meta …), never Tailwind's
// raw palette steps or default size names (bg-blue-600, text-gray-500, text-sm) or a hex colour in a
// class. docs/design-system.md, "Do not".

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GUARDED = ["src"];

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black";
const PREFIX = "bg|text|border|border-[trblxy]|ring|ring-offset|outline|fill|stroke|decoration|divide|from|via|to|shadow|accent|caret|placeholder";
const RAW_COLOUR = new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:${PREFIX})-(?:${PALETTE})(?:-\\d{2,3})?(?:/\\d+)?(?![\\w-])`, "g");
const RAW_SIZE = /(?<![\w-])(?:[a-z-]+:)*text-(?:xs|sm|base|lg|[2-9]?xl)(?![\w-])/g;
const HEX_IN_CLASS = /className=["{`][^"}`]*#[0-9a-fA-F]{3,8}/g;

function files(rel: string): string[] {
  const abs = path.join(CLIENT, rel);
  if (fs.statSync(abs).isFile()) return [abs];
  return fs
    .readdirSync(abs, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(tsx?|css)$/.test(f))
    .map((f) => path.join(abs, f));
}

describe("client code uses design tokens only", () => {
  const all = GUARDED.flatMap(files);

  it("finds the files it is meant to guard", () => {
    expect(all.some((f) => f.endsWith(path.join("ui", "BandFigure.tsx")))).toBe(true);
    expect(all.length).toBeGreaterThan(150);
  });

  it.each(all.map((f) => [path.relative(CLIENT, f), f]))("%s has no raw palette colours, default text sizes or hex classes", (_rel, file) => {
    const src = fs.readFileSync(file, "utf8");
    expect(src.match(RAW_COLOUR) ?? []).toEqual([]);
    expect(src.match(RAW_SIZE) ?? []).toEqual([]);
    expect(src.match(HEX_IN_CLASS) ?? []).toEqual([]);
  });

  it("the guard itself catches what it is meant to", () => {
    expect("x bg-blue-600 y".match(RAW_COLOUR)).toEqual(["bg-blue-600"]);
    expect("hover:text-gray-500".match(RAW_COLOUR)).toEqual(["hover:text-gray-500"]);
    expect("bg-white/80".match(RAW_COLOUR)).toEqual(["bg-white/80"]);
    expect("text-sm sm:text-lg".match(RAW_SIZE)).toEqual(["text-sm", "sm:text-lg"]);
    expect("bg-sheet text-ink text-meta border-rule text-accent-strong".match(RAW_COLOUR)).toBeNull();
    expect("text-balance text-pretty text-figure-lg".match(RAW_SIZE)).toBeNull();
  });
});
