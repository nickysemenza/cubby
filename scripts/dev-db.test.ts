import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveDevProfile } from "./lib/dev-profile.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

// The low-level migration launcher must reject inherited production targets
// before invoking a container command, just as the development supervisor does.
test("low-level database tools validate inherited database overrides", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "dev-db.ts"), "--unknown"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "postgresql://synthetic:synthetic@db.example.test/cubby",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing inherited DATABASE_URL/u);
  assert.doesNotMatch(result.stderr, /Usage:/u);
});

// Reset resolves the owned direct endpoint twice. It must carry its validated
// URL overrides along with the address, rather than rejecting itself on pass 2.
test("reset preserves consistent database overrides across repeated owned binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cubby-reset-binding-"));
  const root = path.resolve(import.meta.dirname, "..");
  const profile = resolveDevProfile(root, {
    CUBBY_DEV_INSTANCE: "synthetic_reset",
  });
  const container = {
    id: "cubby-dev-pg",
    status: {
      state: "running",
      networks: [{ ipv4Address: "192.168.1.50/24" }],
    },
    configuration: {
      image: { reference: "docker.io/pgvector/pgvector:pg17" },
      initProcess: {
        environment: [
          "POSTGRES_USER=postgres",
          "POSTGRES_PASSWORD=password",
          "POSTGRES_DB=cubby_dev",
        ],
      },
      publishedPorts: [
        { hostAddress: "127.0.0.1", hostPort: 55432, containerPort: 5432 },
      ],
    },
  };
  try {
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      path.join(directory, "container"),
      `#!${process.execPath}\nconst command = process.argv[2]; if (command === 'list' || command === 'inspect') console.log(JSON.stringify([${JSON.stringify(container)}])); if (command === 'run') { console.error('synthetic-stop-after-rebind'); process.exit(1); }\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript,Object.defineProperty(process,'platform',{value:'darwin'})",
        path.join(import.meta.dirname, "dev-db.ts"),
        "reset",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          CUBBY_DEV_SERVICES: "apple",
          CUBBY_DEV_INSTANCE: "synthetic_reset",
          DATABASE_URL: profile.databaseUrl,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /synthetic-stop-after-rebind/u);
    assert.doesNotMatch(result.stderr, /Refusing inherited DATABASE_URL/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
