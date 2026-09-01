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

function projectGroupOrder(name: string) {
  const projectStart = config.indexOf(`name: "${name}"`);
  assert.notEqual(projectStart, -1, `missing Vitest project ${name}`);

  const projectEnd = config.indexOf("\n          },", projectStart);
  assert.notEqual(projectEnd, -1, `missing end of Vitest project ${name}`);

  const match = /sequence: \{ groupOrder: (\d+) \}/u.exec(
    config.slice(projectStart, projectEnd),
  );
  assert.ok(match, `missing sequence group for Vitest project ${name}`);
  return Number(match[1]);
}

test("explicit mixed PGlite and PostgreSQL runs use distinct sequence groups", () => {
  assert.notEqual(
    projectGroupOrder("pglite-integration"),
    projectGroupOrder("integration"),
  );
});

test("database projects are registered only by explicit selectors", () => {
  assert.match(
    config,
    /project\.test\.name === "integration"\) return wantsIntegrationTier\(\)/u,
  );
  assert.match(
    config,
    /project\.test\.name === "pglite-integration"[\s\S]*return wantsPgliteTier\(\)/u,
  );
  assert.match(config, /explicitlySelectsProject\("pglite"\)/u);
  assert.match(config, /explicitlySelectsProject\("pglite-integration"\)/u);
});

test("concurrent PostgreSQL and browser tiers use separate IntegreSQL templates", () => {
  assert.match(e2eDatabase, /"\.\/tests\/e2e\/e2e-database\.ts"/u);
});
