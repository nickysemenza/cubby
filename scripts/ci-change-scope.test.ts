import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { bundledMarkdown, classifyCiChanges } from "./ci-change-scope.ts";

const active = (files: string[], full = false) =>
  Object.entries(classifyCiChanges(files, full))
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

test("routes docs and native changes without code tests", () => {
  assert.deepEqual(active(["README.md"]), ["docs", "format"]);
  assert.deepEqual(active(["apps/apple/README.md"]), ["docs", "format"]);
  assert.deepEqual(active(["apps/apple/App/View.swift"]), ["apple"]);
  assert.deepEqual(active(["apps/apple/project.yml"]), ["apple", "format"]);
});

test("routes bundled and generated documents to their consumers", () => {
  assert.deepEqual(active(["docs/inventory-audit.md"]), [
    "web",
    "docs",
    "format",
  ]);
  assert.deepEqual(active(["docs/how-values-are-determined.md"]), [
    "docs",
    "format",
    "generator",
  ]);
});

test("keeps bundled Markdown classification in sync with raw imports", () => {
  const webSource = resolve("apps/web/src");
  const imported = globSync("**/*.{ts,tsx}", { cwd: webSource })
    .flatMap((file) => {
      const source = readFileSync(resolve(webSource, file), "utf8");
      return Array.from(source.matchAll(/from\s+["']([^"']+\.mdx?\?raw)["']/g))
        .map((match) => match[1]!)
        .map((relative) =>
          resolve(webSource, file, "..", relative.slice(0, -4)),
        );
    })
    .map((absolute) => absolute.slice(resolve(".").length + 1))
    .sort();
  assert.deepEqual(imported, [...bundledMarkdown].sort());
});

test("routes web, shared, auxiliary, Rust, and Apple dependencies", () => {
  assert.deepEqual(active(["apps/web/src/page.tsx"]), ["validation", "web"]);
  assert.deepEqual(active(["packages/shared/src/index.ts"]), [
    "validation",
    "web",
    "auxiliary",
  ]);
  assert.deepEqual(active(["packages/schemas/src/index.ts"]), [
    "validation",
    "web",
    "auxiliary",
    "apple",
  ]);
  assert.deepEqual(active(["recipebridge/src/lib.rs"]), [
    "validation",
    "web",
    "auxiliary",
    "rust",
    "apple",
  ]);
  assert.deepEqual(active(["apps/usda-api/src/index.ts"]), [
    "validation",
    "auxiliary",
  ]);
});

test("runs full verification for shared configuration, unknown paths, and manual runs", () => {
  for (const files of [
    ["pnpm-lock.yaml"],
    [".github/workflows/ci.yaml"],
    ["new-config.xyz"],
    [],
  ])
    assert.ok(Object.values(classifyCiChanges(files)).every(Boolean));
  assert.ok(
    Object.values(classifyCiChanges(["README.md"], true)).every(Boolean),
  );
});
