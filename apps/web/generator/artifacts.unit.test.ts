import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { generatedHeader, removeExtraArtifacts } from "./artifacts.ts";

test.each([
  [
    "apps/web/src/current/generated/current.gen.ts",
    "apps/web/src/retired/generated/old.gen.ts",
    "apps/web/src/retired/generated/manual.gen.ts",
  ],
  [
    "apps/apple/CubbyKit/Sources/CubbyAPI/Models/current.gen.swift",
    "apps/apple/CubbyKit/Sources/CubbyAPI/Client.gen.swift",
    "apps/apple/CubbyKit/Sources/CubbyAPI/manual.gen.swift",
  ],
])(
  "cache restoration prunes retired directories for %s without deleting handwritten files",
  async (current, retired, handwritten) => {
    const root = await mkdtemp(join(tmpdir(), "cubby-artifact-pruning-"));
    try {
      await mkdir(join(root, dirname(current)), {
        recursive: true,
      });
      await mkdir(join(root, dirname(retired)), {
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
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
