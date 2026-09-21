import type { ImageOut } from "@cubby/schemas/image";
import { imageOut } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import { LocationVisual } from "./location-visual";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

function renderVisual(visual: React.ReactNode) {
  return render(visual, { wrapper: harness.wrapper });
}

const image = (id: string): ImageOut =>
  imageOut.parse({
    id: testShortcode("image", `IMG-${id}`),
    url: `https://example.test/${id}.jpg`,
    key: `${id}.jpg`,
    filename: `${id}.jpg`,
    size: 100,
    contentType: "image/jpeg",
    status: "UPLOADED",
    useOriginal: false,
    width: 800,
    height: 600,
    detectedContentType: null,
    sha256: null,
    renderStatus: null,
    storageStatus: null,
    source: "unknown",
    sourcePageUrl: null,
    sourceAssetUrl: null,
    sourceName: null,
    verifiedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });

const location = (
  code: string,
  name: string,
  type: LocationType | null,
  overrides: Partial<InfLocation> = {},
): InfLocation => ({
  id: testShortcode("location", `LOC-${code}`),
  name,
  aliases: [],
  type,
  product: null,
  lastBulkInventory: null,
  aiDescription: null,
  images: [],
  valuation: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  children: [],
  ...overrides,
  notes: overrides.notes ?? null,
});

const containerLocation = (overrides: Partial<InfLocation> = {}) =>
  location("AAAA", "Abrasives box", null, {
    product: {
      id: testShortcode("product", "PRD-AAAA"),
      name: "Two drawer tool box",
      manufacturer: "Example",
      model: "EX-2",
      category: categorySummaryFixture("storage"),
      coverImage: image("product"),
      price: 50,
    },
    children: [
      location("BBBB", "Discs", "drawer", { images: [image("discs")] }),
      location("CCCC", "Sanding", "drawer", {
        images: [image("sanding")],
      }),
    ],
    ...overrides,
  });

describe("LocationVisual", () => {
  it("separates the inherited product cover from direct child photos", () => {
    renderVisual(
      <LocationVisual
        location={containerLocation()}
        variant="hero"
        interactive
      />,
    );

    expect(
      screen.getByRole("link", { name: "Open product Two drawer tool box" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Discs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Sanding" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Product · Two drawer tool box"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 drawers")).toBeInTheDocument();
  });

  it("uses an own location photo ahead of the product cover", () => {
    renderVisual(
      <LocationVisual
        location={containerLocation({ images: [image("own")] })}
        variant="hero"
        interactive
      />,
    );

    expect(
      screen.queryByRole("link", {
        name: "Open product Two drawer tool box",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open photo of Abrasives box" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Location photo")).toBeInTheDocument();
  });

  it("keeps compact media non-interactive inside an outer location link", () => {
    renderVisual(
      <LocationVisual location={containerLocation()} variant="compact" />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTitle("2 child locations")).toHaveTextContent("2");
  });

  it("uses the location icon fallback when no record supplies a photo", () => {
    renderVisual(
      <LocationVisual
        location={location("DDDD", "Empty bin", "box")}
        variant="hero"
      />,
    );

    expect(screen.getByLabelText("Photo of Empty bin")).toBeInTheDocument();
    expect(screen.getByText("No compartments")).toBeInTheDocument();
  });

  it("labels mixed direct-child types as compartments", () => {
    renderVisual(
      <LocationVisual
        location={containerLocation({
          children: [
            location("BBBB", "Drawer", "drawer", {
              images: [image("drawer")],
            }),
            location("CCCC", "Shelf", "shelf", {
              images: [image("shelf")],
            }),
          ],
        })}
        variant="hero"
      />,
    );

    expect(screen.getByText("2 Compartments")).toBeInTheDocument();
  });
});
