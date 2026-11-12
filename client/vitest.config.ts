import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// This suite is the only automated coverage of the browser layer. jsdom cannot exercise a real
// microphone or a real audio element, but it can hold the state machines around them honest: mic
// permission recovery, upload failure classification, tile drag.
export default defineConfig({
  plugins: [react()],
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
