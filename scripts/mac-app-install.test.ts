import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { installMacApp } from "./lib/mac-app-install.ts";

// A signalled app can still capture while shutdown drains. Its bundle must
// remain at the approved path until its process has actually exited.
test("Mac installation waits for process exit before moving the approved bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-install-shutdown-"));
  const source = join(root, "build.app");
  const destination = join(root, "Cubby.app");
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, "binary"), "new");
  writeFileSync(join(destination, "binary"), "old");
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 60)); console.log('ready'); setInterval(() => {}, 1000)",
  ]);
  let stopped: Promise<void> | undefined;
  try {
    await once(child.stdout, "data");
    await installMacApp(
      source,
      destination,
      () => {},
      () => {
        child.kill("SIGTERM");
        stopped = once(child, "exit").then(() => {
          assert.equal(
            readFileSync(join(destination, "binary"), "utf8"),
            "old",
          );
        });
        return stopped;
      },
    );
    await stopped;
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

// Failure modes: a bad copy replaces the installed binary; a foreign app is
// overwritten; termination happens before verification; a failed swap loses
// the old app. Real filesystem staging covers the first three boundaries.
test("Mac installation verifies staged bytes before stopping and replacing the owned app", async () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-install-"));
  const source = join(root, "build.app");
  const destination = join(root, "Cubby.app");
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, "binary"), "new");
  writeFileSync(join(destination, "binary"), "old");
  const events: string[] = [];
  try {
    await installMacApp(
      source,
      destination,
      (app) => {
        events.push(readFileSync(join(app, "binary"), "utf8"));
      },
      async () => {
        events.push("stop");
        assert.equal(readFileSync(join(destination, "binary"), "utf8"), "old");
      },
    );
    assert.deepEqual(events, ["new", "old", "new", "stop"]);
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
    writeFileSync(join(source, "binary"), "bad");
    await assert.rejects(
      () =>
        installMacApp(
          source,
          destination,
          (app) => {
            if (readFileSync(join(app, "binary"), "utf8") === "bad")
              throw new Error("bad signature");
          },
          async () => assert.fail("must not stop"),
        ),
      /bad signature/,
    );
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
    writeFileSync(join(source, "binary"), "valid");
    await assert.rejects(
      () =>
        installMacApp(
          source,
          destination,
          (app) => {
            if (app === destination) throw new Error("foreign app");
          },
          async () => assert.fail("must not stop"),
        ),
      /foreign app/,
    );
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The installed app may be root-owned while /Applications allows replacement.
// Unremovable previous bundle contents must not prevent launching the new app.
test("Mac installation reports retained backups without failing a successful replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-install-permissions-"));
  const source = join(root, "build.app");
  const destination = join(root, "Cubby.app");
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, "binary"), "new");
  writeFileSync(join(destination, "binary"), "old");
  chmodSync(destination, 0o555);
  let backup: string | undefined;
  try {
    backup = await installMacApp(
      source,
      destination,
      () => {},
      async () => {},
    );
    assert.ok(backup, "cleanup permission failure retains the previous app");
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
    assert.equal(readFileSync(join(backup, "binary"), "utf8"), "old");
  } finally {
    if (backup) chmodSync(backup, 0o755);
    if (existsSync(destination)) chmodSync(destination, 0o755);
    for (const directory of readdirSync(root)) {
      const old = join(root, directory);
      if (directory.endsWith(".previous.app") && existsSync(old))
        chmodSync(old, 0o755);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
