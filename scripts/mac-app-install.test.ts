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
import { installMacApp } from "./lib/mac-app-install.ts";

// Failure modes: a bad copy replaces the installed binary; a foreign app is
// overwritten; termination happens before verification; a failed swap loses
// the old app. Real filesystem staging covers the first three boundaries.
test("Mac installation verifies staged bytes before stopping and replacing the owned app", () => {
  const root = mkdtempSync(join(tmpdir(), "cubby-install-"));
  const source = join(root, "build.app");
  const destination = join(root, "Cubby.app");
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, "binary"), "new");
  writeFileSync(join(destination, "binary"), "old");
  const events: string[] = [];
  try {
    installMacApp(
      source,
      destination,
      (app) => {
        events.push(readFileSync(join(app, "binary"), "utf8"));
      },
      () => {
        events.push("stop");
        assert.equal(readFileSync(join(destination, "binary"), "utf8"), "old");
      },
    );
    assert.deepEqual(events, ["new", "old", "new", "stop"]);
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
    writeFileSync(join(source, "binary"), "bad");
    assert.throws(
      () =>
        installMacApp(
          source,
          destination,
          (app) => {
            if (readFileSync(join(app, "binary"), "utf8") === "bad")
              throw new Error("bad signature");
          },
          () => assert.fail("must not stop"),
        ),
      /bad signature/,
    );
    assert.equal(readFileSync(join(destination, "binary"), "utf8"), "new");
    writeFileSync(join(source, "binary"), "valid");
    assert.throws(
      () =>
        installMacApp(
          source,
          destination,
          (app) => {
            if (app === destination) throw new Error("foreign app");
          },
          () => assert.fail("must not stop"),
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
test("Mac installation reports retained backups without failing a successful replacement", () => {
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
    backup = installMacApp(
      source,
      destination,
      () => {},
      () => {},
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
