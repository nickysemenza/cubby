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

test("mixed portable and PostgreSQL changed runs use distinct sequence groups", () => {
  assert.notEqual(
    projectGroupOrder("pglite-integration"),
    projectGroupOrder("integration"),
  );
});
