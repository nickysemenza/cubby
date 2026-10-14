import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generatedHeader,
  removeExtraArtifacts,
} from "./generator/artifacts.ts";

test("cache restoration prunes retired output directories without deleting handwritten files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cubby-artifact-pruning-"));
  const current = "apps/web/src/current/generated/current.gen.ts";
  const retired = "apps/web/src/retired/generated/old.gen.ts";
  const handwritten = "apps/web/src/retired/generated/manual.gen.ts";
  try {
    await mkdir(join(root, "apps/web/src/current/generated"), {
      recursive: true,
    });
    await mkdir(join(root, "apps/web/src/retired/generated"), {
      recursive: true,
    });
    await writeFile(
      join(root, current),
      generatedHeader + "export const current = true;\n",
    );
    await writeFile(
      join(root, retired),
      generatedHeader + "export const retired = true;\n",
    );
    await writeFile(
      join(root, handwritten),
      "export const handwritten = true;\n",
    );

    assert.deepEqual(
      await removeExtraArtifacts(root, [{ relativePath: current }]),
      [retired],
    );
    await assert.rejects(readFile(join(root, retired)), { code: "ENOENT" });
    assert.match(
      await readFile(join(root, current), "utf8"),
      /export const current/u,
    );
    assert.match(
      await readFile(join(root, handwritten), "utf8"),
      /export const handwritten/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
