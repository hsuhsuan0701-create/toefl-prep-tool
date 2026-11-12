#!/bin/bash
# Test double for the Claude CLI. Behavior is selected only by prompt markers.
INPUT=$(cat)
if [[ "$INPUT" == *"[FAKE_CLAUDE:INVALID_THEN_GOOD]"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:SLOW_INVALID_THEN_GOOD]"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:NULL_THEN_GOOD]"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:NULL_ALWAYS]"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:OVERSIZE_THEN_GOOD:"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:OVERSIZE_ALWAYS]"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:LARGE_STREAM]"* ]] ||
   [[ "$INPUT" == *"[FAKE_CLAUDE:ALWAYS_INVALID]"* ]]; then
  printf 'attempt\n' >> "/tmp/fake-claude-attempts-${TOEFL_ATTEMPT_OWNER_PID:-$PPID}"
fi

structured() {
  printf '{"type":"result","subtype":"success","structured_output":%s}\n' "$1"
}

start_heartbeat_descendant() {
  local heartbeat_path="$1"
  node -e '
    const fs = require("node:fs");
    const heartbeatPath = process.argv[1];
    fs.writeFileSync(heartbeatPath, String(process.pid) + "\n.");
    setInterval(() => fs.appendFileSync(heartbeatPath, "."), 10);
  ' "$heartbeat_path" >/dev/null 2>&1 &
  for ((check = 0; check < 100; check += 1)); do
    if [[ -s "$heartbeat_path" ]]; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

emit_oversize_structured_output() {
  node -e '
    const fs = require("node:fs");
    const prefix = Buffer.from(
      "{\"type\":\"result\",\"subtype\":\"success\",\"structured_output\":{\"echo\":\"secret-claude-oversize-"
    );
    const suffix = Buffer.from("\"}}\n");
    fs.writeSync(1, prefix);
    let remaining = 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, "x");
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      fs.writeSync(1, chunk, 0, length);
      remaining -= length;
    }
    fs.writeSync(1, suffix);
  '
}

# A valid stream-json response many pipe buffers long, with the result envelope last,
# exactly as `--output-format stream-json` emits it. writeSync blocks until the kernel
# accepts every byte, so this CLI never drops its own output: anything the caller fails
# to see was lost downstream. Stays under cliProcess's 1 MiB structured-output ceiling
# so it stands for a successful response, not the overflow path.
emit_large_stream() {
  node -e '
    const fs = require("node:fs");
    const filler = "y".repeat(64 * 1024);
    for (let index = 0; index < 10; index += 1) {
      fs.writeSync(1, JSON.stringify({ type: "assistant", message: { content: filler } }) + "\n");
    }
    fs.writeSync(1, JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: { echo: "large-stream", body: "z".repeat(64 * 1024) },
    }) + "\n");
  '
}

if [[ "$INPUT" == *"[FAKE_CLAUDE:INSPECT]"* ]]; then
  INSPECTION=$(node -e '
    const inheritedSecrets = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "TOEFL_ARBITRARY_APP_SECRET",
      "FAKE_CLAUDE_MODE",
    ].filter((name) => process.env[name] !== undefined);
    process.stdout.write(JSON.stringify({
      argv: process.argv.slice(1),
      cwd: process.cwd(),
      inheritedSecrets,
      disableBundledSkills: process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS ?? null,
      disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
      disableAutoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    }));
  ' -- "$@")
  structured "$INSPECTION"
elif [[ "$INPUT" == *"[FAKE_CLAUDE:INVALID_THEN_GOOD]"* ]]; then
  if [[ "$INPUT" == "Your previous output was invalid"* ]]; then
    structured '{"echo":"retried"}'
  else
    echo "garbage not json"
  fi
elif [[ "$INPUT" == *"[FAKE_CLAUDE:SLOW_INVALID_THEN_GOOD]"* ]]; then
  sleep 0.15
  if [[ "$INPUT" == "Your previous output was invalid"* ]]; then
    structured '{"echo":"retried slowly"}'
  else
    echo "garbage not json"
  fi
elif [[ "$INPUT" == *"[FAKE_CLAUDE:NULL_THEN_GOOD]"* ]]; then
  if [[ "$INPUT" == "Your previous output was invalid"* ]]; then
    structured '{"echo":"retried after null"}'
  else
    echo "null"
  fi
elif [[ "$INPUT" == *"[FAKE_CLAUDE:NULL_ALWAYS]"* ]]; then
  echo "null"
elif [[ "$INPUT" == *"[FAKE_CLAUDE:OVERSIZE_THEN_GOOD:"* ]]; then
  if [[ "$INPUT" == "Your previous output was invalid"* ]]; then
    structured '{"echo":"retried after oversize"}'
  else
    TREE_MARKER=$(printf '%s\n' "$INPUT" | sed -n 's/.*\[FAKE_CLAUDE:OVERSIZE_THEN_GOOD:\([^]]*\)\].*/\1/p')
    start_heartbeat_descendant "$TREE_MARKER"
    emit_oversize_structured_output
  fi
elif [[ "$INPUT" == *"[FAKE_CLAUDE:OVERSIZE_ALWAYS]"* ]]; then
  emit_oversize_structured_output
elif [[ "$INPUT" == *"[FAKE_CLAUDE:LARGE_STREAM]"* ]]; then
  if [[ "$INPUT" == "Your previous output was invalid"* ]]; then
    # Only reachable when the first response was truncated; names the burnt repair.
    structured '{"echo":"repaired-after-truncation"}'
  else
    emit_large_stream
  fi
elif [[ "$INPUT" == *"[FAKE_CLAUDE:ALWAYS_INVALID]"* ]]; then
  echo "garbage not json"
elif [[ "$INPUT" == *"[FAKE_CLAUDE:QUOTA]"* ]]; then
  echo "quota exceeded; secret-claude-diagnostic" >&2
  exit 1
elif [[ "$INPUT" == *"[FAKE_CLAUDE:RATE_LIMIT]"* ]]; then
  echo "429 rate limit; secret-claude-diagnostic" >&2
  exit 1
elif [[ "$INPUT" == *"[FAKE_CLAUDE:AUTHENTICATION]"* ]]; then
  echo "authentication failed; secret-claude-diagnostic" >&2
  exit 1
elif [[ "$INPUT" == *"[FAKE_CLAUDE:PROVIDER_FAILURE]"* ]]; then
  echo "upstream exploded; secret-claude-diagnostic" >&2
  exit 17
elif [[ "$INPUT" == *"[FAKE_CLAUDE:TREE_HANG:"* ]]; then
  TREE_MARKER=$(printf '%s\n' "$INPUT" | sed -n 's/.*\[FAKE_CLAUDE:TREE_HANG:\([^]]*\)\].*/\1/p')
  start_heartbeat_descendant "$TREE_MARKER"
  sleep 27.7
elif [[ "$INPUT" == *"[FAKE_CLAUDE:HANG]"* ]]; then
  sleep 27.6
elif [[ "$INPUT" == *"[FAKE_CLAUDE:EXIT_FAST]"* ]]; then
  exit 1
elif [[ "$INPUT" == *"[FAKE_CLAUDE:STREAM:"* ]]; then
  # [FAKE_CLAUDE:STREAM:<stream-file>:<exit-code>] replays a stream-json transcript verbatim, so a
  # test can feed the runner real event lines and a chosen exit status.
  SPEC=$(printf '%s\n' "$INPUT" | sed -n 's/.*\[FAKE_CLAUDE:STREAM:\([^]]*\)\].*/\1/p')
  cat "${SPEC%:*}"
  exit "${SPEC##*:}"
elif [[ "$INPUT" == *"[FAKE_CLAUDE:FROM_FILE:"* ]]; then
  OUTPUT_FILE=$(printf '%s\n' "$INPUT" | sed -n 's/.*\[FAKE_CLAUDE:FROM_FILE:\([^]]*\)\].*/\1/p')
  structured "$(cat "$OUTPUT_FILE")"
else
  structured '{"echo":"ok"}'
fi
