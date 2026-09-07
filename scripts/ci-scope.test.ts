import assert from "node:assert/strict";
import test from "node:test";
import { classifyPaths, selectPushChecks } from "./ci-scope.ts";

test("agent, documentation, and editor-only changes are inert", () => {
  assert.deepEqual(classifyPaths([".claude/skills/example/SKILL.md"]), {
    inert: true,
    web: false,
    rust: false,
    aux: false,
    usda: false,
    upc: false,
    workers: [],
    dependencies: false,
    unknown: false,
    postgres: false,
    e2e: false,
    cloudflare: false,
    highRisk: false,
  });
  assert.equal(
    classifyPaths(["docs/todos.md", ".vscode/settings.json"]).inert,
    true,
  );
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
    dependencies: false,
    unknown: false,
    postgres: false,
    e2e: false,
    cloudflare: true,
    highRisk: false,
  });
});

test("each auxiliary worker follows its transitive workspace dependencies", () => {
  assert.deepEqual(
    classifyPaths(["packages/usda-contract/src/index.ts"]).workers,
    ["usda-api"],
  );
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
  for (const path of [
    "pnpm-lock.yaml",
    ".github/workflows/ci.yaml",
    ".oxlintrc.json",
    ".oxfmtrc.json",
  ]) {
    const scope = classifyPaths([path]);
    assert.equal(scope.web, true, path);
    assert.equal(scope.aux, true, path);
    assert.deepEqual(scope.workers, ["usda-api", "upc-lookup"], path);
    assert.equal(scope.dependencies, path === "pnpm-lock.yaml", path);
  }
  assert.equal(classifyPaths(["apps/web/package.json"]).dependencies, true);
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
    dependencies: true,
    unknown: true,
    postgres: true,
    e2e: true,
    cloudflare: true,
    highRisk: true,
  });
});

test("database, browser, and high-risk paths select their expensive gates", () => {
  const repository = classifyPaths([
    "apps/web/src/server/repo/product/product.repository.ts",
  ]);
  assert.equal(repository.postgres, true);
  assert.equal(repository.e2e, false);
  assert.equal(repository.highRisk, false);

  const route = classifyPaths([
    "apps/web/src/routes/_authenticated/products.tsx",
  ]);
  assert.equal(route.e2e, true);
  assert.equal(route.postgres, false);

  for (const path of [
    "apps/web/src/server/repo/inventory/update.ts",
    "apps/web/src/server/entity-kernel/entity-operations.ts",
    "apps/web/drizzle/0001.sql",
    ".github/workflows/ci.yaml",
    ".github/actions/setup-node-with-deps/action.yml",
    "apps/web/tooling/test-changed.ts",
    "apps/web/vitest.config.ts",
    "apps/web/playwright.config.ts",
    "scripts/ci-scope.ts",
  ]) {
    assert.equal(classifyPaths([path]).highRisk, true, path);
  }
});

test("inert files do not dilute a real code change", () => {
  const scope = classifyPaths(["README.md", "apps/upc-lookup/src/index.tsx"]);
  assert.equal(scope.inert, false);
  assert.equal(scope.web, false);
  assert.equal(scope.aux, true);
  assert.deepEqual(scope.workers, ["upc-lookup"]);
});

test("documentation-only pushes do not launch code gates", () => {
  assert.deepEqual(selectPushChecks(["docs/ci.md"]), []);
});

test("ordinary web source runs affected tests and the Cloudflare build", () => {
  assert.deepEqual(selectPushChecks(["apps/web/src/lib/date.ts"]), [
    "web-tests",
    "cloudflare",
  ]);
});

test("database changes upgrade affected tests to PostgreSQL", () => {
  assert.deepEqual(
    selectPushChecks(["apps/web/src/server/repo/product/read.ts"]),
    ["postgres", "cloudflare"],
  );
});

test("high-risk and routing changes add browser verification", () => {
  assert.deepEqual(
    selectPushChecks(["apps/web/src/server/repo/inventory/update.ts"]),
    ["rust", "aux", "cloudflare", "all-tests"],
  );
  assert.deepEqual(
    selectPushChecks(["apps/web/src/routes/_authenticated/products.tsx"]),
    ["web-tests", "cloudflare", "e2e"],
  );
});

test("unknown paths fail safe across all implementation stacks", () => {
  assert.deepEqual(selectPushChecks(["new-system/config.toml"]), [
    "rust",
    "aux",
    "cloudflare",
    "all-tests",
  ]);
});

test("explicit full verification includes every stack even for inert changes", () => {
  assert.deepEqual(selectPushChecks(["docs/ci.md"], true), [
    "rust",
    "aux",
    "cloudflare",
    "all-tests",
  ]);
});
