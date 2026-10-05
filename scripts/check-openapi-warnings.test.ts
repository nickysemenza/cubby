import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../apps/apple/scripts/check-openapi-warnings.sh", import.meta.url),
);

// A copy of the gate in a synthetic checkout, with `swift` and the generator
// replaced by stubs that log each invocation.
const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "cubby-openapi-warnings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "apps/apple/scripts");
  const kit = join(root, "apps/apple/CubbyKit");
  const api = join(kit, "Sources/CubbyAPI");
  const stubs = join(root, "stubs");
  const bin = join(kit, ".build/debug");
  for (const dir of [scripts, api, stubs, bin])
    mkdirSync(dir, { recursive: true });
  copyFileSync(SCRIPT, join(scripts, "check-openapi-warnings.sh"));
  writeFileSync(
    join(kit, "Package.resolved"),
    '{"pins":["generator 1.0.0"]}\n',
  );
  writeFileSync(join(api, "openapi.json"), '{"openapi":"3.1.0"}\n');
  writeFileSync(
    join(api, "openapi-generator-config.yaml"),
    "generate: [types]\n",
  );
  const log = join(root, "calls.log");
  const stub = (path: string, body: string) => {
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub(
    join(stubs, "swift"),
    `echo "swift $*" >> "${log}"
case "$*" in
  --version) echo "\${STUB_SWIFT_VERSION:-Swift version 1.0}" ;;
  *--show-bin-path*) echo "${bin}" ;;
esac`,
  );
  stub(
    join(bin, "swift-openapi-generator"),
    `echo "generator" >> "${log}"
echo "note: Detected a recursive type; it will be boxed. [context: name=Node]" >&2
if [ -n "\${STUB_WARNING:-}" ]; then
  echo "warning: Schema \\"null\\" is not supported, reason: \\"not supported\\", skipping [context: foundIn=Widget]" >&2
fi
exit "\${STUB_EXIT:-0}"`,
  );
  const run = (env: Record<string, string> = {}) => {
    writeFileSync(log, "");
    const result = spawnSync(
      "bash",
      [join(scripts, "check-openapi-warnings.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          PATH: `${stubs}:${process.env.PATH ?? ""}`,
        },
      },
    );
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return {
      status: result.status,
      stderr: result.stderr,
      generated: calls.includes("generator"),
      built: calls.some((call) => call.startsWith("swift build")),
    };
  };
  return { api, kit, run };
};

test("a generator warning fails every run, never only the first", (t) => {
  const { run } = fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = run({ STUB_WARNING: "1" });
    assert.equal(result.status, 1);
    assert.equal(result.generated, true);
    assert.match(result.stderr, /Widget/u);
  }
});

test("a failing generator fails every run, never only the first", (t) => {
  const { run } = fixture(t);
  assert.notEqual(run({ STUB_EXIT: "3" }).status, 0);
  const again = run({ STUB_EXIT: "3" });
  assert.notEqual(again.status, 0);
  assert.equal(again.generated, true);
});

test("a passing check is not regenerated until one of its inputs changes", (t) => {
  const { api, kit, run } = fixture(t);
  const first = run();
  assert.equal(first.status, 0);
  assert.equal(first.generated, true);

  const repeat = run();
  assert.equal(repeat.status, 0);
  assert.equal(repeat.generated, false);
  assert.equal(repeat.built, false);

  const changes: [string, () => void][] = [
    [
      "document",
      () => writeFileSync(join(api, "openapi.json"), '{"openapi":"3.1.1"}\n'),
    ],
    [
      "config",
      () =>
        writeFileSync(
          join(api, "openapi-generator-config.yaml"),
          "generate: [client]\n",
        ),
    ],
    [
      "generator pin",
      () =>
        writeFileSync(join(kit, "Package.resolved"), '{"pins":["2.0.0"]}\n'),
    ],
  ];
  for (const [input, change] of changes) {
    change();
    assert.equal(run().generated, true, `${input} change regenerates`);
    assert.equal(run().generated, false, `${input} pass is reused`);
  }
  assert.equal(
    run({ STUB_SWIFT_VERSION: "Swift version 2.0" }).generated,
    true,
  );
});

test("a warning on changed inputs fails after an earlier pass", (t) => {
  const { api, run } = fixture(t);
  assert.equal(run().status, 0);
  writeFileSync(join(api, "openapi.json"), '{"openapi":"3.1.0","paths":{}}\n');
  const result = run({ STUB_WARNING: "1" });
  assert.equal(result.status, 1);
  assert.equal(result.generated, true);
});
