import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Failure modes: Docker's inspect shape bypasses the identity guard; down
// removes the volume; an unrelated container sharing the fixed name is stopped.
test("Docker dev down preserves the owned volume and refuses a foreign database", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cubby-docker-db-"));
  const log = path.join(directory, "calls.jsonl");
  try {
    const config = {
      Name: "/cubby-dev-pg",
      State: { Status: "running" },
      Config: {
        Image: "docker.io/pgvector/pgvector:pg17",
        Env: [
          "POSTGRES_USER=postgres",
          "POSTGRES_PASSWORD=password",
          "POSTGRES_DB=cubby_dev",
        ],
      },
      Mounts: [
        {
          Type: "volume",
          Name: "cubby-dev-pg-data",
          Destination: "/cubby-devdata",
        },
      ],
      NetworkSettings: {
        Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
      },
    };
    await writeFile(
      path.join(directory, "docker"),
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif(args[0]==='ps') console.log('synthetic-container');\nif(args[0]==='inspect') { const entry=${JSON.stringify(config)}; if(process.env.FOREIGN_DB) entry.Mounts[0].Name='foreign-data'; console.log(JSON.stringify([entry])); }\n`,
      { mode: 0o755 },
    );
    const run = (foreign: boolean) =>
      spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "dev-db.ts"), "down"],
        {
          env: {
            ...process.env,
            CUBBY_DEV_SERVICES: "docker",
            PATH: `${directory}:${process.env.PATH}`,
            FOREIGN_DB: foreign ? "1" : "",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
    const owned = run(false);
    assert.equal(owned.status, 0, owned.stderr);
    const calls: string[][] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      calls.some(
        (args) => args[0] === "stop" && args.at(-1) === "cubby-dev-pg",
      ),
    );
    assert.ok(
      calls.some((args) => args[0] === "rm" && args.at(-1) === "cubby-dev-pg"),
    );
    assert.ok(
      calls.every(
        (args) =>
          !args.includes("--volumes") &&
          !args.includes("-v") &&
          args[0] !== "volume",
      ),
    );
    await writeFile(log, "");
    const foreign = run(true);
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /Refusing to operate/);
    const foreignCalls: string[][] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      foreignCalls.every((args) => args[0] !== "stop" && args[0] !== "rm"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
