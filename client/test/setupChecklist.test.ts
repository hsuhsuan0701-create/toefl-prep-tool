import { describe, expect, it } from "vitest";
import { setupRows, setupSummary, type Instruction, type SetupStatus } from "../src/components/setup/setupChecklist";

// The Setup checklist says, for each piece of this installation, where it stands, what it is for and
// exactly what to do when it is missing — read off GET /api/setup-status, never assumed.

const text = (detail: Instruction) => detail.map((part) => (typeof part === "string" ? part : part.code)).join("");

/** A fresh clone with no key, no CLI, and ffmpeg installed (what the endpoint reports for it). */
const FRESH: SetupStatus = {
  rubrics: { source: "rewritten" },
  claudeCli: "not-installed",
  codexCli: "not-installed",
  geminiApiKey: false,
  openaiApiKey: false,
  geminiJudgeModel: true,
  openaiJudgeModel: true,
  ffmpeg: true,
  ffprobe: true,
  capabilities: {
    "reading-writing-generation": false,
    "speaking-listening-generation": false,
    "writing-scoring": false,
    "speaking-scoring": false,
    "speaking-uploads": true,
  },
  missing: [
    { piece: "claude-cli", disables: ["reading-writing-generation", "speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "codex-cli", disables: ["reading-writing-generation", "speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "gemini-api-key", disables: ["speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "openai-api-key", disables: ["writing-scoring"] },
  ],
};

const ALL_READY: SetupStatus = {
  ...FRESH,
  claudeCli: "ready",
  codexCli: "ready",
  geminiApiKey: true,
  openaiApiKey: true,
  capabilities: {
    "reading-writing-generation": true,
    "speaking-listening-generation": true,
    "writing-scoring": true,
    "speaking-scoring": true,
    "speaking-uploads": true,
  },
  missing: [],
};

const row = (status: SetupStatus, key: string) => {
  const found = setupRows(status).find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};

describe("setupRows", () => {
  it("leads with Reading and Listening, ready with nothing set up", () => {
    const first = setupRows(FRESH)[0];
    expect(first).toMatchObject({ name: "Reading and Listening", state: "ready" });
    expect(text(first.detail)).toMatch(/no key and no sign-in/);
  });

  it("names the env variable to add for a missing key, and what is off until then", () => {
    const gemini = row(FRESH, "gemini");
    expect(gemini.state).toBe("missing");
    expect(gemini.detail).toContainEqual({ code: "GEMINI_API_KEY" });
    expect(text(gemini.detail)).toMatch(/restart the server/);
    expect(text(gemini.detail)).toMatch(/no Writing scoring/);
  });

  it("says one reasoning CLI is enough when neither is set up", () => {
    expect(text(row(FRESH, "claude-cli").detail)).toMatch(/Either Claude Code or the Codex CLI is enough/);
    expect(text(row(FRESH, "codex-cli").detail)).toMatch(/Either Claude Code or the Codex CLI is enough/);
  });

  it("says how to sign in a CLI that is installed but logged out", () => {
    const status: SetupStatus = { ...FRESH, claudeCli: "not-logged-in" };
    expect(text(row(status, "claude-cli").detail)).toMatch(/Run claude in a terminal and log in/);
    expect(row({ ...FRESH, codexCli: "not-logged-in" }, "codex-cli").detail).toContainEqual({ code: "codex login" });
  });

  it("marks a piece Optional when another present piece covers its job", () => {
    const status: SetupStatus = {
      ...ALL_READY,
      codexCli: "not-installed",
      missing: [{ piece: "codex-cli", disables: [] }],
    };
    expect(row(status, "codex-cli").state).toBe("optional");
    expect(text(row(status, "codex-cli").detail)).toMatch(/Claude is signed in/);
  });

  it("says a CLI is being checked rather than missing while its check has not answered", () => {
    const status: SetupStatus = { ...ALL_READY, claudeCli: "checking", capabilities: { ...ALL_READY.capabilities } };
    expect(row(status, "claude-cli").state).toBe("checking");
  });

  it("names both missing audio tools, and that ffmpeg brings ffprobe", () => {
    const status: SetupStatus = {
      ...ALL_READY,
      ffmpeg: false,
      ffprobe: false,
      missing: [
        { piece: "ffmpeg", disables: ["speaking-uploads"] },
        { piece: "ffprobe", disables: ["speaking-listening-generation"] },
      ],
    };
    const tools = row(status, "audio-tools");
    expect(tools.state).toBe("missing");
    expect(text(tools.detail)).toMatch(/ffmpeg and ffprobe are not on the server's PATH/);
  });

  it("says which rubric text scoring uses, and how to switch to the official one", () => {
    expect(row({ ...ALL_READY, rubrics: { source: "official" } }, "rubrics").state).toBe("ready");
    const rewritten = row({ ...ALL_READY, rubrics: { source: "rewritten" } }, "rubrics");
    expect(rewritten.state).toBe("optional");
    expect(text(rewritten.detail)).toMatch(/own description of ETS's published criteria/);
    expect(text(rewritten.detail)).toMatch(/docs\/official-rubrics\.md/);
  });
});

describe("setupSummary", () => {
  it("says everything is set up when nothing is off", () => {
    expect(setupSummary(ALL_READY)).toBe("Everything is set up.");
  });

  it("names what this machine cannot do yet", () => {
    expect(setupSummary(FRESH)).toBe(
      "Not available on this machine yet: Writing scoring, Speaking scoring, new Reading or Writing Sets and new Speaking or Listening Sets.",
    );
  });

  it("says it is still checking when nothing is known to be missing", () => {
    expect(
      setupSummary({ ...ALL_READY, claudeCli: "checking", codexCli: "checking", capabilities: { ...ALL_READY.capabilities, "writing-scoring": false } }),
    ).toBe("Still checking what this machine can do.");
  });
});
