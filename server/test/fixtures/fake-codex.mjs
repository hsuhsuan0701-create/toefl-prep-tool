#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const outputPath = valueAfter("--output-last-message");
const schemaPath = valueAfter("--output-schema");
if (!outputPath || !schemaPath) {
  process.stderr.write("fake codex invocation missing structured output paths");
  process.exit(64);
}

const attemptPath = path.join(process.cwd(), ".fake-codex-attempts");
let attemptCount = 0;
try {
  attemptCount = Number(await fs.promises.readFile(attemptPath, "utf8")) || 0;
} catch {
  // First attempt.
}
attemptCount += 1;
await fs.promises.writeFile(attemptPath, String(attemptCount));

const writeOutput = (value) =>
  fs.promises.writeFile(
    outputPath,
    typeof value === "string" ? value : JSON.stringify(value)
  );
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRepair = prompt.startsWith("Your previous output was invalid");
const writeOversizeValidOutput = async () => {
  await fs.promises.writeFile(
    outputPath,
    '{"echo":"secret-codex-oversize-must-not-leak"}'
  );
  await fs.promises.truncate(outputPath, 1024 * 1024 + 1);
};
const startHeartbeatDescendant = async (heartbeatPath) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const fs = require("node:fs");
        const heartbeatPath = process.argv[1];
        fs.writeFileSync(heartbeatPath, String(process.pid) + "\\n.");
        setInterval(() => fs.appendFileSync(heartbeatPath, "."), 10);
      `,
      heartbeatPath,
    ],
    { stdio: "ignore" }
  );
  child.unref();
  for (let check = 0; check < 100; check += 1) {
    try {
      if ((await fs.promises.stat(heartbeatPath)).size > 0) return;
    } catch {
      // The descendant has not written its first heartbeat yet.
    }
    await delay(10);
  }
  throw new Error(`heartbeat descendant did not start: ${heartbeatPath}`);
};

if (prompt.includes("[FAKE_CODEX:INSPECT]")) {
  const secretNames = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "TOEFL_ARBITRARY_APP_SECRET",
  ];
  await writeOutput({
    argv,
    cwd: process.cwd(),
    requestedCwd: valueAfter("--cd"),
    cwdMode: fs.statSync(process.cwd()).mode & 0o777,
    schemaMode: fs.statSync(schemaPath).mode & 0o777,
    outputMode: fs.statSync(outputPath).mode & 0o777,
    schema: JSON.parse(await fs.promises.readFile(schemaPath, "utf8")),
    inheritedSecrets: secretNames.filter((name) => process.env[name] !== undefined),
  });
} else if (prompt.includes("[FAKE_CODEX:INVALID_THEN_GOOD]")) {
  await writeOutput(isRepair ? { echo: "retried" } : { echo: 7 });
} else if (prompt.includes("[FAKE_CODEX:SLOW_INVALID_THEN_GOOD]")) {
  await delay(150);
  await writeOutput(isRepair ? { echo: "retried slowly" } : { echo: 7 });
} else if (prompt.includes("[FAKE_CODEX:OVERSIZE_THEN_GOOD]")) {
  if (isRepair) {
    await writeOutput({ echo: "retried after oversize" });
  } else {
    await writeOversizeValidOutput();
  }
} else if (prompt.includes("[FAKE_CODEX:OVERSIZE_ALWAYS]")) {
  await writeOversizeValidOutput();
} else if (prompt.includes("[FAKE_CODEX:OVERSIZE_TREE_ALWAYS:")) {
  const heartbeatBase = prompt.match(
    /\[FAKE_CODEX:OVERSIZE_TREE_ALWAYS:([^\]]+)\]/
  )?.[1];
  if (!heartbeatBase) throw new Error("missing oversize tree heartbeat path");
  await fs.promises.writeFile(`${heartbeatBase}.temp-dir`, process.cwd());
  await startHeartbeatDescendant(`${heartbeatBase}.${attemptCount}`);
  await writeOversizeValidOutput();
} else if (prompt.includes("[FAKE_CODEX:ALWAYS_INVALID]")) {
  await writeOutput(attemptCount >= 3 ? { echo: "third attempt must not run" } : "garbage");
} else if (prompt.includes("[FAKE_CODEX:QUOTA]")) {
  process.stderr.write("quota exceeded; secret-codex-diagnostic");
  process.exit(1);
} else if (prompt.includes("[FAKE_CODEX:RATE_LIMIT]")) {
  process.stderr.write("429 rate limit; secret-codex-diagnostic");
  process.exit(1);
} else if (prompt.includes("[FAKE_CODEX:AUTHENTICATION]")) {
  process.stderr.write("authentication failed; secret-codex-diagnostic");
  process.exit(1);
} else if (prompt.includes("[FAKE_CODEX:PROVIDER_FAILURE]")) {
  process.stderr.write("upstream exploded; secret-codex-diagnostic");
  process.exit(17);
} else if (prompt.includes("[FAKE_CODEX:SESSION_THEN_USAGE_LIMIT]")) {
  // A human-readable exec session the way the real CLI writes it to stderr: a banner, the echoed
  // prompt, model chatter, and only then the error that ended the run (its usage-limit wording is
  // the real CLI's).
  process.stderr.write(
    `OpenAI Codex (fake)\n--------\nworkdir: ${process.cwd()}\nsandbox: read-only\n--------\nuser\n${prompt}\n` +
    "thinking\nDrafting a reply about the login problem.\n" +
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits\n",
  );
  process.exit(1);
} else if (prompt.includes("[FAKE_CODEX:HANG]")) {
  await new Promise(() => setInterval(() => undefined, 1_000));
} else {
  const treeMarker = prompt.match(/\[FAKE_CODEX:TREE_HANG:([^\]]+)\]/)?.[1];
  if (treeMarker) {
    await startHeartbeatDescendant(treeMarker);
    await new Promise(() => setInterval(() => undefined, 1_000));
  } else {
    await writeOutput({ echo: "ok" });
  }
}
