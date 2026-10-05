import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.deepEqual(active(["Cargo.lock"]), active(["recipebridge/src/lib.rs"]));
  assert.deepEqual(active(["cubby-ffi/src/lib.rs"]), ["rust", "apple"]);
  assert.deepEqual(active(["apps/usda-api/src/index.ts"]), [
    "validation",
    "auxiliary",
  ]);
});

// The optional purchase-import browser lane follows its own surfaces only.
test("routes purchase-import surfaces to the import browser lane", () => {
  for (const file of [
    "apps/web/src/server/purchase-import/gmail/import.ts",
    "apps/web/src/server/purchase-agent/run-agent.ts",
    "apps/web/src/app/purchases/purchase-import-run-detail.tsx",
    "apps/web/src/app/runs/agent-observation.ts",
    "apps/web/src/app/vendors/order-mail-worklist.tsx",
    "apps/web/src/routes/_authenticated/runs.$shortcode.tsx",
    "apps/web/tooling/purchase-agent-workerd-harness.ts",
    "apps/web/tests/e2e/harness-services/purchase-agent-test-model.ts",
    "apps/web/tests/e2e/purchase-import-run.spec.ts",
  ])
    assert.deepEqual(active([file]), ["validation", "web", "importE2e"], file);
  assert.deepEqual(active(["apps/web/src/app/products/page.tsx"]), [
    "validation",
    "web",
  ]);
  // The Worker bundles these skills as the agent's instructions.
  assert.deepEqual(
    active([".claude/skills/purchase-import/references/run-workflow.md"]),
    ["web", "docs", "format", "importE2e"],
  );
  assert.deepEqual(active([".claude/skills/photo-inventory-import/SKILL.md"]), [
    "web",
    "docs",
    "format",
  ]);
  assert.deepEqual(active([".claude/skills/repo-audit/SKILL.md"]), [
    "docs",
    "format",
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

const scopeScript = fileURLToPath(
  new URL("./ci-change-scope.ts", import.meta.url),
);
const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
const commit = (directory: string) => {
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=CI fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Synthetic scope fixture",
  );
  return git(directory, "rev-parse", "HEAD");
};
const runScope = (
  directory: string,
  event: string,
  base: string,
  head: string,
) => {
  const output = join(directory, "scope-output.txt");
  writeFileSync(output, "");
  const { CUBBY_CHANGED_FILES: _changedFiles, ...environment } = process.env;
  execFileSync(process.execPath, [scopeScript], {
    cwd: directory,
    env: {
      ...environment,
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: output,
      CUBBY_BASE_SHA: base,
      CUBBY_HEAD_SHA: head,
    },
    stdio: "pipe",
  });
  return readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.endsWith("=true"))
    .map((line) => line.split("=")[0]);
};

// Path JSON can exceed the Linux per-environment-value limit before Node starts.
// Collecting it inside the process must retain both rename endpoints and each
// event's range semantics; unavailable Git data must still run every check.
test("collects a large renamed diff through short SHA inputs", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-ci-scope-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, "init", "--quiet", "-b", "main");
  const before = join(directory, "apps/apple/App");
  const after = join(directory, "apps/web/src");
  mkdirSync(before, { recursive: true });
  for (let index = 0; index < 1_200; index++) {
    writeFileSync(
      join(before, `synthetic-${"review-".repeat(12)}${index}.swift`),
      "Synthetic fixture\n",
    );
  }
  const base = commit(directory);
  mkdirSync(dirname(after), { recursive: true });
  renameSync(before, after);
  const head = commit(directory);
  const paths = execFileSync(
    "git",
    [
      "-C",
      directory,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${base}...${head}`,
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  assert.ok(Buffer.byteLength(JSON.stringify(paths)) > 128 * 1_024);
  assert.deepEqual(runScope(directory, "pull_request", base, head), [
    "validation",
    "web",
    "apple",
  ]);
});

test("uses the PR merge base but the previous push tip on diverged history", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-ci-scope-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, "init", "--quiet", "-b", "main");
  writeFileSync(join(directory, "README.md"), "Synthetic fixture\n");
  const common = commit(directory);
  mkdirSync(join(directory, "apps/apple/App"), { recursive: true });
  writeFileSync(
    join(directory, "apps/apple/App/Fixture.swift"),
    "Synthetic native fixture\n",
  );
  const base = commit(directory);
  git(directory, "checkout", "--quiet", "-b", "fixture-head", common);
  mkdirSync(join(directory, "apps/web/src"), { recursive: true });
  writeFileSync(
    join(directory, "apps/web/src/fixture.ts"),
    "// Synthetic web fixture\n",
  );
  const head = commit(directory);
  assert.deepEqual(runScope(directory, "pull_request", base, head), [
    "validation",
    "web",
  ]);
  assert.deepEqual(runScope(directory, "push", base, head), [
    "validation",
    "web",
    "apple",
  ]);
  assert.deepEqual(
    runScope(directory, "push", "0".repeat(40), head),
    active([]),
  );
});
