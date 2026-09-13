#!/usr/bin/env node
// Nx owns artifact storage and eviction. This entrypoint supplies the Rust
// inputs outside Nx's workspace (see rust-fingerprint.ts) plus the wasm
// toolchain versions, and runs the cached `wasm` target.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  command,
  rustFingerprint,
  runNxTarget,
} from "./rust-fingerprint.ts";

export {
  cargoMetadataSchema,
  sourceDigest,
  sourceInputs,
} from "./rust-fingerprint.ts";

const fingerprint = () => {
  const extra = [command("wasm-pack", ["--version"])];
  // wasm-pack can provision its own optimizer when none is installed on PATH.
  try {
    extra.push(command("wasm-opt", ["--version"]));
  } catch {
    extra.push("wasm-pack-managed optimizer");
  }
  return rustFingerprint(resolve(ROOT, "recipebridge/Cargo.toml"), extra);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--fingerprint") {
    console.log(fingerprint());
  } else {
    runNxTarget("wasm");
  }
}
