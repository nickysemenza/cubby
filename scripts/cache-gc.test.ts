import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  NX_DAEMON_LOG,
  NX_WORKSPACE_DATA,
  parseFlags,
  SHARED_TARGETS,
  strayCacheEntries,
} from "./cache-gc.ts";

test("parseFlags defaults to report-only (no flags set)", () => {
  assert.deepEqual(parseFlags([]), {
    clean: false,
    sweep: false,
    resetTargets: false,
  });
});

test("parseFlags recognizes each flag independently", () => {
  assert.deepEqual(parseFlags(["--clean"]), {
    clean: true,
    sweep: false,
    resetTargets: false,
  });
  assert.deepEqual(parseFlags(["--sweep"]), {
    clean: false,
    sweep: true,
    resetTargets: false,
  });
  assert.deepEqual(parseFlags(["--reset-targets"]), {
    clean: false,
    sweep: false,
    resetTargets: true,
  });
});

test("parseFlags combines flags", () => {
  assert.deepEqual(parseFlags(["--clean", "--sweep", "--reset-targets"]), {
    clean: true,
    sweep: true,
    resetTargets: true,
  });
});

test("parseFlags rejects an unknown flag, including a near-miss spelling", () => {
  assert.throws(() => parseFlags(["--reset-target"]), /Unknown flag/);
  assert.throws(() => parseFlags(["--bogus"]), /Unknown flag/);
});

test("strayCacheEntries picks only the fixed set of obsolete entries", () => {
  const listing = [
    "cargo-pinned",
    "cubby-ffi-target",
    "graph-cargo-metadata.json",
    "graph-e2e-fixed.log",
    "graph-push-final.log",
    "openapi-generator-build",
    "pinned-cargo-bin",
    "recipebridge-target",
    "recipebridge-target-nopatch",
  ];
  assert.deepEqual(strayCacheEntries(listing), [
    "graph-cargo-metadata.json",
    "graph-e2e-fixed.log",
    "graph-push-final.log",
    "recipebridge-target-nopatch",
  ]);
});

test("strayCacheEntries never selects the live target dirs or long-lived tool caches", () => {
  const protectedEntries = [
    "cargo-pinned",
    "cubby-ffi-target",
    "openapi-generator-build",
    "pinned-cargo-bin",
    "recipebridge-target",
  ];
  assert.deepEqual(strayCacheEntries(protectedEntries), []);
});

test("strayCacheEntries ignores a similarly-named file that isn't actually a graph log", () => {
  assert.deepEqual(strayCacheEntries(["graph-notes.txt", "graphs.log"]), []);
});

test("the Nx daemon log path is scoped to the current checkout's workspace-data dir", () => {
  assert.equal(NX_DAEMON_LOG, join(NX_WORKSPACE_DATA, "d/daemon.log"));
});

test("shared targets cover exactly recipebridge and cubby-ffi", () => {
  assert.deepEqual(SHARED_TARGETS.map((target) => target.crate).sort(), [
    "cubby-ffi",
    "recipebridge",
  ]);
  for (const { crate, targetDir } of SHARED_TARGETS) {
    assert.ok(targetDir.endsWith(`${crate}-target`));
  }
});
