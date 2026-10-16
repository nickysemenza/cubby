import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureDevSeedArtifacts } from "./lib/dev-seed-artifacts.ts";

// Seed imports cannot run before both build prerequisites, nor after a failure.
test("prepares WASM before generated seed inputs and propagates failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cubby-seed-build-"));
  try {
    await mkdir(path.join(root, "scripts"));
    const ensure = path.join(root, "scripts/ensure.ts");
    const log = path.join(root, "calls");
    await writeFile(
      ensure,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n');`,
    );
    await ensureDevSeedArtifacts(root);
    assert.equal(await readFile(log, "utf8"), "wasm\ngenerate\n");
    await writeFile(log, "");
    await writeFile(
      ensure,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n'); process.exit(1);`,
    );
    await assert.rejects(ensureDevSeedArtifacts(root), /exited 1/u);
    assert.equal(await readFile(log, "utf8"), "wasm\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
