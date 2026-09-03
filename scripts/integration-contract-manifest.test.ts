import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = join(repoRoot, "apps/web/src/server");
const familyRoot = join(serverRoot, "integration-families");

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

test("every PostgreSQL contract module belongs to exactly one family", () => {
  const families = filesBelow(familyRoot)
    .filter((path) => path.endsWith(".integration.test.ts"))
    .toSorted();
  assert.equal(families.length, 8);

  const contracts = filesBelow(serverRoot)
    .filter(
      (path) =>
        path.endsWith(".integration.test.ts") &&
        !path.startsWith(`${familyRoot}/`),
    )
    .toSorted();
  assert.equal(contracts.length, 57);

  const imported = families.flatMap((family) => {
    const source = readFileSync(family, "utf8");
    return [...source.matchAll(/^import "([^"]+)";$/gmu)].map((match) =>
      resolve(dirname(family), `${match[1]}.ts`),
    );
  });

  assert.equal(
    new Set(imported).size,
    imported.length,
    "duplicate contract import",
  );
  assert.deepEqual(
    imported.toSorted(),
    contracts,
    `family imports must equal the contract manifest below ${relative(repoRoot, serverRoot)}`,
  );
});
