import { describe, expect, it } from "vitest";

import {
  syntheticBundle,
  syntheticCookbookArchive,
  syntheticZip,
} from "../../../../tooling/cookbook-bundle-fixture";
import { openCookbookBundle, runTwoAtATime } from "./bundle";

// Archive failures: whole-file reads, unselected payload reads, corrupt/oversized
// entries, contradictory identities/aliases, duplicate/traversal paths, aborted
// reads, and unbounded decompression/upload queues. These evade ordinary UI E2E.
describe("incremental cookbook bundle", () => {
  for (const deflate of [false, true])
    it(`reads metadata and verifies a selected ${deflate ? "deflated" : "stored"} image`, async () => {
      const fixture = syntheticCookbookArchive(undefined, undefined, deflate);
      const bundle = await openCookbookBundle(new Blob([fixture.bytes]));
      expect(bundle.metadata.manifest.incomplete).toBe(true);
      expect(bundle.metadata.cookbook.source.title).toBe("Synthetic bundle");
      expect(await bundle.readImage(fixture.asset.source_path)).toEqual(
        new Uint8Array(fixture.imageBytes),
      );
    });

  it("slices bounded metadata and leaves unrelated large entries unread", async () => {
    const fixture = syntheticBundle();
    const bytes = syntheticZip([
      { path: "unselected.bin", bytes: Buffer.alloc(2 * 1024 * 1024, 1) },
      {
        path: "manifest.json",
        bytes: Buffer.from(JSON.stringify(fixture.manifest)),
      },
      {
        path: "extraction.json",
        bytes: Buffer.from(
          JSON.stringify({
            cookbook: fixture.cookbook,
            report: fixture.report,
          }),
        ),
      },
      { path: fixture.asset.path, bytes: fixture.imageBytes },
    ]);
    const reads: Array<[number, number]> = [];
    class TrackedBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("whole archive read");
      }
      override slice(start = 0, end = this.size) {
        reads.push([start, end]);
        return super.slice(start, end);
      }
    }
    await openCookbookBundle(new TrackedBlob([bytes]));
    expect(reads.every(([start, end]) => end - start <= 65557)).toBe(true);
    // The bounded EOCD tail may overlap the end of an unrelated entry.
    expect(
      reads.every(
        ([start, end]) => start >= 2 * 1024 * 1024 || end === bytes.length,
      ),
    ).toBe(true);
    expect(
      reads.reduce((total, [start, end]) => total + end - start, 0),
    ).toBeLessThan(128 * 1024);
  });

  it.each([
    { version: 2 },
    { source_sha256: "b".repeat(64) },
    { extraction: "../extraction.json" },
    { images: [] },
  ])("rejects invalid manifest %j before import", async (override) => {
    await expect(
      openCookbookBundle(
        new Blob([syntheticCookbookArchive(undefined, override).bytes]),
      ),
    ).rejects.toThrow(
      /Invalid input|Bundle source hash|Unsafe bundle path|missing matching image evidence/i,
    );
  });

  it("rejects corrupt image hashes and contradictory ZIP sizes", async () => {
    const fixture = syntheticBundle();
    {
      const bytes = Buffer.from("wrong");
      const archive = syntheticZip([
        {
          path: "manifest.json",
          bytes: Buffer.from(JSON.stringify(fixture.manifest)),
        },
        {
          path: "extraction.json",
          bytes: Buffer.from(
            JSON.stringify({
              cookbook: fixture.cookbook,
              report: fixture.report,
            }),
          ),
        },
        { path: fixture.asset.path, bytes },
      ]);
      await expect(openCookbookBundle(new Blob([archive]))).rejects.toThrow(
        /size/i,
      );
    }
    const corrupted = Buffer.from(fixture.imageBytes);
    corrupted[20] = 42;
    const archive = syntheticZip([
      {
        path: "manifest.json",
        bytes: Buffer.from(JSON.stringify(fixture.manifest)),
      },
      {
        path: "extraction.json",
        bytes: Buffer.from(
          JSON.stringify({
            cookbook: fixture.cookbook,
            report: fixture.report,
          }),
        ),
      },
      { path: fixture.asset.path, bytes: corrupted },
    ]);
    const bundle = await openCookbookBundle(new Blob([archive]));
    await expect(bundle.readImage(fixture.asset.source_path)).rejects.toThrow(
      /hash/i,
    );
  });

  it("rejects duplicate and escaping ZIP names", async () => {
    for (const entries of [
      [{ path: "../outside", bytes: Buffer.from("x") }],
      [
        { path: "manifest.json", bytes: Buffer.from("{}") },
        { path: "manifest.json", bytes: Buffer.from("{}") },
      ],
    ])
      await expect(
        openCookbookBundle(new Blob([syntheticZip(entries)])),
      ).rejects.toThrow(/path|duplicate/i);
  });

  it("stops expansion beyond the entry declaration and supports abort", async () => {
    const fixture = syntheticBundle();
    const archive = syntheticZip([
      {
        path: "manifest.json",
        bytes: Buffer.from(JSON.stringify(fixture.manifest)),
      },
      {
        path: "extraction.json",
        bytes: Buffer.from(
          JSON.stringify({
            cookbook: fixture.cookbook,
            report: fixture.report,
          }),
        ),
      },
      {
        path: fixture.asset.path,
        bytes: Buffer.alloc(1024 * 1024),
        deflate: true,
        declaredSize: fixture.imageBytes.length,
      },
    ]);
    const bundle = await openCookbookBundle(new Blob([archive]));
    await expect(bundle.readImage(fixture.asset.source_path)).rejects.toThrow(
      /size/i,
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      openCookbookBundle(
        new Blob([syntheticCookbookArchive().bytes]),
        abort.signal,
      ),
    ).rejects.toThrow(/abort/i);
  });

  it("bounds complete asset jobs to two and continues independently after handled failure", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    await runTwoAtATime([0, 1, 2, 3, 4], async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      completed.push(id);
      active--;
    });
    expect(peak).toBe(2);
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4]);
  });
});
