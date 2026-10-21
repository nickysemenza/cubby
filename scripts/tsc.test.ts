import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { typeChecker } from "./tsc.ts";

// Compiler policy must preserve build-mode argument ordering, checked emission,
// and nonzero diagnostics for every caller that imports the launcher path.
test("compiler launcher checks build-mode declarations and propagates errors", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cubby-typecheck-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        emitDeclarationOnly: true,
        noEmitOnError: true,
        strict: true,
        types: [],
      },
      files: ["example.ts"],
    }),
  );
  const source = join(root, "example.ts");
  const compile = () =>
    spawnSync(process.execPath, [typeChecker, "--build", root], {
      encoding: "utf8",
    });
  writeFileSync(source, "export const example: number = 1;\n");
  const success = compile();
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.match(
    readFileSync(join(root, "example.d.ts"), "utf8"),
    /example: number/u,
  );
  writeFileSync(source, 'export const example: number = "invalid";\n');
  const failure = compile();
  assert.notEqual(failure.status, 0);
  assert.match(failure.stdout + failure.stderr, /TS2322/u);
});
