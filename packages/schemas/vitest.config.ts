import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    // The zod-validates-zod contract tests were pruned; the schemas are now
    // exercised transitively (typecheck + apps/web integration/e2e). Keep the
    // runner green until a test with real branching logic is reintroduced here.
    passWithNoTests: true,
    environment: "node",
    typecheck: {
      enabled: true,
    },
  },
});
