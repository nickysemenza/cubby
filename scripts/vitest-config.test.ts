import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(
  join(repoRoot, "apps/web/vitest.config.ts"),
  "utf8",
);
const e2eDatabase = readFileSync(
  join(repoRoot, "apps/web/tests/e2e/e2e-database.ts"),
  "utf8",
);

test("database projects are registered only by explicit selectors", () => {
  assert.match(
    config,
    /project\.test\.name === "integration"\) return wantsIntegrationTier\(\)/u,
  );
  assert.doesNotMatch(config, /pglite/iu);
});

test("concurrent PostgreSQL and browser tiers use separate IntegreSQL templates", () => {
  assert.match(e2eDatabase, /"\.\/tests\/e2e\/e2e-database\.ts"/u);
});
