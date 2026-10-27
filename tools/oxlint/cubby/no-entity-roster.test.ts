import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("entity rosters are fenced without flagging entity-shaped rows", () => {
  const directory = mkdtempSync(
    join(root, "apps/web/src/server/generic/.lint-fixture-"),
  );
  const file = join(directory, "roster.ts");
  writeFileSync(
    file,
    `
    const roster = { ["product"]: loadProduct, recipe: loadRecipe };
    const typed = {} satisfies Partial<Record<Entity, unknown>>;
    const singleton: Record<"product", unknown> = { product: loadProduct };
    const cache = new Map<Entity, unknown>();
    const literal = new Map([["product", loadProduct]]);
    const alias = generated satisfies Record<Entity, unknown>;
    function rosterFactory() { return { product: loadProduct, recipe: loadRecipe }; }
    const row = schema.object({ product: schema.string(), recipe: schema.string() });
    function page() { return new Map<Entity, unknown>(); }
  `,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/oxlint/bin/oxlint"),
        "--config",
        join(root, ".oxlintrc.json"),
        "--format",
        "json",
        file,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 1, result.stderr);
    const output: { diagnostics: { code: string; message: string }[] } =
      JSON.parse(result.stdout);
    const diagnostics = output.diagnostics.filter(
      (entry) => entry.code === "cubby(no-entity-roster)",
    );
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.message ?? "", /has 7 entity rosters/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
