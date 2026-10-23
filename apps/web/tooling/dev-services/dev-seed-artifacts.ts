import path from "node:path";
import { runOrThrow } from "cubby/tooling/run";

/** Corpus imports execute application code, including generated bindings and WASM. */
export async function ensureDevSeedArtifacts(root: string): Promise<void> {
  for (const target of ["wasm", "generate"])
    await runOrThrow(
      process.execPath,
      [path.join(root, "scripts/ensure.ts"), target],
      { cwd: root, stdio: "inherit" },
    );
}
