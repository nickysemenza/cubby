import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { LocalPhotoAnalysis } from "~/contracts/photo-import.contract";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { AppError } from "~/server/errors/app-error";
import {
  productionImagePhotoAnalysisPorts,
  readImageAnalysis,
  recordImageAnalysis,
} from "~/server/image-browser.server";
import { createImageFixture } from "~/server/repo/repo.fixtures";
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
            productionImagePhotoAnalysisPorts,
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

      const stored = await readImageAnalysis(
        productionImagePhotoAnalysisPorts,
        context(),
        fixture.shortcode,
      );
      expect(stored?.sha256 ?? null).toBe(expectedStoredSha256);
    },
  );

  it("returns null when no analysis has been persisted for an UPLOADED image", async () => {
    const fixture = await createImageFixture(ctx.db, "photo-analysis-empty", {
      status: "UPLOADED",
      sha256: "e".repeat(64),
    });

    await expect(
      readImageAnalysis(
        productionImagePhotoAnalysisPorts,
        context(),
        fixture.shortcode,
      ),
    ).resolves.toBeNull();
  });
});
