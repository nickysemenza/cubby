import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repoRoot, "scripts", "fixtures", "anti-slop");

interface OxlintLabel {
  span: { line: number };
}

interface OxlintDiagnostic {
  code: string;
  labels: OxlintLabel[];
}

interface OxlintOutput {
  diagnostics: OxlintDiagnostic[];
}

function lintFixture(
  ruleName: string,
  fixtureName: string,
): OxlintDiagnostic[] {
  const source = readFileSync(join(fixtureDirectory, fixtureName), "utf8");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cubby-anti-slop-"));
  const fixturePath = join(
    temporaryDirectory,
    fixtureName.endsWith(".tsx.txt")
      ? fixtureName.replace(/\.txt$/, "")
      : fixtureName.replace(/\.txt$/, ".ts"),
  );
  writeFileSync(fixturePath, source);

  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "oxlint",
        "--config",
        ".oxlintrc.json",
        "--format",
        "json",
        fixturePath,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.signal, null, result.stderr);
    assert.ok(
      result.status === 0 || result.status === 1,
      `Oxlint exited ${result.status}: ${result.stderr}`,
    );
    const output: OxlintOutput = JSON.parse(result.stdout);
    return output.diagnostics.filter(
      (diagnostic) => diagnostic.code === `anti-slop(${ruleName})`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true });
  }
}

test("runtime typeof is allowed only in explicitly annotated predicates", () => {
  const allowed = lintFixture(
    "no-runtime-typeof",
    "no-runtime-typeof-allowed.txt",
  );
  const rejected = lintFixture(
    "no-runtime-typeof",
    "no-runtime-typeof-rejected.txt",
  );

  assert.deepEqual(allowed, []);
  assert.deepEqual(
    rejected.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [2, 6, 10],
  );
});

test("unknown input is allowed only at an explicitly typed predicate seam", () => {
  const allowed = lintFixture(
    "no-unknown-parameters",
    "no-unknown-parameters-allowed.txt",
  );
  const rejected = lintFixture(
    "no-unknown-parameters",
    "no-unknown-parameters-rejected.txt",
  );

  assert.deepEqual(allowed, []);
  assert.deepEqual(
    rejected.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 5],
  );
});

test("shape naming applies to owned symbols but not external property names", () => {
  const allowed = lintFixture(
    "no-shape-in-symbol-names",
    "no-shape-in-symbol-names-allowed.txt",
  );
  const rejected = lintFixture(
    "no-shape-in-symbol-names",
    "no-shape-in-symbol-names-rejected.txt",
  );

  assert.deepEqual(allowed, []);
  assert.deepEqual(
    rejected.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 3, 4, 6, 10, 11, 14],
  );
});

test("conditional empty spreads are rejected in JSX as well as object literals", () => {
  const diagnostics = lintFixture(
    "no-conditional-empty-object-spread",
    "no-conditional-empty-object-spread-jsx.tsx.txt",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [3],
  );
});
