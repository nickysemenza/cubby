import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { LocationVisual } from "./location-visual";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <a href="#visual" aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

const image = (id: string): ImageOut =>
  ({
    id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    url: `https://example.test/${id}.jpg`,
    key: `${id}.jpg`,
    filename: `${id}.jpg`,
    size: 100,
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
  }) as ImageOut;

const location = (
  code: string,
  name: string,
  type: LocationType | null,
  overrides: Partial<InfLocation> = {},
): InfLocation => ({
  id: unsafeLocationShortcode(`LOC-${code}`),
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
});

const containerLocation = (overrides: Partial<InfLocation> = {}) =>
  location("AAAA", "Abrasives box", null, {
    product: {
      id: unsafeProductShortcode("PRD-AAAA"),
      name: "Two drawer tool box",
      manufacturer: "Example",
      model: "EX-2",
      category: "storage",
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
    render(
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
    render(
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
    render(<LocationVisual location={containerLocation()} variant="compact" />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByTitle("2 child locations")).toHaveTextContent("2");
  });

  it("uses the location icon fallback when no record supplies a photo", () => {
    render(
      <LocationVisual
        location={location("DDDD", "Empty bin", "box")}
        variant="hero"
      />,
    );

    expect(screen.getByLabelText("Photo of Empty bin")).toBeInTheDocument();
    expect(screen.getByText("No compartments")).toBeInTheDocument();
  });

  it("labels mixed direct-child types as compartments", () => {
    render(
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
