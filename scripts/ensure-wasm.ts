#!/usr/bin/env node
// Nx owns artifact storage and eviction. This entrypoint supplies the Rust
// inputs outside Nx's workspace (see rust-fingerprint.ts) plus the wasm
// toolchain versions, and runs the cached `wasm` target.
//
//   ensure-wasm.ts                ensure packages/wasm is current
//   ensure-wasm.ts --fingerprint  print the cache key (Nx runtime input)
//
// An unchanged checkout is an Nx cache hit (~1 s), which also restores any
// output file that is missing or changed.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
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

const WASM_RELEASE_PROFILE = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
  CARGO_PROFILE_RELEASE_LTO: "true",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
  CARGO_PROFILE_RELEASE_PANIC: "abort",
  CARGO_PROFILE_RELEASE_INCREMENTAL: "false",
};

const fingerprint = () => {
  // Match scripts/build-wasm.sh's environment so the key tracks what it builds.
  process.env.CARGO_TARGET_DIR ??= join(homedir(), ".cache/cubby/cargo-target");
  // scripts/build-wasm.sh sets the release profile through CARGO_PROFILE_RELEASE_*
  // (member profiles are ignored in the workspace, and wasm-pack only takes
  // --release). Mirror it here so the key tracks the profile.
  Object.assign(process.env, WASM_RELEASE_PROFILE);
  const extra = [
    command("wasm-pack", ["--version"]),
    readFileSync(join(ROOT, "scripts/build-wasm.sh"), "utf8"),
  ];
  // wasm-pack can provision its own optimizer when none is installed on PATH.
  try {
    extra.push(command("wasm-opt", ["--version"]));
  } catch {
    extra.push("wasm-pack-managed optimizer");
  }
  return rustFingerprint(resolve(ROOT, "Cargo.toml"), extra);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--fingerprint") console.log(fingerprint());
  else runNxTarget("wasm");
}
