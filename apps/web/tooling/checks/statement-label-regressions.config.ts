import { resolve } from "node:path";
import { mergeConfig } from "vitest/config";
import benchmark from "./statement-label-benchmark.config.ts";

// Run the existing service regressions against fresh retained databases,
// without the ordinary integration harness's between-case resets.
export default mergeConfig(benchmark, {
  resolve: {
    alias: [
      {
        find: "tooling/test-setup",
        replacement: resolve(
          import.meta.dirname,
          "statement-label-retained.setup.ts",
        ),
      },
    ],
  },
  test: {
    include: [
      "src/server/domains/transaction-import/repo/statement-suggestions.integration.test.ts",
    ],
    exclude: ["**/statement-label.benchmark.ts"],
    hookTimeout: 180_000,
  },
});
