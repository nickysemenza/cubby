import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCiChanges } from "./ci-change-scope.ts";

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

test("routes the docs tree to the web app", () => {
  assert.deepEqual(active(["docs/inventory-audit.md"]), [
    "web",
    "docs",
    "format",
  ]);
  assert.deepEqual(active(["docs/adr/0001-entity-relationship-authority.md"]), [
    "web",
    "docs",
    "format",
  ]);
});

test("routes web, shared, auxiliary, Rust, and Apple dependencies", () => {
  assert.deepEqual(active(["apps/web/src/page.tsx"]), ["validation", "web"]);
  assert.deepEqual(active(["apps/web/src/contracts/task.contract.ts"]), [
    "validation",
    "web",
    "apple",
  ]);
  assert.deepEqual(active(["apps/web/scripts/apple-preview-fixtures.ts"]), [
    "validation",
    "web",
    "apple",
  ]);
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
