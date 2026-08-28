import assert from "node:assert/strict";
import test from "node:test";
import { cargoMetadataSchema } from "./ensure-wasm.ts";

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
