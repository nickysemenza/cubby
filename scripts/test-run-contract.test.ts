import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Drives the real Vitest CLI with the contract reporter so a focused run
// (`pnpm test:postgres <file> -t "<name>"`) is judged the way agents run it.
const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const reporter = path.join(webRoot, "tooling/test-run-contract-reporter.ts");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "cubby-test-contract-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

writeFileSync(
  path.join(fixtureRoot, "vitest.config.mjs"),
  `export default { test: { globals: true, reporters: ["dot", ${JSON.stringify(reporter)}], projects: [{ test: { name: "fixtures", globals: true, include: ["*.fixture.mjs"] } }, { test: { name: "focused", globals: true, include: ["selection.fixture.mjs"], testNamePattern: /alpha/g } }] } };\n`,
);
writeFileSync(
  path.join(fixtureRoot, "selection.fixture.mjs"),
  `describe("synthetic suite", () => {\n  it("alpha case", () => {});\n  it("beta case", () => {});\n});\n`,
);
writeFileSync(
  path.join(fixtureRoot, "skipped.fixture.mjs"),
  `it("alpha skipped", () => {});\nit.skip("alpha forgotten", () => {});\n`,
);

function vitest(...args: string[]) {
  if (!args.includes("--project")) args.unshift("--project", "fixtures");
  const result = spawnSync(
    path.join(webRoot, "node_modules/.bin/vitest"),
    ["run", "--root", fixtureRoot, "--config", "vitest.config.mjs", ...args],
    { cwd: fixtureRoot, encoding: "utf8", env: { ...process.env, CI: "" } },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

test("a focused -t run whose selected test passes exits 0", () => {
  const run = vitest("selection.fixture.mjs", "-t", "alpha");
  assert.equal(run.status, 0, run.output);
});

test("a -t pattern that selects nothing fails the lane", () => {
  const run = vitest("selection.fixture.mjs", "-t", "no such synthetic test");
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /Selected test lane matched no tests/);
});

test("a skipped test inside the -t selection still fails the lane", () => {
  const run = vitest("skipped.fixture.mjs", "-t", "alpha");
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /did not execute: .*alpha forgotten/);
});

test("an unfocused run rejects skipped tests", () => {
  const run = vitest("skipped.fixture.mjs");
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /did not execute: .*alpha forgotten/);
});

test("a project-level name pattern is honored, including a /g pattern", () => {
  const run = vitest("--project", "focused");
  assert.equal(run.status, 0, run.output);
});
