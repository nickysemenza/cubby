import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { serviceMode } from "./test-services.ts";

// Table-driven: CUBBY_TEST_SERVICES parsing is the one regression that would
// silently misroute every `test:*` invocation (falling back to `apple` when
// a typo'd value should have failed loudly, or vice versa).
const cases: [
  name: string,
  env: NodeJS.ProcessEnv,
  warmFlag: boolean,
  expected: "apple" | "external" | "warm" | Error,
][] = [
  ["unset defaults to apple", {}, false, "apple"],
  ["external", { CUBBY_TEST_SERVICES: "external" }, false, "external"],
  ["apple", { CUBBY_TEST_SERVICES: "apple" }, false, "apple"],
  ["warm via env", { CUBBY_TEST_SERVICES: "warm" }, false, "warm"],
  ["warm via --warm flag overrides unset env", {}, true, "warm"],
  [
    "invalid value rejected even with --warm",
    { CUBBY_TEST_SERVICES: "bogus" },
    true,
    new Error(),
  ],
  [
    "invalid value rejected",
    { CUBBY_TEST_SERVICES: "bogus" },
    false,
    new Error(),
  ],
];

for (const [name, env, warmFlag, expected] of cases) {
  test(`serviceMode: ${name}`, () => {
    if (expected instanceof Error) {
      assert.throws(() => serviceMode(env, warmFlag));
    } else {
      assert.equal(serviceMode(env, warmFlag), expected);
    }
  });
}

// Failure modes: SIGKILL bypasses finally; a live run, mounted database, warm
// service, or unrelated container must survive recovery. The CLI is the external
// seam: use real process liveness and invoke the shipped command in a subprocess.
test("prune recovers only abandoned unmounted test services", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cubby-service-recovery-"),
  );
  try {
    const log = path.join(directory, "calls.jsonl");
    const fixture = (id: string, image: string, mounts: unknown[] = []) => ({
      id,
      status: { state: "running" },
      configuration: { image: { reference: image }, mounts },
    });
    const dead = "cubby-999999-aabbccdd-postgres";
    const entries = [
      fixture(dead, "docker.io/pgvector/pgvector:pg17"),
      fixture(
        `cubby-${process.pid}-aabbccdd-postgres`,
        "docker.io/pgvector/pgvector:pg17",
      ),
      fixture("cubby-999999-aabbccdd-integresql", "unrelated/image"),
      fixture(
        "cubby-999999-aabbccee-postgres",
        "docker.io/pgvector/pgvector:pg17",
        [{ destination: "/data" }],
      ),
      fixture("cubby-dev-pg", "docker.io/pgvector/pgvector:pg17"),
      fixture("cubby-test-pg", "docker.io/pgvector/pgvector:pg17"),
    ];
    await writeFile(
      path.join(directory, "container"),
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif (args[0] === 'list') console.log(${JSON.stringify(JSON.stringify(entries))});\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "test-services.ts"), "--prune"],
      {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls: string[][] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.filter((args) => args[0] === "stop"),
      [["stop", "--time", "5", dead]],
    );
    assert.deepEqual(
      calls.filter((args) => args[0] === "delete"),
      [["delete", dead]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
