import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { LocalPhotoAnalysis } from "~/contracts/photo-import.contract";
import { getDb } from "~/server/db/helpers";
import { photoRunImage } from "~/server/db/schema";
import {
  readImageAnalysis,
  recordImageAnalysis,
} from "~/server/domains/image/operations/image-analysis.server";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { AppError } from "~/server/errors/app-error";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createImageFixture } from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

const makeAnalysis = (sha256: string): LocalPhotoAnalysis => ({
  analysisVersion: 1,
  analyzedAt: "2026-09-17T12:00:00.000Z",
  sha256,
  capturedAt: "2026-09-16T23:30:00.000Z",
  contentType: "image/png",
  width: 16,
  height: 16,
  classifications: [],
  recognizedText: [],
  featurePrint: { revision: "1", data: "AA==" },
  provenance: {
    source: "photoLibrary",
    localIdentifier: "photo-library-1",
    filename: "diagnostics.png",
  },
});

describe("image photo-analysis backfill", () => {
  const ctx = withTestDb();

  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  // Table-driven: each row names the invariant `recordAnalysis` enforces
  // (status/sha256 must describe the row the analysis attaches to) so a
  // regression in either guard fails a specifically-named case. The outcome
  // is captured as a plain value via `.then(onFulfilled, onRejected)` — never
  // branched on inside the test — so every `expect` below runs unconditionally.
  const cases = [
    {
      name: "sha256 mismatch",
      status: "UPLOADED" as const,
      storedSha256: "a".repeat(64),
      analysisSha256: "b".repeat(64),
      expectedOutcome: { saved: false, reason: "IMAGE_PRECONDITION_FAILED" },
      expectedStoredSha256: null,
    },
    {
      name: "image not yet UPLOADED",
      status: "PENDING" as const,
      storedSha256: "c".repeat(64),
      analysisSha256: "c".repeat(64),
      expectedOutcome: { saved: false, reason: "IMAGE_PRECONDITION_FAILED" },
      expectedStoredSha256: null,
    },
    {
      name: "UPLOADED image with matching bytes",
      status: "UPLOADED" as const,
      storedSha256: "d".repeat(64),
      analysisSha256: "d".repeat(64),
      expectedOutcome: { saved: true, reason: null },
      expectedStoredSha256: "d".repeat(64),
    },
  ];

  it.each(cases)(
    "$name",
    async ({
      status,
      storedSha256,
      analysisSha256,
      expectedOutcome,
      expectedStoredSha256,
    }) => {
      const fixture = await createImageFixture(ctx.db, "photo-analysis", {
        status,
        sha256: storedSha256,
      });
      const analysis = makeAnalysis(analysisSha256);

      const outcome = await (async () => {
        try {
          const result = await recordImageAnalysis(
            context(),
            fixture.shortcode,
            analysis,
          );
          return { saved: result.saved, reason: null };
        } catch (error) {
          return {
            saved: false,
            reason: error instanceof AppError ? error.reason : error,
          };
        }
      })();
      expect(outcome).toMatchObject(expectedOutcome);

      const stored = await readImageAnalysis(context(), fixture.shortcode);
      expect(stored?.sha256 ?? null).toBe(expectedStoredSha256);
    },
  );

  it("returns null when no analysis has been persisted for an UPLOADED image", async () => {
    const fixture = await createImageFixture(ctx.db, "photo-analysis-empty", {
      status: "UPLOADED",
      sha256: "e".repeat(64),
    });

    await expect(
      readImageAnalysis(context(), fixture.shortcode),
    ).resolves.toBeNull();
  });

  it("marks retained photo membership complete without a mutable RunTarget", async () => {
    const sha256 = "f".repeat(64);
    const fixture = await createImageFixture(
      ctx.db,
      "synthetic-photo-membership",
      { status: "UPLOADED", sha256 },
    );
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic photo member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "photo_inventory",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values({
        runId,
        imageId: parseEntityId("image", fixture.id),
        workKey: fixture.id,
        targetFingerprint: sha256,
        deviceWorkState: "running",
      });
    await recordImageAnalysis(
      context(),
      fixture.shortcode,
      makeAnalysis(sha256),
    );
    const read = () =>
      getDb(ctx.db).query.photoRunImage.findFirst({
        where: eq(photoRunImage.imageId, parseEntityId("image", fixture.id)),
      });
    expect(await read()).toMatchObject({ deviceWorkState: "completed" });
    const completed = await read();
    await recordImageAnalysis(
      context(),
      fixture.shortcode,
      makeAnalysis(sha256),
    );
    expect(await read()).toEqual(completed);
  });
});
