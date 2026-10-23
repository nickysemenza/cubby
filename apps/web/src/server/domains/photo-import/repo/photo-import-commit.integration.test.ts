import {
  coverEntities,
  imageIngressRouteById,
  logoEntities,
} from "@cubby/schemas/entity-manifest";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  getDb,
  withTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  aiAnalysis,
  entityAttachment,
  image,
  meal,
  location,
} from "~/server/db/schema";
import {
  commitPhotoImport,
  productionPhotoImportCommitPorts,
  type PhotoImportRouteAdapter,
} from "~/server/domains/photo-import/repo/photo-import-commit";
import { reconcilePhotoImport } from "~/server/domains/photo-import/service/photo-import-reconcile.service";
import { manifestPhotoImportRouteAdapter } from "~/server/domains/photo-import/service/photo-import-route.adapter";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import {
  createImageFixture,
  createLocationFixture,
  makeLocationInput,
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  isSingularImageOwner,
  photoImportRelationTraversals,
} from "./photo-import";

describe("photo import transaction", () => {
  const ctx = withTestDb();

  // Import must wait for current location analysis before locking Images and adding photos.
  it("waits for location publication before attaching an imported photo", async () => {
    const destination = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic photo shelf" }),
      ctx.actor,
    );
    const sha256 = "d".repeat(64);
    const staged = await createImageFixture(
      ctx.db,
      "synthetic-location-addition",
      {
        status: "UPLOADED",
        sha256,
        width: 16,
        height: 16,
        renderStatus: "verified",
        storageStatus: "available",
        verifiedAt: new Date(),
      },
    );
    const route = Object.values(imageIngressRouteById).find(
      (entry) =>
        entry.targetEntity === "location" &&
        entry.sourceEntity === "location" &&
        entry.kind === "self",
    );
    if (!route) throw new Error("Expected location gallery route");
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    let release = () => {};
    let locked = () => {};
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const analysis = withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx)
        .select({ id: location.id })
        .from(location)
        .where(eq(location.id, destination.entityId))
        .for("share");
      locked();
      await unlocked;
    });
    await ready;
    const importing = commitPhotoImport(
      context,
      {
        images: [
          {
            clientId: "synthetic-location-addition",
            imageId: staged.shortcode,
            routeId: route.routeId,
            source: { entity: "location", id: destination.id },
            destination: { kind: "existing", candidateId: destination.id },
            duplicateDecision: "reuse",
            replaceConfirmed: false,
            analysis: {
              analysisVersion: 1,
              analyzedAt: "2026-09-17T12:00:00.000Z",
              capturedAt: null,
              sha256,
              contentType: "image/png",
              width: 16,
              height: 16,
              classifications: [],
              recognizedText: [],
              featurePrint: { revision: "1", data: "AA==" },
              provenance: {
                source: "photoLibrary",
                localIdentifier: "synthetic-location-addition",
                filename: "synthetic-location.png",
              },
            },
          },
        ],
        creates: [],
      },
      manifestPhotoImportRouteAdapter,
    );
    try {
      await expect
        .poll(async () => {
          const waiting = await getDb(ctx.db).execute<{ blocked: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%Location%') AS blocked`,
          );
          return waiting.rows[0]?.blocked;
        })
        .toBe(true);
      await withTransactionDatabase(ctx.db, async (tx) => {
        await getDb(tx)
          .select({ id: image.id })
          .from(image)
          .where(eq(image.id, staged.id))
          .for("update", { noWait: true });
      });
    } finally {
      release();
      await analysis;
    }
    await importing;
    expect(
      await getDb(ctx.db)
        .select({ id: entityAttachment.id })
        .from(entityAttachment)
        .where(eq(entityAttachment.entityId, destination.entityId)),
    ).toHaveLength(1);
  });

  it("rolls back a mixed create-and-attach failure, then retries while staged", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Photo import recipe" }),
      ctx.actor,
    );
    const sha256 = "a".repeat(64);
    const staged = await createImageFixture(ctx.db, "photo-import", {
      status: "PENDING",
      size: 16,
      sha256,
      width: 16,
      height: 16,
      renderStatus: null,
      storageStatus: "unverified",
      verifiedAt: new Date(),
    });
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const input = {
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
      getObject: async () => new Response(new Uint8Array(16)),
      inspect: async () => ({
        contentType: "image/png",
        width: 16,
        height: 16,
        detectedContentType: "image/png",
        sha256,
        renderStatus: "verified" as const,
        storageStatus: "available" as const,
        verifiedAt: new Date(),
      }),
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
        .select({ status: image.status })
        .from(image)
        .where(eq(image.id, staged.id)),
    ).toEqual([{ status: "PENDING" }]);
    const result = await commitPhotoImport(
      context,
      input,
      manifestPhotoImportRouteAdapter,
      ports,
    );
    expect(result.committedPhotoIds).toEqual([staged.shortcode]);
    expect(result.createdDestinations).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select({ status: image.status })
        .from(image)
        .where(eq(image.id, staged.id)),
    ).toEqual([{ status: "UPLOADED" }]);
    expect(
      await getDb(ctx.db)
        .select({ id: entityAttachment.id })
        .from(entityAttachment),
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
      productionPhotoImportCommitPorts,
    );

    expect(receipt.committedPhotoIds).toEqual([staged.shortcode]);
    expect(receipt.createdDestinations).toHaveLength(2);
    expect(
      await getDb(ctx.db)
        .select({ id: entityAttachment.id })
        .from(entityAttachment)
        .where(eq(entityAttachment.imageId, staged.id)),
    ).toHaveLength(2);
    expect(
      await getDb(ctx.db)
        .select({ id: aiAnalysis.id })
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, staged.id)),
    ).toHaveLength(0);
  });

  it("creates its own destination via createSelf, with no source and no relation check", async () => {
    const sha256 = "c".repeat(64);
    const staged = await createImageFixture(ctx.db, "createself-photo-import", {
      status: "PENDING",
      size: 16,
      sha256,
      width: 16,
      height: 16,
      renderStatus: null,
      storageStatus: "unverified",
      verifiedAt: new Date(),
    });
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const input = {
      images: [
        {
          clientId: "photo-library-createself-1",
          imageId: staged.shortcode,
          routeId: "meal-new",
          // `createSelf` has no source record: `source` is omitted entirely.
          destination: {
            kind: "create" as const,
            draftId: "meal-createself-draft",
          },
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
              localIdentifier: "photo-library-createself-1",
              filename: "createself-photo-import.png",
            },
          },
        },
      ],
      creates: [
        {
          draftId: "meal-createself-draft",
          routeId: "meal-new",
          capturedAt: "2026-09-16T23:30:00.000Z",
          body: { name: "CreateSelf meal" },
        },
      ],
    };

    const result = await commitPhotoImport(
      context,
      input,
      manifestPhotoImportRouteAdapter,
      {
        ...productionPhotoImportCommitPorts,
        getObject: async () => new Response(new Uint8Array(16)),
        inspect: async () => ({
          contentType: "image/png",
          width: 16,
          height: 16,
          detectedContentType: "image/png",
          sha256,
          renderStatus: "verified" as const,
          storageStatus: "available" as const,
          verifiedAt: new Date(),
        }),
      },
    );

    expect(result.committedPhotoIds).toEqual([staged.shortcode]);
    expect(result.createdDestinations).toHaveLength(1);
    const createdMeal = await getDb(ctx.db)
      .select({ id: meal.id, date: meal.date })
      .from(meal)
      .where(eq(meal.name, "CreateSelf meal"));
    expect(createdMeal).toHaveLength(1);
    // `meal-new`'s `date: capture-date` binding fills the NOT NULL column the client body omits.
    expect(createdMeal[0]?.date).toBe("2026-09-16");
    expect(
      await getDb(ctx.db)
        .select({ id: entityAttachment.id })
        .from(entityAttachment)
        .where(eq(entityAttachment.imageId, staged.id)),
    ).toHaveLength(1);
  });

  it("reconciles only after an in-flight commit releases its image locks", async () => {
    const staged = await createImageFixture(ctx.db, "reconcile-locked-photo", {
      status: "PENDING",
    });
    let reconciliation: ReturnType<typeof reconcilePhotoImport> | undefined;

    await withTransaction(ctx.db, async (transaction) => {
      await transaction
        .select({ id: image.id })
        .from(image)
        .where(eq(image.id, staged.id))
        .for("update");
      reconciliation = reconcilePhotoImport(ctx.db, {
        imageIds: [staged.shortcode],
      });
      // Let the reconciliation request reach its row lock while this
      // transaction still owns it, then model commit's final activation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await transaction
        .update(image)
        .set({ status: "UPLOADED" })
        .where(eq(image.id, staged.id));
    });

    expect(await reconciliation).toEqual({
      items: [
        expect.objectContaining({
          imageId: staged.shortcode,
          status: "UPLOADED",
          associations: [],
        }),
      ],
      missing: [],
    });
  });
});

describe("manifest photo import runtime bindings", () => {
  it("compiles the confirmed transaction-purchase route through allocations", () => {
    const route =
      imageIngressRouteById["financial-transaction-confirmed-purchase"];
    const traversals = photoImportRelationTraversals(
      route.sourceEntity,
      route.relationPath,
    );

    expect(traversals).toEqual([
      {
        targetEntity: "purchase",
        steps: [
          {
            edge: "FinancialTransactionAllocation.transactionId",
            direction: "incoming",
          },
          {
            edge: "FinancialTransactionAllocation.purchaseId",
            direction: "outgoing",
          },
        ],
      },
    ]);
  });

  it("has a typed adapter for every manifest singular image owner", () => {
    expect(
      [...coverEntities, ...logoEntities].every(isSingularImageOwner),
    ).toBe(true);
  });

  // The generator only sees the manifest `contract.create`; `createDestination` needs the
  // runtime binding's `createInput` and hand-written `repository.create`, so a route enabled
  // against an entity whose repository lacks `create` would fail only at commit time.
  it("binds a runtime create for every enabled creating route", () => {
    const creating = Object.values(imageIngressRouteById).filter(
      (route) =>
        route.enabled &&
        (route.kind === "createSelf" || route.kind === "createRelated"),
    );
    const uncreatable = creating
      .filter((route) => {
        const binding = Object.entries(ENTITY_KERNEL_BINDINGS).find(
          ([entity]) => entity === route.targetEntity,
        )?.[1];
        return (
          !binding?.schemas.createInput ||
          !("create" in binding.repository) ||
          !binding.repository.create
        );
      })
      .map((route) => route.routeId);
    expect(uncreatable).toEqual([]);
  });
});
