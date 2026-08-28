import type { VendorId } from "@cubby/schemas/identifiers";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import type { InspectedImageFile } from "~/server/services/image-integrity";

import {
  createVendorLogoService,
  normalizeVendorWebsite,
  type VendorLogoPorts,
} from "./vendor-logo.service";

interface TestDatabase {
  readonly scope: "vendor-logo";
}

interface TestActor {
  readonly source: "test";
}

interface TestVendorOutput {
  readonly logoUrl: string;
}

interface VendorLogoFixture {
  associationError?: Error;
  contentType: string;
  website: string | null;
}

const database: TestDatabase = { scope: "vendor-logo" };
const actor: TestActor = { source: "test" };
const vendorId = testShortcode("vendor", "VEN-2345");
const entityId = testEntityId("vendor", "00000000-0000-4000-8000-000000000222");

function inspected(size: number): InspectedImageFile {
  return {
    contentType: "image/png",
    width: size,
    height: size,
    detectedContentType: "image/png",
    sha256: `sha-${size}`,
    renderStatus: "verified",
    storageStatus: "available",
    verifiedAt: new Date("2026-08-18T12:00:00Z"),
  };
}

function createMemoryVendorLogoPorts(
  fixture: VendorLogoFixture,
): VendorLogoPorts<TestDatabase, TestActor, TestVendorOutput, VendorId> & {
  deletedKeys: string[];
  deletedObjects: string[][];
  remoteUrls: string[];
  replacements: Parameters<
    VendorLogoPorts<
      TestDatabase,
      TestActor,
      TestVendorOutput,
      VendorId
    >["replaceVendorLogo"]
  >[1][];
  uploads: Parameters<
    VendorLogoPorts<
      TestDatabase,
      TestActor,
      TestVendorOutput,
      VendorId
    >["upload"]
  >[0][];
} {
  const deletedKeys: string[] = [];
  const deletedObjects: string[][] = [];
  const remoteUrls: string[] = [];
  const replacements: Parameters<
    VendorLogoPorts<
      TestDatabase,
      TestActor,
      TestVendorOutput,
      VendorId
    >["replaceVendorLogo"]
  >[1][] = [];
  const uploads: Parameters<
    VendorLogoPorts<
      TestDatabase,
      TestActor,
      TestVendorOutput,
      VendorId
    >["upload"]
  >[0][] = [];

  return {
    deletedKeys,
    deletedObjects,
    remoteUrls,
    replacements,
    uploads,
    contentTypeToExtension: () => "png",
    deleteStoredObjects: async (keys) => {
      deletedObjects.push([...keys]);
    },
    deleteUploadedObject: async (key) => {
      deletedKeys.push(key);
    },
    fetchResponse: async (url) => {
      const text = url.toString();
      remoteUrls.push(text);
      const imageSize = text.includes("google") ? 128 : 64;
      return new Response(new Uint8Array([imageSize]), {
        headers: { "content-type": fixture.contentType },
      });
    },
    filenameForContentType: (filename) => filename,
    generateImageKey: () => "cubby/images/vendor.png",
    getVendor: async () => ({ website: fixture.website }),
    inspect: async (bytes) => inspected(bytes[0] ?? 0),
    replaceVendorLogo: async (_database, input) => {
      replacements.push(input);
      if (fixture.associationError) throw fixture.associationError;
      return {
        output: { logoUrl: "https://images.example/logo" },
        entityId,
        detachedImageKeys: ["old-logo.png"],
      };
    },
    upload: async (input) => {
      uploads.push(input);
    },
  };
}

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

describe("vendor logo service", () => {
  it("chooses the largest verified candidate", async () => {
    const ports = createMemoryVendorLogoPorts({
      website: "https://example.com",
      contentType: "image/png",
    });
    const service = createVendorLogoService(ports);

    const candidate = await service.fetchVendorLogoCandidate("example.com");

    expect(candidate?.source).toBe("google-favicon");
    expect(candidate?.inspected.width).toBe(128);
    expect(ports.remoteUrls).toHaveLength(2);
  });

  it("returns null when every response is unsupported", async () => {
    const ports = createMemoryVendorLogoPorts({
      website: "https://example.com",
      contentType: "text/html",
    });
    const service = createVendorLogoService(ports);

    await expect(
      service.fetchVendorLogoCandidate("example.com"),
    ).resolves.toBeNull();
  });

  it("uploads, associates, and then cleans up the replaced logo", async () => {
    const ports = createMemoryVendorLogoPorts({
      website: "https://example.com",
      contentType: "image/png",
    });
    const service = createVendorLogoService(ports);

    const result = await service.fetchAndAttachVendorLogo(
      database,
      vendorId,
      actor,
    );

    expect(ports.uploads).toHaveLength(1);
    expect(ports.replacements).toEqual([
      expect.objectContaining({
        id: vendorId,
        expectedWebsite: "https://example.com",
        image: expect.objectContaining({ renderStatus: "verified" }),
      }),
    ]);
    expect(ports.deletedObjects).toEqual([["old-logo.png"]]);
    expect(result.entityId).toBe(entityId);
  });

  it("removes the newly uploaded object when database association fails", async () => {
    const ports = createMemoryVendorLogoPorts({
      website: "https://example.com",
      contentType: "image/png",
      associationError: new Error("database unavailable"),
    });
    const service = createVendorLogoService(ports);

    await expect(
      service.fetchAndAttachVendorLogo(database, vendorId, actor),
    ).rejects.toThrow("database unavailable");
    expect(ports.deletedKeys).toEqual(["cubby/images/vendor.png"]);
    expect(ports.deletedObjects).toEqual([]);
  });

  it("does not touch storage when the vendor has no website", async () => {
    const ports = createMemoryVendorLogoPorts({
      website: null,
      contentType: "image/png",
    });
    const service = createVendorLogoService(ports);

    await expect(
      service.fetchAndAttachVendorLogo(database, vendorId, actor),
    ).rejects.toThrow("Record a vendor website");
    expect(ports.uploads).toEqual([]);
  });

  it("does not touch storage when neither source yields a usable image", async () => {
    const ports = createMemoryVendorLogoPorts({
      website: "https://example.com",
      contentType: "text/html",
    });
    const service = createVendorLogoService(ports);

    await expect(
      service.fetchAndAttachVendorLogo(database, vendorId, actor),
    ).rejects.toThrow("No usable logo was found");
    expect(ports.uploads).toEqual([]);
    expect(ports.replacements).toEqual([]);
  });
});
