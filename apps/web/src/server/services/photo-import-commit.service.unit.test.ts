import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import type { PhotoImportCommitInput } from "~/contracts/photo-import.contract";
import type { Database } from "~/server/db";
import { entityKernelContextSchema } from "~/server/entity-kernel";

import {
  commitPhotoImport,
  type PhotoImportCommitPorts,
  type PhotoImportRouteAdapter,
} from "./photo-import-commit.service";

// SAFETY: every database operation in this unit is replaced by an injected
// port; the object is only an opaque transaction identity token.
const database = {} as Database;
const imageCode = parseShortcodeFor("image", "IMG-ABCD");

const context = entityKernelContextSchema.parse({
  db: database,
  readDb: database,
  actorContext: {},
  usdaClient: {},
  upcLookupClient: {},
  services: { recipeCosting: { bindTo: () => ({}) } },
});

const input = (candidateId = "PRD-ABCD"): PhotoImportCommitInput => ({
  idempotencyKey: "photo-import-idempotency-key",
  images: [
    {
      clientId: "photo-1",
      imageId: imageCode,
      routeId: "product-self",
      source: { entity: "product", id: candidateId },
      destination: { kind: "existing", candidateId },
      duplicateDecision: "reuse",
      replaceConfirmed: false,
      analysis: {
        analysisVersion: 1,
        analyzedAt: "2026-09-17T12:00:00.000Z",
        sha256: "a".repeat(64),
        capturedAt: "2026-09-16T12:00:00.000Z",
        contentType: "image/jpeg",
        width: 12,
        height: 8,
        classifications: [],
        recognizedText: [],
        featurePrint: { revision: "vision-feature-print-2", data: "e30=" },
        provenance: {
          source: "photoLibrary",
          localIdentifier: "photo-1",
          filename: "photo.jpg",
        },
      },
    },
  ],
  creates: [],
});

describe("photo import atomic commit", () => {
  it("returns the original receipt for a lost-response retry and publishes once", async () => {
    let stored: { requestHash: string; receipt: unknown } | null = null;
    const getImages = vi.fn(async () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        shortcode: imageCode,
        key: "images/photo.jpg",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        size: 128,
        status: "UPLOADED" as const,
        sha256: "a".repeat(64),
        width: 12,
        height: 8,
        renderStatus: "verified" as const,
        storageStatus: "available" as const,
      },
    ]);
    const finalizeImage = vi.fn(async () => undefined);
    const persistAnalysis = vi.fn(async () => undefined);
    const runSideEffects = vi.fn(async () => undefined);
    const apply = vi.fn(async () => ({
      createdDestinations: [],
      sideEffectEvents: [],
    }));
    const ports = {
      getImages,
      getObject: vi.fn(),
      inspect: vi.fn(),
      findReceipt: vi.fn(async () => stored),
      insertReceipt: vi.fn(async (_db, _key, requestHash, receipt) => {
        stored = { requestHash, receipt };
        return true;
      }),
      finalizeImage,
      persistAnalysis,
      withTransaction: async (_db, operation) => operation(database),
      refreshProjection: vi.fn(async () => undefined),
      runSideEffects,
    } satisfies PhotoImportCommitPorts;
    const adapter = {
      validate: vi.fn(async () => undefined),
      apply,
    } satisfies PhotoImportRouteAdapter;
    const first = await commitPhotoImport(context, input(), adapter, ports);
    const retried = await commitPhotoImport(context, input(), adapter, ports);

    expect(retried).toEqual(first);
    expect(getImages).toHaveBeenCalledTimes(1);
    expect(finalizeImage).toHaveBeenCalledTimes(1);
    expect(persistAnalysis).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(runSideEffects).toHaveBeenCalledTimes(1);
  });

  it("rejects different content that reuses an idempotency key", async () => {
    let stored: { requestHash: string; receipt: unknown } | null = null;
    const ports = {
      getImages: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000001",
          shortcode: imageCode,
          key: "images/photo.jpg",
          filename: "photo.jpg",
          contentType: "image/jpeg",
          size: 128,
          status: "UPLOADED" as const,
          sha256: "a".repeat(64),
          width: 12,
          height: 8,
          renderStatus: "verified" as const,
          storageStatus: "available" as const,
        },
      ]),
      getObject: vi.fn(),
      inspect: vi.fn(),
      findReceipt: vi.fn(async () => stored),
      insertReceipt: vi.fn(async (_db, _key, requestHash, receipt) => {
        stored = { requestHash, receipt };
        return true;
      }),
      finalizeImage: vi.fn(async () => undefined),
      persistAnalysis: vi.fn(async () => undefined),
      withTransaction: async (_db, operation) => operation(database),
      refreshProjection: vi.fn(async () => undefined),
      runSideEffects: vi.fn(async () => undefined),
    } satisfies PhotoImportCommitPorts;
    const adapter = {
      validate: vi.fn(async () => undefined),
      apply: vi.fn(async () => ({
        createdDestinations: [],
        sideEffectEvents: [],
      })),
    } satisfies PhotoImportRouteAdapter;
    await commitPhotoImport(context, input(), adapter, ports);

    await expect(
      commitPhotoImport(context, input("PRD-WXYZ"), adapter, ports),
    ).rejects.toThrow("already used for different content");
    expect(adapter.apply).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicitly reused verified near-duplicate without persisting its analysis", async () => {
    const persistAnalysis = vi.fn(async () => undefined);
    const ports = {
      getImages: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000001",
          shortcode: imageCode,
          key: "images/existing-photo.jpg",
          filename: "existing-photo.jpg",
          contentType: "image/jpeg",
          size: 128,
          status: "UPLOADED" as const,
          sha256: "b".repeat(64),
          width: 12,
          height: 8,
          renderStatus: "verified" as const,
          storageStatus: "available" as const,
        },
      ]),
      getObject: vi.fn(),
      inspect: vi.fn(),
      findReceipt: vi.fn(async () => null),
      insertReceipt: vi.fn(async () => true),
      finalizeImage: vi.fn(async () => undefined),
      persistAnalysis,
      withTransaction: async (_db, operation) => operation(database),
      refreshProjection: vi.fn(async () => undefined),
      runSideEffects: vi.fn(async () => undefined),
    } satisfies PhotoImportCommitPorts;
    const adapter = {
      validate: vi.fn(async () => undefined),
      apply: vi.fn(async () => ({
        createdDestinations: [],
        sideEffectEvents: [],
      })),
    } satisfies PhotoImportRouteAdapter;
    const receipt = await commitPhotoImport(context, input(), adapter, ports);

    expect(receipt.committedClientIds).toEqual(["photo-1"]);
    expect(persistAnalysis).not.toHaveBeenCalled();
  });
});
