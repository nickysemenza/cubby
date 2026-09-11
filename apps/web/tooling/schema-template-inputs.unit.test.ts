import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { schemaTemplateInputs } from "./schema-template-inputs";

const appRoot = join(__dirname, "..");

/**
 * The `./src/server/db/…` files `schemaTemplateInputs` itself names: the two
 * schema modules plus everything under `generated/`. Other files in that
 * directory are runtime helpers, not template inputs, so their imports do not
 * move the hash.
 */
function schemaSourceFiles(): string[] {
  const files = schemaTemplateInputs
    .filter(
      (entry) => entry.startsWith("./src/server/db/") && !entry.includes("*"),
    )
    .map((entry) => join(appRoot, entry));
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.includes(".test.")) {
        files.push(full);
      }
    }
  };
  walk(join(appRoot, "src/server/db/generated"));
  return files;
}

/**
 * Module specifiers imported as VALUES (not `import type`) from
 * `@cubby/schemas`. A value import is the only way a constant array in the
 * schemas package can reach a `pgEnum` or `text({ enum })` column.
 */
function valueImportedSchemaModules(source: string): string[] {
  const modules = new Set<string>();
  const importPattern =
    /^import\s+(type\s+)?(?:[^;]*?)\s+from\s+"@cubby\/schemas\/([^"]+)";/gmsu;
  for (const match of source.matchAll(importPattern)) {
    const [, typeOnly, moduleName] = match;
    if (typeOnly) continue;
    // `import { type A, b }` still carries a value when any specifier lacks
    // `type`; `import { type A, type B }` is value-free but not `import type`.
    const specifiers = match[0]
      .replace(/^import\s+/u, "")
      .replace(/\s+from\s+"[^"]+";$/u, "")
      .replace(/[{}]/gu, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (specifiers.some((s) => !s.startsWith("type "))) {
      modules.add(moduleName ?? "");
    }
  }
  return [...modules].filter(Boolean);
}

describe("schemaTemplateInputs", () => {
  it("lists every @cubby/schemas module the database schema imports values from", () => {
    const required = new Set<string>();
    for (const file of schemaSourceFiles()) {
      for (const moduleName of valueImportedSchemaModules(
        readFileSync(file, "utf8"),
      )) {
        required.add(`../../packages/schemas/src/${moduleName}.ts`);
      }
    }
    expect(required.size).toBeGreaterThan(0);
    const missing = [...required].filter(
      (entry) => !schemaTemplateInputs.includes(entry),
    );
    expect(
      missing,
      "add these to schemaTemplateInputs so the test-database template hash moves with them",
    ).toEqual([]);
  });

  it("only names files that exist, relative to apps/web", () => {
    for (const entry of schemaTemplateInputs) {
      if (entry.includes("*")) continue;
      const full = join(appRoot, entry);
      expect(
        statSync(full).isFile(),
        `${relative(appRoot, full)} missing`,
      ).toBe(true);
    }
  });
});
