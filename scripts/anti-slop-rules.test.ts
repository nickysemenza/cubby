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

function runOxlint(fixturePath: string): OxlintDiagnostic[] {
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
  return output.diagnostics;
}

function fixtureFilename(fixtureName: string): string {
  return fixtureName.endsWith(".tsx.txt")
    ? fixtureName.replace(/\.txt$/, "")
    : fixtureName.replace(/\.txt$/, ".ts");
}

function lintFixture(
  ruleName: string,
  fixtureName: string,
  plugin = "anti-slop",
): OxlintDiagnostic[] {
  const source = readFileSync(join(fixtureDirectory, fixtureName), "utf8");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cubby-anti-slop-"));
  const fixturePath = join(temporaryDirectory, fixtureFilename(fixtureName));
  writeFileSync(fixturePath, source);

  try {
    return runOxlint(fixturePath).filter(
      (diagnostic) => diagnostic.code === `${plugin}(${ruleName})`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true });
  }
}

/**
 * `require-soft-delete-filter` is scoped in `.oxlintrc.json` to
 * `apps/web/src/server/**\/*.ts` (a real repo path, so `application-schema`'s
 * catalog and the drizzle imports resolve as they would in production code).
 * A plain OS-tmpdir fixture (as `lintFixture` uses) falls outside that glob and
 * would silently never run the rule, so this places the fixture under the
 * scoped directory instead, in a disposable subdirectory removed afterward.
 */
function lintScopedFixture(
  ruleName: string,
  fixtureName: string,
  plugin = "cubby",
): OxlintDiagnostic[] {
  const source = readFileSync(join(fixtureDirectory, fixtureName), "utf8");
  const scopedRoot = join(repoRoot, "apps", "web", "src", "server");
  const temporaryDirectory = mkdtempSync(join(scopedRoot, ".lint-fixture-"));
  const fixturePath = join(temporaryDirectory, fixtureFilename(fixtureName));
  writeFileSync(fixturePath, source);

  try {
    return runOxlint(fixturePath).filter(
      (diagnostic) => diagnostic.code === `${plugin}(${ruleName})`,
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

test("unknown input is allowed at predicates and genuine decoder seams", () => {
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
    [1, 5, 9, 14],
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

test("sql array interpolation requires typed helpers", () => {
  const diagnostics = lintFixture(
    "no-unsafe-sql-array-interpolation",
    "no-unsafe-sql-array-interpolation.txt",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [7, 8],
  );
});

test("only the operation cache may call TanStack invalidation directly", () => {
  const diagnostics = lintFixture(
    "no-direct-query-invalidation",
    "no-direct-query-invalidation.txt",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [5, 6],
  );
});

test("removed query-key invalidation identifiers stay unavailable", () => {
  const diagnostics = lintFixture(
    "no-legacy-query-invalidation",
    "no-legacy-query-invalidation.txt",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
  );
});

test("unsafe helper declarations are rejected everywhere", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-declaration.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1],
  );
});

test("importing an unsafe helper by alias is rejected, and calling the alias is rejected", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-import-and-call.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 2],
  );
});

test("namespace imports and member-access calls of unsafe helpers are rejected", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-member-and-namespace.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 2, 3],
  );
});

test("importing the test-only identifier module outside test paths is rejected", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-testing-module-import.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1],
  );
});

test("re-exports and non-static module loading of the test-only module are rejected", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-module-bypass-imports.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 2, 3, 4, 5],
  );
});

test("computed, destructured, and indirect-module bypasses of unsafe helpers are rejected", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-adversarial-bypasses.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [1, 2, 3, 6, 7],
  );
});

test("branded assertions are rejected, including generic, array, and structural forms", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-branded-assertions.txt",
    "cubby",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 31, 32],
  );
});

test("unrelated protocol ids that merely look branded are not classified as branded", () => {
  const diagnostics = lintFixture(
    "no-unsafe-identifiers",
    "no-unsafe-identifiers-allowed-unbranded-assertion.txt",
    "cubby",
  );

  assert.deepEqual(diagnostics, []);
});

// `branded-assertion`'s cross-file provenance walk (an asserted-to type imported
// from another module, itself branded at its declaration site) is documented,
// accepted non-coverage: a single-file oxlint rule cannot see another file's AST.
// The deleted `check-unsafe-identifiers.ts` fixtures `brand-provenance-source.txt`
// / `brand-provenance-consumer.txt` exercised exactly that cross-file case (4
// violations) and are deleted rather than ported — see docs/agents/validation.md.

test("Drizzle exists() over a soft-deletable table with no guard is rejected", () => {
  const diagnostics = lintScopedFixture(
    "require-soft-delete-filter",
    "require-soft-delete-filter-missing-drizzle-exists.txt",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [9],
  );
});

test("a raw sql EXISTS over a soft-deletable table with no guard is rejected", () => {
  const diagnostics = lintScopedFixture(
    "require-soft-delete-filter",
    "require-soft-delete-filter-missing-sql-template.txt",
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.labels[0]?.span.line),
    [6],
  );
});

test("an includes-deleted audit comment opts an EXISTS subquery out", () => {
  const diagnostics = lintScopedFixture(
    "require-soft-delete-filter",
    "require-soft-delete-filter-audited-comment.txt",
  );

  assert.deepEqual(diagnostics, []);
});

test("a notDeleted() predicate inside the subquery satisfies the guard", () => {
  const diagnostics = lintScopedFixture(
    "require-soft-delete-filter",
    "require-soft-delete-filter-notdeleted-present.txt",
  );

  assert.deepEqual(diagnostics, []);
});
