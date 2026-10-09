import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cargoMetadataSchema,
  sourceDigest,
  sourceInputs,
  stampWasm,
  wasmIsCurrent,
} from "./ensure-wasm.ts";

test("offline startup ignores inherited Rust logging but preserves compiler flag freshness", () => {
  const script = fileURLToPath(new URL("./ensure-wasm.ts", import.meta.url));
  const key = (env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [script, "--fingerprint"], {
      env,
      encoding: "utf8",
    }).trim();
  const offline = { ...process.env };
  delete offline.RUST_LOG;
  const original = key(offline);
  assert.equal(key({ ...offline, RUST_LOG: "debug" }), original);
  assert.notEqual(key({ ...offline, RUSTFLAGS: "-C debuginfo=1" }), original);
});

test("WASM inputs follow contents across checkouts, including local dependency assets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cubby-wasm-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  for (const path of [first, second]) {
    mkdirSync(path);
    writeFileSync(join(path, "lib.rs"), "pub fn example() {}\n");
    writeFileSync(join(path, "data.json"), '{"value":1}');
  }
  const original = sourceDigest(first);
  utimesSync(join(second, "lib.rs"), 1, 1);
  assert.equal(sourceDigest(second), original);
  const dependency = join(root, "middle");
  mkdirSync(dependency);
  writeFileSync(join(dependency, "lib.rs"), "pub fn dependency() {}\n");
  assert.equal(
    sourceInputs([first, dependency], first),
    sourceInputs([dependency, second], second),
  );
  writeFileSync(join(second, "data.json"), '{"value":2}');
  utimesSync(join(second, "data.json"), 1, 1);
  assert.notEqual(sourceDigest(second), original);
  rmSync(join(second, "data.json"));
  assert.notEqual(sourceDigest(second), original);
  mkdirSync(join(first, "target"));
  writeFileSync(join(first, "target", "artifact.wasm"), "ignored build output");
  assert.equal(sourceDigest(first), original);
  // Finder and Claude Code state must not perturb the key (see PRUNE).
  writeFileSync(join(first, ".DS_Store"), "finder");
  mkdirSync(join(first, ".claude"));
  writeFileSync(join(first, ".claude", "settings.local.json"), "{}");
  assert.equal(sourceDigest(first), original);
  assert.throws(() => sourceDigest(join(root, "missing")));
});

test("cargo metadata ingress requires package source and manifest path", () => {
  const parsed = cargoMetadataSchema.parse({
    packages: [
      {
        manifest_path: "/workspace/recipebridge/Cargo.toml",
        source: null,
      },
    ],
  });
  assert.equal(parsed.packages[0]?.source, null);
  assert.equal(
    cargoMetadataSchema.safeParse({ packages: [{ source: null }] }).success,
    false,
  );
  assert.equal(
    cargoMetadataSchema.safeParse({ packages: "not-an-array" }).success,
    false,
  );
});

test("the in-package marker short-circuits only when it matches and every binary exists", (t) => {
  const pkg = mkdtempSync(join(tmpdir(), "cubby-wasm-marker-"));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  assert.equal(wasmIsCurrent("key", pkg), false);
  stampWasm("key", pkg);
  assert.equal(wasmIsCurrent("key", pkg), false);
  // A build interrupted after the first wasm-pack run is still stale.
  mkdirSync(join(pkg, "worker"));
  writeFileSync(join(pkg, "worker/recipebridge_bg.wasm"), "binary");
  mkdirSync(join(pkg, "browser"));
  writeFileSync(join(pkg, "browser/recipebridge_bg.wasm"), "binary");
  assert.equal(wasmIsCurrent("key", pkg), false);
  mkdirSync(join(pkg, "cookbook"));
  writeFileSync(join(pkg, "cookbook/recipebridge_cookbook_bg.wasm"), "binary");
  assert.equal(wasmIsCurrent("key", pkg), true);
  assert.equal(wasmIsCurrent("other", pkg), false);
  stampWasm("other", pkg);
  assert.equal(wasmIsCurrent("other", pkg), true);
});
