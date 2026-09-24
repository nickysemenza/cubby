import { describe, expect, it } from "vitest";

import { testShortcode } from "./test-support/identifiers";
import {
  imageAttachExistingInput,
  imageListFiltersSchema,
  imageOut,
  initiateUploadWithoutEntitySchema,
  setPerceptualHashesInputSchema,
} from "./image";

describe("native image metadata", () => {
  it("accepts the persisted processing issue filter roster", () => {
    expect(
      imageListFiltersSchema.safeParse({
        processingIssue: ["failed", "review_needed"],
      }).success,
    ).toBe(true);
    expect(
      imageListFiltersSchema.safeParse({ processingIssue: "pending" }).success,
    ).toBe(false);
  });

  it("allows an existing-image purpose only on Product attachments", () => {
    const imageId = testShortcode("image", "IMG1");
    expect(
      imageAttachExistingInput.safeParse({
        imageId,
        targetId: testShortcode("product", "PRD1"),
        purpose: "label",
      }).success,
    ).toBe(true);
    expect(
      imageAttachExistingInput.safeParse({
        imageId,
        targetId: testShortcode("recipe", "RCP1"),
        purpose: "label",
      }).success,
    ).toBe(false);
  });
  it("accepts revision-one upload metadata and rejects noncanonical hashes", () => {
    expect(
      initiateUploadWithoutEntitySchema.safeParse({
        filename: "photo.jpg",
        contentType: "image/jpeg",
        size: 100,
        algorithmRevision: 1,
        perceptualHash: "0123456789abcdef",
        sourceFingerprint: {
          hash: "fedcba9876543210",
          aspectRatio: 1.5,
        },
        width: 1200,
        height: 800,
      }).success,
    ).toBe(true);
    expect(
      setPerceptualHashesInputSchema.safeParse({
        algorithmRevision: 1,
        items: [{ id: "IMG-2345", perceptualHash: "ABCDEF0123456789" }],
      }).success,
    ).toBe(false);
  });

  it("keeps private hash metadata out of the normal image output", () => {
    const output = imageOut.parse({
      id: "IMG-2345",
      url: "https://images.example/photo.jpg",
      key: "images/photo.jpg",
      filename: "photo.jpg",
      size: 100,
      contentType: "image/jpeg",
      status: "UPLOADED",
      useOriginal: false,
      width: 10,
      height: 10,
      detectedContentType: null,
      sha256: null,
      renderStatus: null,
      storageStatus: null,
      source: "unknown",
      sourcePageUrl: null,
      sourceAssetUrl: null,
      sourceName: null,
      verifiedAt: null,
      capturedAt: null,
      capturedAtOffsetMinutes: null,
      captureLocation: null,
      capturePlaceName: null,
      captureDeviceLabel: null,
      capturedByPartyId: null,
      capturedByName: null,
      captureAttribution: "none",
      provenanceEvidence: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      perceptualHash: "0123456789abcdef",
      sourceFingerprint: { hash: "fedcba9876543210", aspectRatio: 1 },
    });
    expect(output).not.toHaveProperty("perceptualHash");
    expect(output).not.toHaveProperty("sourceFingerprint");
  });
});
