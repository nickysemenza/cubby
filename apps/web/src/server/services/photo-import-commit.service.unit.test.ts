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
const imageRow = (status: "PENDING" | "UPLOADED") => ({
  id: "00000000-0000-4000-8000-000000000001",
  shortcode: imageCode,
  key: "images/photo.jpg",
  filename: "photo.jpg",
  contentType: "image/jpeg",
  size: 128,
  status,
  sha256: status === "UPLOADED" ? "a".repeat(64) : null,
  width: 12,
  height: 8,
  renderStatus: status === "UPLOADED" ? ("verified" as const) : null,
  storageStatus: status === "UPLOADED" ? ("available" as const) : null,
});

const context = entityKernelContextSchema.parse({
  db: database,
  readDb: database,
  actorContext: {},
  usdaClient: {},
  upcLookupClient: {},
  services: { recipeCosting: { bindTo: () => ({}) } },
});

const input = (): PhotoImportCommitInput => ({
  idempotencyKey: "legacy-client-key",
  images: [
    {
      clientId: "photo-1",
      imageId: imageCode,
      routeId: "product-self",
      source: { entity: "product", id: "PRD-ABCD" },
      destination: { kind: "existing", candidateId: "PRD-ABCD" },
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

const adapter: PhotoImportRouteAdapter = {
  validate: vi.fn(async () => undefined),
  apply: vi.fn(async () => ({
    createdDestinations: [],
    sideEffectEvents: [],
  })),
};

const portsFor = (
  status: "PENDING" | "UPLOADED",
  overrides: Partial<PhotoImportCommitPorts> = {},
): PhotoImportCommitPorts => {
  const row = imageRow(status);
  return {
    getImages: vi.fn(async () => [row]),
    lockImages: vi.fn(async () => [row]),
    getObject: vi.fn(async () => new Response(new Uint8Array(128))),
    inspect: vi.fn(async () => ({
      contentType: "image/jpeg",
      width: 12,
      height: 8,
      detectedContentType: "image/jpeg",
      sha256: "a".repeat(64),
      renderStatus: "verified" as const,
      storageStatus: "available" as const,
      verifiedAt: new Date(),
    })),
    activateImages: vi.fn(async () => (status === "PENDING" ? 1 : 0)),
    persistAnalysis: vi.fn(async () => undefined),
    withTransaction: async (_db, operation) => operation(database),
    refreshProjection: vi.fn(async () => undefined),
    runSideEffects: vi.fn(async () => undefined),
    ...overrides,
  };
};

describe("photo import atomic commit", () => {
  it("keeps new images pending until the exact final activation", async () => {
    const ports = portsFor("PENDING");
    const result = await commitPhotoImport(context, input(), adapter, ports);

    expect(result).toMatchObject({ committedPhotoIds: [imageCode] });
    expect(ports.lockImages).toHaveBeenCalledTimes(1);
    expect(ports.persistAnalysis).toHaveBeenCalledTimes(1);
    expect(ports.activateImages).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(ports.activateImages).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(ports.persistAnalysis).mock.invocationCallOrder[0]!,
    );
  });

  it("does not activate an already uploaded reused image", async () => {
    const ports = portsFor("UPLOADED");
    const result = await commitPhotoImport(context, input(), adapter, ports);

    expect(result.committedPhotoIds).toEqual([imageCode]);
    expect(ports.activateImages).toHaveBeenCalledWith(database, []);
    expect(ports.persistAnalysis).not.toHaveBeenCalled();
  });

  it("allows explicit reuse of a perceptual duplicate with different bytes", async () => {
    const reuse = input();
    reuse.images[0] = {
      ...reuse.images[0]!,
      analysis: { ...reuse.images[0]!.analysis, sha256: "b".repeat(64) },
    };
    const ports = portsFor("UPLOADED");

    const result = await commitPhotoImport(context, reuse, adapter, ports);

    expect(result.committedPhotoIds).toEqual([imageCode]);
    expect(ports.activateImages).toHaveBeenCalledWith(database, []);
    expect(ports.persistAnalysis).not.toHaveBeenCalled();
  });

  it("does not persist a receipt or replay an ambiguous response", async () => {
    vi.mocked(adapter.apply).mockClear();
    const ports = portsFor("UPLOADED");
    const first = await commitPhotoImport(context, input(), adapter, ports);
    await commitPhotoImport(context, input(), adapter, ports);

    expect(adapter.apply).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveProperty("receiptId");
    expect(first).not.toHaveProperty("idempotencyKey");
  });

  it("rolls back when final activation count is incomplete", async () => {
    const withRollback = portsFor("PENDING", {
      activateImages: vi.fn(async () => 0),
      withTransaction: vi.fn(async (_db, operation) => operation(database)),
    });

    await expect(
      commitPhotoImport(context, input(), adapter, withRollback),
    ).rejects.toThrow("expected 1");
    expect(withRollback.runSideEffects).not.toHaveBeenCalled();
  });

  it("rejects a retry loser before route writes when preflight state changed", async () => {
    vi.mocked(adapter.validate).mockClear();
    vi.mocked(adapter.apply).mockClear();
    const ports = portsFor("PENDING", {
      lockImages: vi.fn(async () => [imageRow("UPLOADED")]),
    });

    await expect(
      commitPhotoImport(context, input(), adapter, ports),
    ).rejects.toThrow("changed while it was being committed");
    expect(adapter.validate).not.toHaveBeenCalled();
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(ports.activateImages).not.toHaveBeenCalled();
  });

  it("rejects a newly staged retry after the image already became active", async () => {
    vi.mocked(adapter.validate).mockClear();
    vi.mocked(adapter.apply).mockClear();
    const retry = input();
    retry.images[0] = { ...retry.images[0]!, duplicateDecision: "keepBoth" };
    const ports = portsFor("UPLOADED");

    await expect(
      commitPhotoImport(context, retry, adapter, ports),
    ).rejects.toThrow("was not approved for reuse");
    expect(adapter.validate).not.toHaveBeenCalled();
    expect(adapter.apply).not.toHaveBeenCalled();
  });
});
