/**
 * Table-driven coverage of {@link deriveImageCapture}'s pure branches.
 * `deriveAndStoreImageCapture`'s DB I/O is
 * exercised by `repo/image-sighting.integration.test.ts` instead — this file
 * never touches a database.
 */
import type {
  ImageCaptureLocation,
  ImageProvenanceEvidence,
} from "@cubby/schemas/image-capture-fields";
import { testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  deriveImageCapture,
  type DeriveImageCaptureCurrent,
  type DeriveImageCaptureExif,
  type DeriveImageCaptureSighting,
} from "./image-capture-derivation";

const ANA = testEntityId("ledgerParty", "ana");
const BEN = testEntityId("ledgerParty", "ben");
const GUEST = testEntityId("ledgerParty", "guest");

const GPS: ImageCaptureLocation = { lat: 47.6, lng: -122.3 };
const CAMERA = { make: "Apple", model: "iPhone 15 Pro" };

const baseCurrent = (
  overrides: Partial<DeriveImageCaptureCurrent> = {},
): DeriveImageCaptureCurrent => ({
  source: "unknown",
  captureAttribution: "none",
  capturedAt: null,
  capturedAtOffsetMinutes: null,
  captureLocation: null,
  capturePlaceName: null,
  captureDeviceLabel: null,
  capturedByPartyId: null,
  provenanceEvidence: null,
  ...overrides,
});

const baseSighting = (
  overrides: Partial<DeriveImageCaptureSighting>,
): DeriveImageCaptureSighting => ({
  ledgerPartyId: ANA,
  sourceType: "userLibrary",
  matchKind: "import",
  hashDistance: null,
  aspectGate: null,
  mediaSubtypes: [],
  originalFilename: null,
  location: null,
  placeName: null,
  camera: null,
  capturedAt: null,
  capturedAtOffsetMinutes: null,
  addedAt: null,
  ...overrides,
});

describe("deriveImageCapture", () => {
  it("never recomputes a manually confirmed image", () => {
    const current = baseCurrent({
      captureAttribution: "confirmed",
      capturedByPartyId: BEN,
      source: "own",
      provenanceEvidence: { basis: "manual" },
    });
    const result = deriveImageCapture({
      image: current,
      sightings: [baseSighting({ ledgerPartyId: ANA, hashDistance: 0 })],
      exif: {
        capturedAt: new Date(),
        capturedAtOffsetMinutes: 0,
        location: GPS,
        camera: CAMERA,
      },
    });
    expect(result).toEqual(current);
  });

  it("sets source=screenshot and clears attribution for a screenshot subtype", () => {
    const result = deriveImageCapture({
      image: baseCurrent({ source: "own", captureAttribution: "derived" }),
      sightings: [
        baseSighting({
          mediaSubtypes: ["photoScreenshot"],
          matchKind: "import",
        }),
      ],
      exif: null,
    });
    expect(result).toEqual({
      source: "screenshot",
      captureAttribution: "none",
      capturedAt: null,
      capturedAtOffsetMinutes: null,
      captureLocation: null,
      capturePlaceName: null,
      captureDeviceLabel: null,
      capturedByPartyId: null,
      provenanceEvidence: null,
    });
  });

  it("Ana's phone and Mac both report her photo → one sighting, capturedBy=Ana", () => {
    const capturedAt = new Date("2026-06-01T12:00:00Z");
    const result = deriveImageCapture({
      image: baseCurrent(),
      sightings: [
        baseSighting({ ledgerPartyId: ANA, matchKind: "import", capturedAt }),
        baseSighting({
          ledgerPartyId: ANA,
          matchKind: "libraryMatch",
          hashDistance: 0,
          capturedAt,
        }),
      ],
      exif: null,
    });
    expect(result.captureAttribution).toBe("derived");
    expect(result.capturedByPartyId).toBe(ANA);
    expect(result.provenanceEvidence).toEqual<ImageProvenanceEvidence>({
      basis: "sighting",
    });
  });

  it("a strong library match marks an unknown image as own and restores place/offset", () => {
    // The legacy `photo.jpeg` uploader case: no capture data survived the
    // upload; a later library scan matches it at distance 0.
    const result = deriveImageCapture({
      image: baseCurrent({ source: "unknown" }),
      sightings: [
        baseSighting({
          matchKind: "libraryMatch",
          hashDistance: 0,
          capturedAt: new Date("2024-03-14T18:00:00Z"),
          capturedAtOffsetMinutes: -420,
          placeName: "Garden shed",
        }),
      ],
      exif: null,
    });
    expect(result.source).toBe("own");
    expect(result.capturedAtOffsetMinutes).toBe(-420);
    expect(result.capturePlaceName).toBe("Garden shed");
  });

  it("Ben texts Ana a photo he took; Ben's sighting carries GPS and camera and wins", () => {
    const result = deriveImageCapture({
      image: baseCurrent(),
      sightings: [
        baseSighting({ ledgerPartyId: ANA, matchKind: "import" }),
        baseSighting({
          ledgerPartyId: BEN,
          matchKind: "import",
          location: GPS,
          camera: CAMERA,
        }),
      ],
      exif: null,
    });
    expect(result.captureAttribution).toBe("derived");
    expect(result.capturedByPartyId).toBe(BEN);
    expect(result.captureLocation).toEqual(GPS);
    expect(result.captureDeviceLabel).toBe("Apple iPhone 15 Pro");
  });

  it("both save the same AirDropped guest photo → tied score, ambiguous with no party", () => {
    const result = deriveImageCapture({
      image: baseCurrent(),
      sightings: [
        baseSighting({ ledgerPartyId: ANA, matchKind: "import" }),
        baseSighting({ ledgerPartyId: GUEST, matchKind: "import" }),
      ],
      exif: null,
    });
    expect(result.captureAttribution).toBe("ambiguous");
    expect(result.capturedByPartyId).toBeNull();
  });

  it("no strong sightings but EXIF present → capture fields from EXIF, no capturer", () => {
    const capturedAt = new Date("2026-05-01T08:00:00Z");
    const exif: DeriveImageCaptureExif = {
      capturedAt,
      capturedAtOffsetMinutes: -420,
      location: GPS,
      camera: CAMERA,
    };
    const result = deriveImageCapture({
      image: baseCurrent(),
      sightings: [],
      exif,
    });
    expect(result.captureAttribution).toBe("none");
    expect(result.capturedByPartyId).toBeNull();
    expect(result.capturedAt).toBe(capturedAt);
    expect(result.captureLocation).toEqual(GPS);
    expect(result.provenanceEvidence).toEqual<ImageProvenanceEvidence>({
      basis: "exif",
    });
  });

  it("no sightings, no EXIF, no prior evidence → source flips to own", () => {
    const result = deriveImageCapture({
      image: baseCurrent({ source: "unknown" }),
      sightings: [],
      exif: null,
    });
    expect(result.source).toBe("own");
    expect(result.captureAttribution).toBe("none");
    expect(result.capturedByPartyId).toBeNull();
  });

  it("retracts a sighting-derived attribution once its evidence disappears", () => {
    // Simulates re-derivation right after the image's only sighting was
    // deleted: the row's persisted state still shows the OLD derived
    // result, but `sightings` (freshly reloaded) is now empty.
    const current = baseCurrent({
      captureAttribution: "derived",
      capturedByPartyId: ANA,
      captureLocation: GPS,
      captureDeviceLabel: "Apple iPhone 15 Pro",
      provenanceEvidence: { basis: "sighting" },
    });
    const result = deriveImageCapture({
      image: current,
      sightings: [],
      exif: null,
    });
    expect(result).toEqual(baseCurrent({ source: "own" }));
  });

  it("EXIF never outranks existing import-url evidence", () => {
    const current = baseCurrent({
      source: "catalog",
      provenanceEvidence: { basis: "import-url" },
    });
    const result = deriveImageCapture({
      image: current,
      sightings: [],
      exif: {
        capturedAt: new Date(),
        capturedAtOffsetMinutes: 0,
        location: GPS,
        camera: CAMERA,
      },
    });
    expect(result).toEqual(current);
  });

  it("weak (non-userLibrary) sightings never establish a capturer", () => {
    const result = deriveImageCapture({
      image: baseCurrent(),
      sightings: [
        baseSighting({
          ledgerPartyId: ANA,
          sourceType: "cloudShared",
          matchKind: "import",
        }),
      ],
      exif: null,
    });
    expect(result.captureAttribution).toBe("none");
    expect(result.capturedByPartyId).toBeNull();
    // Falls through to the terminal branch: no sightings counted as strong,
    // no EXIF, no prior evidence.
    expect(result.source).toBe("own");
  });
});
