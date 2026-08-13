import assert from "node:assert/strict";
import test from "node:test";
import { classifyPaths } from "./ci-scope.mjs";

test("agent, documentation, and editor-only changes are inert", () => {
  assert.deepEqual(classifyPaths([".claude/skills/example/SKILL.md"]), {
    inert: true,
    web: false,
    rust: false,
    aux: false,
    usda: false,
    upc: false,
    workers: [],
    unknown: false,
  });
  assert.equal(classifyPaths(["docs/todos.md", ".vscode/settings.json"]).inert, true);
});

test("a web-only change runs web CI without auxiliary or Rust work", () => {
  assert.deepEqual(classifyPaths(["apps/web/src/server.ts"]), {
    inert: false,
    web: true,
    rust: false,
    aux: false,
    usda: false,
    upc: false,
    workers: [],
    unknown: false,
  });
});

test("each auxiliary worker follows its transitive workspace dependencies", () => {
  assert.deepEqual(classifyPaths(["packages/usda-contract/src/index.ts"]).workers, [
    "usda-api",
  ]);
  assert.deepEqual(classifyPaths(["packages/shared/src/index.ts"]).workers, [
    "upc-lookup",
  ]);
  assert.deepEqual(
    classifyPaths(["packages/usda-schemas/src/food.ts"]).workers,
    ["usda-api", "upc-lookup"],
  );
});

test("shared packages select web and auxiliary consumers", () => {
  const scope = classifyPaths(["packages/upc-contract/src/index.ts"]);
  assert.equal(scope.web, true);
  assert.equal(scope.aux, true);
  assert.equal(scope.upc, true);
  assert.equal(scope.usda, false);
});

test("Rust and generated WASM paths have distinct scopes", () => {
  const rust = classifyPaths(["recipebridge/src/lib.rs"]);
  assert.equal(rust.rust, true);
  assert.equal(rust.web, true);

  const wasmPackage = classifyPaths(["packages/wasm/package.json"]);
  assert.equal(wasmPackage.rust, false);
  assert.equal(wasmPackage.web, true);
});

test("dependency and CI configuration changes fail safe across JS workspaces", () => {
  for (const path of ["pnpm-lock.yaml", ".github/workflows/ci.yaml"]) {
    const scope = classifyPaths([path]);
    assert.equal(scope.web, true, path);
    assert.equal(scope.aux, true, path);
    assert.deepEqual(scope.workers, ["usda-api", "upc-lookup"], path);
  }
});

test("a novel path fails safe to every suite and worker", () => {
  assert.deepEqual(classifyPaths(["new-system/config.toml"]), {
    inert: false,
    web: true,
    rust: true,
    aux: true,
    usda: true,
    upc: true,
    workers: ["usda-api", "upc-lookup"],
    unknown: true,
  });
});

test("inert files do not dilute a real code change", () => {
  const scope = classifyPaths(["README.md", "apps/upc-lookup/src/index.tsx"]);
  assert.equal(scope.inert, false);
  assert.equal(scope.web, false);
  assert.equal(scope.aux, true);
  assert.deepEqual(scope.workers, ["upc-lookup"]);
});
