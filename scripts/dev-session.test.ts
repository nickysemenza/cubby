import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveDevProfile } from "./lib/dev-profile.ts";

// Mixed revisions must not mark a live legacy supervisor/runtime stopped:
// start and reset rely on the same stop boundary before replacing state/data.
// Invoke Node directly: package-manager dependency repair can prune modules
// underneath concurrently running script tests.
test("down preserves live legacy sessions and reports how to resolve ownership", () => {
  const root = resolve(import.meta.dirname, "..");
  const instance = `synthetic_identity_${process.pid}`;
  const profile = resolveDevProfile(root, { CUBBY_DEV_INSTANCE: instance });
  const file = join(profile.stateDir, "session.json");
  const legacy = execFileSync(
    "ps",
    ["-p", String(process.pid), "-o", "lstart="],
    {
      encoding: "utf8",
    },
  ).trim();
  mkdirSync(profile.stateDir, { recursive: true });
  try {
    for (const runtime of [false, true]) {
      const session = JSON.stringify({
        schemaVersion: 1,
        id: profile.id,
        profile: "offline",
        origin: profile.origin,
        database: profile.name,
        stateDir: profile.stateDir,
        supervisorPid: runtime ? 2147483647 : process.pid,
        supervisorIdentity: legacy,
        ...(runtime
          ? { runtimePid: process.pid, runtimeIdentity: legacy }
          : {}),
        startedAt: new Date().toISOString(),
        readiness: "ready",
        explorerURL: `${profile.origin}/cdn-cgi/local/explorer`,
        inspectorURL: `http://localhost:${profile.inspectorPort}`,
        phases: {},
      });
      writeFileSync(file, session);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(
            createRequire(join(profile.webRoot, "package.json")).resolve("tsx"),
          ).href,
          "tooling/dev/index.ts",
          "down",
        ],
        {
          cwd: profile.webRoot,
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, CUBBY_DEV_INSTANCE: instance },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`PID ${process.pid}.*unknown.*stop`, "u"),
      );
      assert.equal(readFileSync(file, "utf8"), session);
      process.kill(process.pid, 0);
    }
  } finally {
    rmSync(profile.stateDir, { recursive: true, force: true });
  }
});
