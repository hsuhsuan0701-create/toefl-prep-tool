import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The API server's port, resolved the way the server resolves it: `tsx --env-file=../.env` keeps a
// PORT the shell already set, otherwise takes the repo-root .env's, otherwise 8787. Only that one
// file is read, because it is the only one the server reads.
function apiPort(): string {
  if (process.env.PORT !== undefined) return process.env.PORT;
  try {
    return parseEnv(fs.readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8")).PORT ?? "8787";
  } catch {
    return "8787";
  }
}

// 127.0.0.1 because that is the only address the server binds. changeOrigin stays off so the server
// sees the browser's own Host and Origin, which is what its local-only guard checks.
const proxy = { "/api": { target: `http://127.0.0.1:${apiPort()}` } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
});
