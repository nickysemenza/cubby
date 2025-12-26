import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{unit,integration}.test.ts"],
    environment: "node",
    typecheck: {
      enabled: true,
    },
    env: {
      NODE_ENV: "test",
    },
  },
});
