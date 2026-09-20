#!/usr/bin/env node
// Nx owns artifact storage and eviction. This entrypoint supplies the Rust
// inputs outside Nx's workspace (see rust-fingerprint.ts) plus the wasm
// toolchain versions, and runs the cached `wasm` target.
//
//   ensure-wasm.ts                ensure packages/wasm is current
//   ensure-wasm.ts --fingerprint  print the cache key (Nx runtime input)
//   ensure-wasm.ts --stamp        record the key inside packages/wasm (the
//                                 `wasm` script runs this after wasm-pack)
//
// A verified Nx cache hit still costs seconds: with the daemon off Nx
// re-hashes every input and removes/re-copies the output directory. So, as
// ensure-apple-ffi.ts does for the xcframework, the key is also written inside
// the package (it restores with the cache) and a matching marker short-circuits
// before Nx is involved. The marker is deliberately not an Nx input — it is an
// output of the build, like packages/wasm/package.json and .gitignore, which
// wasm-pack rewrites byte-identically so the cache key stays stable.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ROOT,
  command,
  rustFingerprint,
  runNxTarget,
} from "./rust-fingerprint.ts";

export { sourceDigest, sourceInputs } from "./rust-fingerprint.ts";

export const cargoMetadataSchema = z.object({
  packages: z.array(
    z.object({
      manifest_path: z.string(),
      source: z.string().nullable(),
    }),
  ),
});

const WASM_DIR = join(ROOT, "packages/wasm");
const BINARY = "recipebridge_bg.wasm";
const MARKER = ".fingerprint";

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

// The binary must exist too: a marker alone survives a partial clean.
export const wasmIsCurrent = (key: string, directory = WASM_DIR) =>
  existsSync(join(directory, BINARY)) &&
  existsSync(join(directory, MARKER)) &&
  readFileSync(join(directory, MARKER), "utf8").trim() === key;

export const stampWasm = (key: string, directory = WASM_DIR) =>
  writeFileSync(join(directory, MARKER), `${key}\n`);

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2];
  if (mode === "--fingerprint") {
    console.log(fingerprint());
  } else if (mode === "--stamp") {
    stampWasm(fingerprint());
  } else if (wasmIsCurrent(fingerprint())) {
    console.log("ensure-wasm: packages/wasm is current");
  } else {
    runNxTarget("wasm");
  }
}
