import assert from "node:assert/strict";
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
import {
  cargoMetadataSchema,
  sourceDigest,
  sourceInputs,
} from "./ensure-wasm.ts";

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
