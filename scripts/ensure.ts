#!/usr/bin/env node
// One artifact entrypoint; Nx owns cached generation/builds and restoration.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT } from "./rust-fingerprint.ts";

const usage =
  "Usage: ensure.ts generate [--force|--postinstall] | wasm [--build|--fingerprint] | apple-ffi [--build|--fingerprint]";
const [target, mode, ...extra] = process.argv.slice(2);
const validMode =
  target === "generate"
    ? [undefined, "--force", "--postinstall"].includes(mode)
    : (target === "wasm" || target === "apple-ffi") &&
      [undefined, "--build", "--fingerprint"].includes(mode);
if (!validMode || extra.length > 0) throw new Error(usage);

function runNxTarget(target: string, args: string[] = []) {
  // Enclosing Nx tasks declare their prerequisites; nested Nx is refused.
  if (process.env.NX_TASK_TARGET_PROJECT !== undefined) return;
  let nx: string;
  try {
    nx = fileURLToPath(import.meta.resolve("nx/bin/nx.js"));
  } catch {
    throw new Error(
      `cannot resolve nx; run \`pnpm install --frozen-lockfile\` before ${target}`,
    );
  }
  execFileSync(
    process.execPath,
    [nx, "run", `cubby-checks:${target}`, ...args],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NX_DAEMON: "false" },
    },
  );
}

if (target === "generate") {
  if (
    mode === "--postinstall" &&
    !existsSync(join(ROOT, "apps/web/node_modules"))
  ) {
    console.log("generate: skipped (filtered install without apps/web)");
  } else if (
    mode === "--postinstall" &&
    process.env.CUBBY_SKIP_POSTINSTALL_GENERATE === "1"
  ) {
    console.log("generate: skipped (CUBBY_SKIP_POSTINSTALL_GENERATE)");
  } else {
    runNxTarget("generate", mode === "--force" ? ["--skip-nx-cache"] : []);
    // Cache restoration writes expected files but cannot remove retired outputs.
    const { ARTIFACT_MANIFEST, removeExtraArtifacts } =
      await import("../apps/web/generator/artifacts.ts");
    const manifest = join(ROOT, ARTIFACT_MANIFEST);
    if (existsSync(manifest)) {
      const paths: string[] = JSON.parse(readFileSync(manifest, "utf8"));
      for (const path of await removeExtraArtifacts(
        ROOT,
        paths.map((relativePath) => ({ relativePath })),
      ))
        console.log(`generate: removed stale ${path}`);
    }
  }
} else if (target === "wasm") {
  const { prepareWasm } = await import("./wasm.ts");
  prepareWasm(mode, () => runNxTarget("wasm"));
} else {
  const { prepareAppleFfi } = await import("./apple-ffi.ts");
  prepareAppleFfi(mode, () => runNxTarget("apple-ffi"));
}
