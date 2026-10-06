import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withKitPackageResolution } from "./apple-package-resolution.ts";

// Xcode app resolution must not change CubbyKit's owned pins; app-only pins
// can be serialized incidentally, but a changed Kit pin must fail acceptance.
test("app-only resolution leaves the Kit lockfile bytes unchanged, including after a failed build", async () => {
  for (const fails of [false, true]) {
    const root = mkdtempSync(path.join(tmpdir(), "cubby-package-resolution-"));
    const lock = path.join(root, "apps/apple/CubbyKit/Package.resolved");
    const kit = {
      identity: "synthetic-kit",
      location: "https://example.test/kit",
      state: { revision: "pinned" },
    };
    const original = JSON.stringify({ pins: [kit], originHash: "kit" });
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, original);
    writeFileSync(
      path.join(root, "apps/apple/packages.yml"),
      "packages:\n  SyntheticApp:\n    url: https://example.test/app\n",
    );
    writeFileSync(
      path.join(root, "apps/apple/project.yml"),
      "include:\n  - packages.yml\n",
    );
    try {
      const build = withKitPackageResolution(root, async () => {
        writeFileSync(
          lock,
          JSON.stringify({
            pins: [
              kit,
              {
                identity: "synthetic-app",
                location: "https://example.test/app",
                state: { revision: "app-pin" },
              },
            ],
            originHash: "app",
          }),
        );
        if (fails) throw new Error("synthetic build failure");
      });
      if (fails) await assert.rejects(build, /synthetic build failure/);
      else await build;
      assert.equal(readFileSync(lock, "utf8"), original);
      await assert.rejects(
        withKitPackageResolution(root, async () => {
          writeFileSync(
            lock,
            JSON.stringify({
              pins: [{ ...kit, state: { revision: "changed" } }],
            }),
          );
        }),
        /CubbyKit package pin changed/,
      );
      assert.equal(readFileSync(lock, "utf8"), original);
      // A build that deletes the lockfile still gets the Kit bytes back.
      await assert.rejects(
        withKitPackageResolution(root, async () => rmSync(lock)),
        /ENOENT/,
      );
      assert.equal(readFileSync(lock, "utf8"), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
