import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { aiAnalysis } from "~/server/db/schema";

import { createUploadedImageRecord } from "./image";
import { loadImageAnalysisSummaries } from "./image-analysis-summary";

const ctx = withTestDb();

// History must not displace the newest live local row, including malformed
// newest results. Missing keys default to empty arrays, explicit null is
// invalid, and equal timestamps use the retained history's descending ID tie.
it("selects newest local summary evidence without changing null or missing semantics", async () => {
  const images: Awaited<ReturnType<typeof createUploadedImageRecord>>[] = [];
  for (let index = 0; index < 7; index++)
    images.push(
      await createUploadedImageRecord(ctx.db, {
        key: `tests/synthetic-summary-${index}.jpg`,
        filename: `synthetic-${index}.jpg`,
        contentType: "image/jpeg",
        size: 512,
      }),
    );
  let sequence = 0;
  const add = (
    index: number,
    result: unknown,
    extra: Partial<typeof aiAnalysis.$inferInsert> = {},
  ) =>
    getDb(ctx.db)
      .insert(aiAnalysis)
      .values({
        entityKind: "image",
        entityId: images[index]!.id,
        feature: "photo-local-analysis",
        model: "synthetic-local",
        promptVersion: String(sequence++),
        inputFingerprint: "synthetic-input",
        result: result === null ? sql`'null'::jsonb` : result,
        createdAt: new Date("2024-01-02T00:00:00Z"),
        ...extra,
      });
  await add(
    0,
    { classifications: [{ identifier: "Older", confidence: 1 }] },
    { createdAt: new Date("2024-01-01T00:00:00Z") },
  );
  await add(0, {
    classifications: [{ identifier: "Newest", confidence: 0.9 }],
    recognizedText: [{ text: "SYNTHETIC", confidence: 0.8 }],
    featurePrint: "unused",
  });
  await add(
    0,
    { classifications: [{ identifier: "Deleted", confidence: 1 }] },
    { createdAt: new Date("2024-01-03T00:00:00Z"), deletedAt: new Date() },
  );
  await add(
    0,
    { classifications: [{ identifier: "Other feature", confidence: 1 }] },
    { feature: "synthetic-other", createdAt: new Date("2024-01-04T00:00:00Z") },
  );
  await add(
    1,
    { classifications: [{ identifier: "Do not resurrect", confidence: 1 }] },
    { createdAt: new Date("2024-01-01T00:00:00Z") },
  );
  await add(1, null);
  await add(2, {});
  await add(3, { classifications: null, recognizedText: [] });
  const [lowId, highId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  await add(
    4,
    { classifications: [{ identifier: "Tie lower", confidence: 1 }] },
    { id: lowId },
  );
  await add(
    4,
    { classifications: [{ identifier: "Tie higher", confidence: 1 }] },
    { id: highId },
  );
  await add(5, {
    classifications: [{ identifier: "Not requested", confidence: 1 }],
  });

  const result = await loadImageAnalysisSummaries(ctx.db, [
    ...images.slice(0, 5).map((row) => row.shortcode),
    images[0]!.shortcode,
    images[6]!.shortcode,
  ]);
  expect([...result.keys()].sort()).toEqual(
    [images[0]!.shortcode, images[2]!.shortcode, images[4]!.shortcode].sort(),
  );
  expect(result.get(images[0]!.shortcode)).toEqual({
    description: null,
    classifications: ["Newest"],
    recognizedText: "SYNTHETIC",
  });
  expect(result.get(images[2]!.shortcode)).toEqual({
    description: null,
    classifications: [],
    recognizedText: null,
  });
  expect(result.get(images[4]!.shortcode)?.classifications).toEqual([
    "Tie higher",
  ]);
});
