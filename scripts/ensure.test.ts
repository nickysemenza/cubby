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
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import {
  rustFingerprint,
  sourceDigest,
  sourceInputs,
} from "./rust-fingerprint.ts";

test("offline startup ignores inherited Rust logging but preserves compiler flag freshness", () => {
  const script = fileURLToPath(new URL("./ensure.ts", import.meta.url));
  const key = (env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [script, "wasm", "--fingerprint"], {
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
  t.onTestFinished(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  );
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

test("artifact keys isolate dependency graphs and include workspace profiles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cubby-artifact-graph-"));
  t.onTestFinished(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  );
  const put = (path: string, value: string) =>
    writeFileSync(join(root, path), value);
  const manifest =
    '[workspace]\nresolver = "3"\nmembers = ["core", "ffi", "cookbook", "binding", "test-only", "wasm-only"]\n';
  put(
    "Cargo.toml",
    manifest + '\n[profile.dist]\ninherits = "release"\nopt-level = "s"\n',
  );
  for (const name of [
    "core",
    "ffi",
    "cookbook",
    "binding",
    "test-only",
    "wasm-only",
  ]) {
    mkdirSync(join(root, name, "src"), { recursive: true });
    const deps =
      name === "ffi"
        ? '[dependencies]\ncore = { path = "../core" }\nbinding = { path = "../binding" }\n'
        : name === "core"
          ? '[dev-dependencies]\ntest-only = { path = "../test-only" }\n[dependencies]\nwasm-only = { path = "../wasm-only", optional = true }\n[features]\nwasm = ["dep:wasm-only"]\n'
          : "";
    put(
      `${name}/Cargo.toml`,
      `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n${deps}`,
    );
    put(`${name}/src/lib.rs`, "pub fn example() {}\n");
  }
  const key = (roots: string[], features: string[] = []) =>
    rustFingerprint(join(root, "Cargo.toml"), roots, [], features);
  const wasm = () => key(["core", "cookbook"], ["core/wasm"]);
  const apple = () => key(["ffi"]);
  const originalWasm = wasm();
  const originalApple = apple();
  put("ffi/src/lib.rs", "pub fn native_edit() {}\n");
  assert.equal(wasm(), originalWasm);
  assert.notEqual(apple(), originalApple);
  const editedApple = apple();
  put("cookbook/src/lib.rs", "pub fn epub_edit() {}\n");
  assert.equal(apple(), editedApple);
  assert.notEqual(wasm(), originalWasm);
  const editedWasm = wasm();
  put(
    "binding/Cargo.toml",
    '[package]\nname = "binding"\nversion = "0.2.0"\nedition = "2024"\n',
  );
  assert.equal(wasm(), editedWasm);
  assert.notEqual(apple(), editedApple);
  const bindingApple = apple();
  put("test-only/src/lib.rs", "pub fn test_helper_edit() {}\n");
  assert.equal(wasm(), editedWasm);
  assert.equal(apple(), bindingApple);
  put("wasm-only/src/lib.rs", "pub fn optional_binding_edit() {}\n");
  assert.notEqual(wasm(), editedWasm);
  assert.equal(apple(), bindingApple);
  put(
    "Cargo.toml",
    manifest + '\n[profile.dist]\ninherits = "release"\nopt-level = "z"\n',
  );
  assert.notEqual(apple(), bindingApple);
  const profileApple = apple();
  const profileWasm = wasm();
  put(
    "Cargo.toml",
    manifest +
      '\n[profile.dist]\ninherits = "release"\nopt-level = "z"\n[workspace.package]\nedition = "2024"\n[workspace.lints.clippy]\nunwrap_used = "deny"\n',
  );
  assert.notEqual(apple(), profileApple);
  assert.notEqual(wasm(), profileWasm);
});
