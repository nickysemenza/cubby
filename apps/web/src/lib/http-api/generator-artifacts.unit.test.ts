import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { writeArtifacts } from "../../../../../scripts/generator/artifacts";

it("preserves modification times for unchanged generated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cubby-artifacts-"));
  try {
    const artifact = { relativePath: "generated/example.json", source: "{}\n" };
    const path = join(root, artifact.relativePath);
    expect(await writeArtifacts(root, [artifact])).toEqual([
      artifact.relativePath,
    ]);
    const fixed = new Date("2020-01-01T00:00:00Z");
    await utimes(path, fixed, fixed);
    expect(await writeArtifacts(root, [artifact])).toEqual([]);
    expect((await stat(path)).mtimeMs).toBe(fixed.getTime());
    expect(
      await writeArtifacts(root, [
        { ...artifact, source: '{"changed":true}\n' },
      ]),
    ).toEqual([artifact.relativePath]);
    expect(await readFile(path, "utf8")).toBe('{"changed":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
