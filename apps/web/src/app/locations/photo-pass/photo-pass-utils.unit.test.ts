import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { describe, expect, it } from "vitest";
import {
  advanceToOutstanding,
  flattenPhotoStops,
  isPassComplete,
  needsPhoto,
} from "./photo-pass-utils";

function img(overrides: Partial<ImageOut> = {}): ImageOut {
  return {
    id: "00000000-0000-4000-8000-00000000img1",
    url: "https://example.test/a.jpg",
    key: "images/a.jpg",
    filename: "a.jpg",
    size: 1024,
    contentType: "image/jpeg",
    status: "UPLOADED",
    width: 800,
    height: 600,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    verifiedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ImageOut;
}

function loc(
  code: string,
  name: string,
  type: LocationType,
  extra: { images?: ImageOut[]; children?: InfLocation[] } = {},
): InfLocation {
  return {
    id: unsafeLocationShortcode(`LOC-${code}`),
    name,
    aliases: [],
    type,
    lastBulkInventory: null,
    aiDescription: null,
    images: extra.images ?? [],
    valuation: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    children: extra.children ?? [],
  };
}

describe("needsPhoto", () => {
  it("is false once a displayable image is attached", () => {
    expect(needsPhoto({ images: [img()] })).toBe(false);
  });

  it("is true for no images at all", () => {
    expect(needsPhoto({ images: [] })).toBe(true);
    expect(needsPhoto({})).toBe(true);
  });

  // The list's imagePresenceFilter joins through displayableImageWhere, so a
  // PDF-only or failed-render location reads "(none)" there. The queue has to
  // agree or the backlog count and the queue length diverge.
  it("is true when the only attachment is a PDF", () => {
    expect(
      needsPhoto({ images: [img({ contentType: "application/pdf" })] }),
    ).toBe(true);
  });

  it("is true when the only image failed to render", () => {
    expect(needsPhoto({ images: [img({ renderStatus: "failed" })] })).toBe(
      true,
    );
  });

  it("is true when the only image is missing from storage", () => {
    expect(needsPhoto({ images: [img({ storageStatus: "missing" })] })).toBe(
      true,
    );
  });

  it("ignores an unusable image when a usable one is also attached", () => {
    expect(
      needsPhoto({ images: [img({ renderStatus: "failed" }), img()] }),
    ).toBe(false);
  });
});

describe("flattenPhotoStops", () => {
  const tree = [
    loc("AAAA", "Garage", "room", {
      children: [
        loc("BBBB", "Shelf 1", "shelf", {
          images: [img()],
          children: [loc("CCCC", "Bin A", "tote-27gal")],
        }),
        loc("DDDD", "Shelf 2", "shelf"),
      ],
    }),
  ];

  it("walks depth-first and defaults to locations needing a photo", () => {
    const stops = flattenPhotoStops(tree);
    expect(stops.map((s) => s.name)).toEqual(["Garage", "Bin A", "Shelf 2"]);
  });

  it("recurses through a filtered-out parent", () => {
    // Shelf 1 already has a photo and is excluded, but Bin A beneath it is not.
    const stops = flattenPhotoStops(tree);
    expect(stops.map((s) => s.name)).toContain("Bin A");
  });

  it("includes photographed locations when asked", () => {
    const stops = flattenPhotoStops(tree, { includePhotographed: true });
    expect(stops.map((s) => s.name)).toEqual([
      "Garage",
      "Shelf 1",
      "Bin A",
      "Shelf 2",
    ]);
  });

  it("narrows by type without hiding nested matches", () => {
    const stops = flattenPhotoStops(tree, { types: ["tote-27gal"] });
    expect(stops.map((s) => s.name)).toEqual(["Bin A"]);
  });

  it("treats an empty type list as unrestricted", () => {
    expect(flattenPhotoStops(tree, { types: [] })).toHaveLength(3);
  });

  it("carries the path and depth from the scoped root", () => {
    const stops = flattenPhotoStops(tree, { includePhotographed: true });
    const bin = stops.find((s) => s.name === "Bin A");
    expect(bin?.path).toEqual(["Garage", "Shelf 1", "Bin A"]);
    expect(bin?.depth).toBe(2);
  });

  it("walks several roots in order", () => {
    const stops = flattenPhotoStops([
      loc("EEEE", "Basement", "room"),
      loc("FFFF", "Attic", "room"),
    ]);
    expect(stops.map((s) => s.name)).toEqual(["Basement", "Attic"]);
  });
});

describe("advanceToOutstanding", () => {
  const stops = flattenPhotoStops([
    loc("AAAA", "A", "shelf"),
    loc("BBBB", "B", "shelf"),
    loc("CCCC", "C", "shelf"),
  ]);
  const id = (name: string) => stops.find((s) => s.name === name)?.id ?? "";

  it("scans forward to the next outstanding stop", () => {
    expect(advanceToOutstanding(stops, 0, new Set([id("A")]))).toBe(1);
  });

  it("skips settled stops on the way forward", () => {
    expect(advanceToOutstanding(stops, 0, new Set([id("A"), id("B")]))).toBe(2);
  });

  it("wraps to an earlier outstanding stop", () => {
    expect(advanceToOutstanding(stops, 2, new Set([id("B"), id("C")]))).toBe(0);
  });

  it("holds position when everything is settled", () => {
    const all = new Set([id("A"), id("B"), id("C")]);
    expect(advanceToOutstanding(stops, 1, all)).toBe(1);
  });
});

describe("isPassComplete", () => {
  const stops = flattenPhotoStops([loc("AAAA", "A", "shelf")]);

  it("is false while a stop is outstanding", () => {
    expect(isPassComplete(stops, new Set())).toBe(false);
  });

  it("is true once every stop is settled", () => {
    expect(isPassComplete(stops, new Set([stops[0]?.id ?? ""]))).toBe(true);
  });

  // An empty queue is "nothing to do", which the workbench renders as its own
  // empty state — reporting it as a completed pass would show a summary for a
  // pass that never ran.
  it("is false for an empty queue", () => {
    expect(isPassComplete([], new Set())).toBe(false);
  });
});
