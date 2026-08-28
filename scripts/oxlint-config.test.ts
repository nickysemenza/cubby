import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("service files retain the repository import boundary", () => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "oxlint",
      "--print-config",
      "apps/web/src/server/services/scan-plan.ts",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const config = z
    .object({
      overrides: z
        .array(
          z.object({
            files: z.array(z.string()).optional(),
            rules: z.record(z.string(), z.json()).optional(),
          }),
        )
        .optional(),
    })
    .parse(JSON.parse(result.stdout));
  const serviceOverride = config.overrides?.find((override) =>
    override.files?.includes("apps/web/src/server/services/**/*.ts"),
  );
  assert.ok(serviceOverride, "missing service-file override");
  assert.deepEqual(serviceOverride.rules?.["no-restricted-imports"], [
    "deny",
    [
      {
        paths: [
          {
            name: "~/server/repo/database-helpers",
            message:
              "Services cannot access DB helpers directly. Use repo functions instead.",
          },
          {
            name: "~/server/db/schema",
            message:
              "Services cannot access DB schema directly. Use repo functions instead.",
          },
        ],
      },
    ],
  ]);
});
