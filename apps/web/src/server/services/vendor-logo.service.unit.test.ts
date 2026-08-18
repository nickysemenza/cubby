import {
  unsafeVendorId,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteS3Object: vi.fn(),
  deleteStoredObjects: vi.fn(),
  fetchExternalResponse: vi.fn(),
  getVendorByShortcode: vi.fn(),
  inspectImageFile: vi.fn(),
  replaceVendorLogo: vi.fn(),
  uploadToS3: vi.fn(),
}));

vi.mock("@cubby/shared/external-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cubby/shared/external-fetch")>()),
  fetchExternalResponse: mocks.fetchExternalResponse,
}));

vi.mock("~/server/repo/vendor", () => ({
  getVendorByShortcode: mocks.getVendorByShortcode,
  replaceVendorLogo: mocks.replaceVendorLogo,
}));

vi.mock("~/server/services/image-integrity", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/services/image-integrity")
  >()),
  inspectImageFile: mocks.inspectImageFile,
}));

vi.mock("~/server/services/image-storage.service", () => ({
  deleteStoredObjects: mocks.deleteStoredObjects,
}));

vi.mock("~/server/utils/s3", () => ({
  contentTypeToExtension: () => "png",
  deleteS3Object: mocks.deleteS3Object,
  generateImageKey: () => "cubby/images/vendor.png",
  getS3ObjectUrl: (key: string) => `https://images.example/${key}`,
  uploadToS3: mocks.uploadToS3,
}));

import {
  fetchAndAttachVendorLogo,
  fetchVendorLogoCandidate,
  normalizeVendorWebsite,
} from "./vendor-logo.service";

const VENDOR_ID = unsafeVendorShortcode("VEN-2345");
const ENTITY_ID = unsafeVendorId("00000000-0000-4000-8000-000000000222");
const inspected = (size: number) => ({
  contentType: "image/png",
  width: size,
  height: size,
  detectedContentType: "image/png",
  sha256: `sha-${size}`,
  renderStatus: "verified" as const,
  storageStatus: "available" as const,
  verifiedAt: new Date("2026-08-18T12:00:00Z"),
});

describe("normalizeVendorWebsite", () => {
  it("normalizes scheme-less websites and ignores paths", () => {
    expect(normalizeVendorWebsite("www.Example.com/catalog?q=1")).toEqual({
      origin: "https://www.example.com",
      hostname: "example.com",
    });
  });

  it.each(["not-a-host", "http://localhost", "ftp://example.com"])(
    "rejects unsafe or unresolvable website %s",
    (website) => {
      expect(() => normalizeVendorWebsite(website)).toThrow(
        "Record a valid public vendor website",
      );
    },
  );
});

describe("fetchVendorLogoCandidate", () => {
  it("chooses the largest verified candidate", async () => {
    const fetchResponse = vi.fn(
      async (url: string | URL) =>
        new Response(new Uint8Array([String(url).includes("google") ? 2 : 1]), {
          headers: { "content-type": "image/png" },
        }),
    );
    const inspect = vi.fn(async (bytes: Uint8Array) =>
      inspected(bytes[0] === 2 ? 128 : 64),
    );

    const candidate = await fetchVendorLogoCandidate("example.com", {
      fetchResponse,
      inspect,
    });

    expect(candidate?.source).toBe("google-favicon");
    expect(candidate?.inspected.width).toBe(128);
    expect(fetchResponse).toHaveBeenCalledTimes(2);
  });

  it("returns null when every response is unsupported", async () => {
    const candidate = await fetchVendorLogoCandidate("example.com", {
      fetchResponse: async () =>
        new Response("not an image", {
          headers: { "content-type": "text/html" },
        }),
      inspect: vi.fn(),
    });

    expect(candidate).toBeNull();
  });
});

describe("fetchAndAttachVendorLogo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteS3Object.mockResolvedValue(undefined);
    mocks.deleteStoredObjects.mockResolvedValue(undefined);
    mocks.uploadToS3.mockResolvedValue(undefined);
    mocks.fetchExternalResponse.mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: { "content-type": "image/png" },
      }),
    );
    mocks.inspectImageFile.mockResolvedValue(inspected(128));
    mocks.getVendorByShortcode.mockResolvedValue({
      id: VENDOR_ID,
      name: "Example",
      website: "https://example.com",
    });
    mocks.replaceVendorLogo.mockResolvedValue({
      output: { id: VENDOR_ID, logo: { url: "https://images.example/logo" } },
      entityId: ENTITY_ID,
      detachedImageKeys: ["old-logo.png"],
    });
  });

  it("uploads, associates, and then cleans up the replaced logo", async () => {
    const result = await fetchAndAttachVendorLogo(
      {} as never,
      VENDOR_ID,
      {} as never,
    );

    expect(mocks.uploadToS3).toHaveBeenCalledOnce();
    expect(mocks.replaceVendorLogo).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        id: VENDOR_ID,
        expectedWebsite: "https://example.com",
        image: expect.objectContaining({
          renderStatus: "verified",
        }),
      }),
      {},
    );
    expect(mocks.deleteStoredObjects).toHaveBeenCalledWith(["old-logo.png"]);
    expect(result.entityId).toBe(ENTITY_ID);
  });

  it("removes the newly uploaded object when database association fails", async () => {
    mocks.replaceVendorLogo.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      fetchAndAttachVendorLogo({} as never, VENDOR_ID, {} as never),
    ).rejects.toThrow("database unavailable");
    expect(mocks.deleteS3Object).toHaveBeenCalledWith(
      "cubby/images/vendor.png",
    );
    expect(mocks.deleteStoredObjects).not.toHaveBeenCalled();
  });

  it("does not touch storage when the vendor has no website", async () => {
    mocks.getVendorByShortcode.mockResolvedValue({
      id: VENDOR_ID,
      name: "Example",
      website: null,
    });

    await expect(
      fetchAndAttachVendorLogo({} as never, VENDOR_ID, {} as never),
    ).rejects.toThrow("Record a vendor website");
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("does not touch storage when neither source yields a usable image", async () => {
    mocks.fetchExternalResponse.mockResolvedValue(
      new Response("not an image", {
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(
      fetchAndAttachVendorLogo({} as never, VENDOR_ID, {} as never),
    ).rejects.toThrow("No usable logo was found");
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
    expect(mocks.replaceVendorLogo).not.toHaveBeenCalled();
  });
});
