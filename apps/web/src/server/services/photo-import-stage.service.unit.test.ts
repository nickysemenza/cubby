import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";

import { stagePhotoImport } from "./photo-import-stage.service";

const photo = (clientId: string, sha256: string) => ({
  clientId,
  filename: `${clientId}.jpg`,
  contentType: "image/jpeg" as const,
  size: 128,
  width: 12,
  height: 8,
  sha256,
  allowExactReuse: true,
});

describe("photo import staging", () => {
  // SAFETY: every database interaction is replaced by injected ports; the
  // service only forwards this opaque value to those test functions.
  const database = {} as Database;

  it("reuses exact verified bytes and preserves independent staging failures", async () => {
    const existingHash = "a".repeat(64);
    const uploadHash = "b".repeat(64);
    const failedHash = "c".repeat(64);
    const initiateUpload = vi.fn(async (_db, input) => {
      if (input.filename === "failed.jpg") throw new Error("presign failed");
      return {
        uploadUrl: "https://uploads.example.test/presigned",
        imageId: parseShortcodeFor("image", "IMG-CDEF"),
        key: "images/new.jpg",
        url: "https://images.example.test/new.jpg",
      };
    });

    const result = await stagePhotoImport(
      database,
      {
        items: [
          photo("existing", existingHash),
          photo("upload", uploadHash),
          photo("failed", failedHash),
        ],
      },
      {
        findReusable: async (_db, hashes) => {
          expect(hashes).toEqual([existingHash, uploadHash, failedHash]);
          return new Map([[existingHash, { shortcode: "IMG-ABCD" }]]);
        },
        initiateUpload,
      },
    );

    expect(result.items).toEqual([
      {
        kind: "existing",
        clientId: "existing",
        imageId: "IMG-ABCD",
      },
      {
        kind: "upload",
        clientId: "upload",
        imageId: "IMG-CDEF",
        uploadUrl: "https://uploads.example.test/presigned",
        key: "images/new.jpg",
        url: "https://images.example.test/new.jpg",
      },
      { kind: "failed", clientId: "failed", retryable: true },
    ]);
    expect(initiateUpload).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an exact image when the caller declines reuse", async () => {
    const hash = "d".repeat(64);
    const initiateUpload = vi.fn(async () => ({
      uploadUrl: "https://uploads.example.test/new",
      imageId: parseShortcodeFor("image", "IMG-GHJK"),
      key: "images/new-2.jpg",
      url: "https://images.example.test/new-2.jpg",
    }));

    const result = await stagePhotoImport(
      database,
      { items: [{ ...photo("fresh", hash), allowExactReuse: false }] },
      {
        findReusable: async (_db, hashes) => {
          expect(hashes).toEqual([]);
          return new Map([[hash, { shortcode: "IMG-MNPQ" }]]);
        },
        initiateUpload,
      },
    );

    expect(result.items[0]).toMatchObject({
      kind: "upload",
      clientId: "fresh",
      imageId: "IMG-GHJK",
    });
  });
});
