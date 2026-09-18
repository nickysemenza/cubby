import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  aiAnalysis,
  meal,
  mealImage,
  photoImportReceipt,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import {
  commitPhotoImport,
  productionPhotoImportCommitPorts,
  type PhotoImportRouteAdapter,
} from "~/server/services/photo-import-commit.service";
import { manifestPhotoImportRouteAdapter } from "~/server/services/photo-import-route.adapter";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("photo import transaction", () => {
  const ctx = withTestDb();

  it("rolls back a mixed create-and-attach failure, then retries idempotently", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Photo import recipe" }),
      ctx.actor,
    );
    const sha256 = "a".repeat(64);
    const staged = await createImageFixture(ctx.db, "photo-import", {
      sha256,
      width: 16,
      height: 16,
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    });
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const input = {
      idempotencyKey: "photo-import-retry-1",
      images: [
        {
          clientId: "photo-library-1",
          imageId: staged.shortcode,
          routeId: "recipe-new-meal",
          source: { entity: "recipe" as const, id: recipe.id },
          destination: { kind: "create" as const, draftId: "meal-draft" },
          duplicateDecision: "reuse" as const,
          replaceConfirmed: false,
          analysis: {
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
              source: "photoLibrary" as const,
              localIdentifier: "photo-library-1",
              filename: "photo-import.png",
            },
          },
        },
      ],
      creates: [
        {
          draftId: "meal-draft",
          routeId: "recipe-new-meal",
          capturedAt: "2026-09-16T23:30:00.000Z",
          body: { name: "Rollback meal" },
        },
      ],
    };
    const failingAdapter: PhotoImportRouteAdapter = {
      validate: (...args) => manifestPhotoImportRouteAdapter.validate(...args),
      apply: async (...args) => {
        await manifestPhotoImportRouteAdapter.apply(...args);
        throw new Error("forced rollback after create and attach");
      },
    };
    const ports = {
      ...productionPhotoImportCommitPorts,
      runSideEffects: async () => {},
    };

    await expect(
      commitPhotoImport(context, input, failingAdapter, ports),
    ).rejects.toThrow("forced rollback");
    expect(
      await getDb(ctx.db)
        .select({ id: meal.id })
        .from(meal)
        .where(eq(meal.name, "Rollback meal")),
    ).toHaveLength(0);
    expect(
      await getDb(ctx.db)
        .select({ id: aiAnalysis.id })
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, staged.id)),
    ).toHaveLength(0);
    expect(
      await getDb(ctx.db)
        .select({ id: photoImportReceipt.id })
        .from(photoImportReceipt)
        .where(eq(photoImportReceipt.idempotencyKey, input.idempotencyKey)),
    ).toHaveLength(0);

    const receipt = await commitPhotoImport(
      context,
      input,
      manifestPhotoImportRouteAdapter,
      ports,
    );
    const replay = await commitPhotoImport(
      context,
      input,
      manifestPhotoImportRouteAdapter,
      ports,
    );
    expect(replay).toEqual(receipt);
    expect(receipt.committedClientIds).toEqual(["photo-library-1"]);
    expect(receipt.createdDestinations).toHaveLength(1);
    expect(
      await getDb(ctx.db).select({ id: mealImage.id }).from(mealImage),
    ).toHaveLength(1);
  });

  it("reuses one exact image across destinations while preserving every client selection", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Shared image recipe" }),
      ctx.actor,
    );
    const sha256 = "b".repeat(64);
    const staged = await createImageFixture(ctx.db, "shared-photo-import", {
      sha256,
      width: 24,
      height: 24,
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    });
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const analysis = {
      analysisVersion: 1,
      analyzedAt: "2026-09-17T12:00:00.000Z",
      sha256,
      capturedAt: "2026-09-16T23:30:00.000Z",
      contentType: "image/png",
      width: 24,
      height: 24,
      classifications: [],
      recognizedText: [],
      featurePrint: { revision: "1", data: "AA==" },
      provenance: {
        source: "photoLibrary" as const,
        localIdentifier: "shared-photo-library",
        filename: "shared-photo-import.png",
      },
    };
    const input = {
      idempotencyKey: "photo-import-shared-image",
      images: [
        {
          clientId: "photo-library-duplicate-1",
          imageId: staged.shortcode,
          routeId: "recipe-new-meal",
          source: { entity: "recipe" as const, id: recipe.id },
          destination: { kind: "create" as const, draftId: "meal-draft-1" },
          duplicateDecision: "reuse" as const,
          replaceConfirmed: false,
          analysis,
        },
        {
          clientId: "photo-library-duplicate-2",
          imageId: staged.shortcode,
          routeId: "recipe-new-meal",
          source: { entity: "recipe" as const, id: recipe.id },
          destination: { kind: "create" as const, draftId: "meal-draft-2" },
          duplicateDecision: "reuse" as const,
          replaceConfirmed: false,
          analysis,
        },
      ],
      creates: [
        {
          draftId: "meal-draft-1",
          routeId: "recipe-new-meal",
          capturedAt: "2026-09-16T23:30:00.000Z",
          body: { name: "Shared image meal one" },
        },
        {
          draftId: "meal-draft-2",
          routeId: "recipe-new-meal",
          capturedAt: "2026-09-16T23:30:00.000Z",
          body: { name: "Shared image meal two" },
        },
      ],
    };

    const receipt = await commitPhotoImport(
      context,
      input,
      manifestPhotoImportRouteAdapter,
      { ...productionPhotoImportCommitPorts, runSideEffects: async () => {} },
    );

    expect(receipt.committedPhotoIds).toEqual([staged.shortcode]);
    expect(receipt.committedClientIds).toEqual([
      "photo-library-duplicate-1",
      "photo-library-duplicate-2",
    ]);
    expect(receipt.createdDestinations).toHaveLength(2);
    expect(
      await getDb(ctx.db)
        .select({ id: mealImage.id })
        .from(mealImage)
        .where(eq(mealImage.imageId, staged.id)),
    ).toHaveLength(2);
    expect(
      await getDb(ctx.db)
        .select({ id: aiAnalysis.id })
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, staged.id)),
    ).toHaveLength(1);
  });
});
