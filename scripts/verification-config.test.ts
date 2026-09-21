import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readJsonFile } from "nx/src/utils/fileutils";

type Target = {
  cache?: boolean;
  command?: string;
  inputs?: unknown[];
  outputs?: string[];
};

type Project = {
  targets: Record<string, Target>;
};

const rootProject = readJsonFile<Project>("project.json");
const webProject = readJsonFile<Project>("apps/web/project.json");
const rootPackage = readJsonFile<{ scripts: Record<string, string> }>(
  "package.json",
);
const webPackage = readJsonFile<{ scripts: Record<string, string> }>(
  "apps/web/package.json",
);

const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
};

test("fast-test orchestration delegates caching to complete child targets", () => {
  const outer = required(
    rootProject.targets["fast-tests"],
    "fast-tests target",
  );
  assert.equal(outer.cache, false);
  assert.match(outer.command ?? "", /static-failures-only/);

  const web = required(webProject.targets.test, "web test target");
  assert.equal(web.cache, true);
  const inputs = JSON.stringify(web.inputs);
  for (const required of [
    "repo",
    "sharedGlobals",
    ".env",
    "dependentTasksOutputFiles",
    "NODE_ENV",
    "TZ",
    "LANG",
    "CUBBY_TEST_SHUFFLE_SEED",
    "CUBBY_TEST_INTEGRATION",
    "VITEST_MAX_WORKERS",
  ]) {
    assert.match(inputs, new RegExp(required.replaceAll("*", "\\*")));
  }
  assert.deepEqual(web.outputs, [
    "{workspaceRoot}/apps/mcp-apps/dist",
    "{projectRoot}/.vitest-failures.txt",
  ]);
});

test("every verifier is daemon-free and collapses successful cached output", () => {
  for (const name of ["verify:local", "verify:local:full"]) {
    const command = required(rootPackage.scripts[name], `${name} script`);
    assert.match(command, /NX_DAEMON=false/);
    assert.match(command, /outputStyle=static-failures-only/);
  }
  assert.match(
    required(rootPackage.scripts.test, "root test script"),
    /static-failures-only/,
  );
});

test("local and hosted fast selectors include Worker safety exactly once", () => {
  const local = required(webPackage.scripts.test, "web test script");
  assert.equal(local.match(/--project worker-safety/g)?.length, 1);
  assert.match(local, /^pnpm test:prepare /);
  assert.match(local, /pnpm test:mark-success$/);

  const workflow = readFileSync(".github/workflows/ci.yaml", "utf8");
  assert.equal(workflow.match(/--project worker-safety/g)?.length, 1);
  assert.doesNotMatch(workflow, /--project unit-pure/);
});
