import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
