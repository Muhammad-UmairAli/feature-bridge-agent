import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Resolve the @/* alias from tsconfig.json (built into Vite).
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Only the app's own sources; keeps runs fast and scoped.
    include: ["src/**/*.test.{ts,tsx}", "agents/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "agents/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}"],
    },
  },
});
