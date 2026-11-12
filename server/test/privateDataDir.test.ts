import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { config } from "../src/lib/config.js";
import { privateDataDir } from "./helpers/privateDataDir.js";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "private-data-dir-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("each test file's own data directory", () => {
  it("is a copy of the seeded bank inside this run's directory, never the template every file is copied from", () => {
    const runDir = inject("testRunDir");
    const template = inject("testDataTemplate");
    expect(config.dataDir).not.toBe(template);
    expect(path.dirname(config.dataDir)).toBe(runDir);
    const setFiles = (root: string) => fs.readdirSync(path.join(root, "question-sets/speaking")).sort();
    expect(setFiles(config.dataDir)).toEqual(setFiles(template));
  });

  it("copies the whole tree, and a write into one copy reaches neither the template nor another copy", () => {
    const template = path.join(scratch, "template");
    fs.mkdirSync(path.join(template, "question-sets/writing"), { recursive: true });
    fs.writeFileSync(path.join(template, "question-sets/writing/wri-a.json"), "{}");

    const first = privateDataDir(template, scratch);
    const second = privateDataDir(template, scratch);
    expect(first).not.toBe(second);
    expect(fs.readFileSync(path.join(first, "question-sets/writing/wri-a.json"), "utf8")).toBe("{}");

    fs.writeFileSync(path.join(first, "question-sets/writing/wri-a.json"), "changed");
    fs.writeFileSync(path.join(first, "question-sets/writing/corrupt.json"), "{ not json");

    expect(fs.readFileSync(path.join(template, "question-sets/writing/wri-a.json"), "utf8")).toBe("{}");
    expect(fs.readdirSync(path.join(template, "question-sets/writing"))).toEqual(["wri-a.json"]);
    expect(fs.readFileSync(path.join(second, "question-sets/writing/wri-a.json"), "utf8")).toBe("{}");
    expect(fs.readdirSync(path.join(second, "question-sets/writing"))).toEqual(["wri-a.json"]);
  });
});
