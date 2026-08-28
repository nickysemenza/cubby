import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  type ImageVerificationPorts,
  type ImageVerificationRow,
  verifyProductImages,
} from "./image-verification.service";

const db = new Database(() => {
  throw new Error(
    "Image-verification unit ports do not resolve a database runtime",
  );
});
const stored = {
  id: "11111111-1111-1111-1111-111111111111",
  key: "products/photo.png",
  contentType: "image/png",
  size: 3,
  width: null,
  height: null,
  detectedContentType: null,
  sha256: null,
};
const inspected = {
  contentType: "image/png",
  width: 1,
  height: 1,
  detectedContentType: "image/png",
  sha256: "abc123",
  renderStatus: "verified" as const,
  storageStatus: "available" as const,
  verifiedAt: new Date("2026-08-01T00:00:00Z"),
};

class InMemoryImageVerificationPorts {
  rows: ImageVerificationRow[] = [stored];
  response = new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
  readonly updates: Array<{ imageId: string; integrity: unknown }> = [];

  readonly ports = {
    getImagesAttachedToEntity: async () => this.rows,
    updateImageIntegrity: async (_db, imageId, integrity) => {
      this.updates.push({ imageId, integrity });
    },
    getObject: async () => this.response.clone(),
    inspectImageFile: async () => inspected,
  } satisfies ImageVerificationPorts;
}

describe("verifyProductImages", () => {
  let memory: InMemoryImageVerificationPorts;

  beforeEach(() => {
    memory = new InMemoryImageVerificationPorts();
  });

  it("records a missing object", async () => {
    memory.response = new Response(null, { status: 404 });

    await expect(
      verifyProductImages(db, testEntityId("product", "missing"), memory.ports),
    ).resolves.toEqual([{ imageId: stored.id, storageStatus: "missing" }]);
    expect(memory.updates[0]).toMatchObject({
      imageId: stored.id,
      integrity: { renderStatus: "failed", storageStatus: "missing" },
    });
  });

  it("backfills integrity metadata for a legacy row", async () => {
    await expect(
      verifyProductImages(
        db,
        testEntityId("product", "backfill"),
        memory.ports,
      ),
    ).resolves.toEqual([{ imageId: stored.id, storageStatus: "available" }]);
    expect(memory.updates).toEqual([
      { imageId: stored.id, integrity: inspected },
    ]);
  });

  it("retains recorded metadata and marks changed bytes as a mismatch", async () => {
    memory.rows = [{ ...stored, sha256: "original-hash" }];

    await expect(
      verifyProductImages(
        db,
        testEntityId("product", "mismatch"),
        memory.ports,
      ),
    ).resolves.toEqual([
      { imageId: stored.id, storageStatus: "metadata_mismatch" },
    ]);
    expect(memory.updates[0]).toMatchObject({
      integrity: {
        renderStatus: "failed",
        storageStatus: "metadata_mismatch",
      },
    });
  });
});
