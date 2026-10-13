import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonFile } from "nx/src/devkit-exports.js";
import { checkApple } from "./apple-validation.ts";

test("Apple cache misses reach the explicit probe guard on POSIX hosts", () => {
  const project = readJsonFile<{
    targets: Record<string, { command?: string }>;
  }>("apps/apple/project.json");
  for (const target of ["host-tests", "simulator-build"]) {
    const result = spawnSync(project.targets[target]!.command!, {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, CUBBY_NX_CACHE_PROBE: "1" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no cached result for this input hash/);
    assert.doesNotMatch(result.stderr, /Illegal option/);
  }
});

test("a host without Xcode cannot publish a passing native check", () => {
  const result = spawnSync("/bin/bash", ["scripts/apple-check.sh", "host"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent", CUBBY_NX_CACHE_PROBE: "" },
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Xcode/);
});

test("Apple formatting is available without FFI or an app build", (t) => {
  const project = readJsonFile<{
    targets: Record<string, { command?: string }>;
  }>("apps/apple/project.json");
  assert.ok(project.targets.lint?.command);
  const root = mkdtempSync(join(tmpdir(), "apple-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "apps/apple/App"), { recursive: true });
  mkdirSync(join(root, "apps/apple/CubbyKit/Sources/CubbyKit"), {
    recursive: true,
  });
  cpSync("scripts/apple-check.sh", join(root, "scripts/apple-check.sh"));
  for (const [name, body] of Object.entries({
    "xcode-select": "exit 0",
    swift: 'echo "swift $*"',
  })) {
    const file = join(root, "bin", name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  const result = spawnSync(project.targets.lint.command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      CUBBY_NX_CACHE_PROBE: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /swift format lint/);
});

test("native pass replay needs no FFI; misses prepare once and execute sequentially", (t) => {
  const root = mkdtempSync(join(tmpdir(), "apple-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts/generator"), { recursive: true });
  writeFileSync(
    join(root, "scripts/generator/ensure.ts"),
    'import {appendFileSync} from "node:fs"; appendFileSync("calls", "generate\\n");',
  );
  writeFileSync(
    join(root, "scripts/ensure-apple-ffi.ts"),
    'import {appendFileSync} from "node:fs"; appendFileSync("calls", "ffi\\n");',
  );
  const pnpm = join(root, "bin/pnpm");
  writeFileSync(
    pnpm,
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync('calls', JSON.stringify(process.argv.slice(2)) + '\\n'); if(process.env.CUBBY_NX_CACHE_PROBE === '1' && fs.existsSync('miss')) process.exit(1);`,
  );
  chmodSync(pnpm, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  checkApple(root, "host");
  assert.doesNotMatch(
    readFileSync(join(root, "calls"), "utf8"),
    /ffi|run-many|simulator-build/,
  );
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "miss"), "");
  checkApple(root);
  const calls = readFileSync(join(root, "calls"), "utf8");
  assert.equal(calls.split("\n").filter((line) => line === "ffi").length, 1);
  assert.match(calls, /--targets=host-tests,simulator-build/);
  assert.match(calls, /--parallel=1/);
});
