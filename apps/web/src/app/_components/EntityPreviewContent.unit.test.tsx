import type { LocationIdentityProductOut } from "@cubby/schemas/location";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type LocationPreview,
  toIngredientCard,
  toLocationCard,
} from "./EntityPreviewContent";
import { PreviewQuery } from "./preview/preview-query";

describe("PreviewQuery", () => {
  it("renders loading, deleted, and success states", () => {
    const { rerender } = render(
      <PreviewQuery
        query={{ data: undefined, isLoading: true }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{ data: undefined, isLoading: false }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Product (deleted)")).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{ data: { name: "Olive oil" }, isLoading: false }}
        label="Product"
      >
        {(data) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Olive oil")).toBeInTheDocument();
  });
});

// The hovercard's image is a `{kind:"thumb"}` body block — ManifestCard draws
// nothing without one, which is how every location rendered an imageless card
// while its photo sat unread on the wire.

const baseLocation: LocationPreview = {
  id: "LOC-4K7M",
  name: "garbage bin area",
  type: "area",
  product: null,
};

describe("toLocationCard", () => {
  it("emits a thumb block when the location resolves a cover image", () => {
    const card = toLocationCard({
      ...baseLocation,
      thumbUrl: "https://example.com/bin.jpg",
      itemCount: 2,
    });

    expect(card.body).toEqual([
      { kind: "thumb", url: "https://example.com/bin.jpg" },
      { kind: "stats", stats: [{ label: "On hand", value: 2 }] },
    ]);
  });

  it("emits no thumb block when there is no cover image", () => {
    const card = toLocationCard({ ...baseLocation, itemCount: 2 });

    expect(card.body).toEqual([
      { kind: "stats", stats: [{ label: "On hand", value: 2 }] },
    ]);
  });

  it("names the SKU a product-linked bin IS, which carries no type of its own", () => {
    const product = {
      id: "PRD-9H64",
      name: "27 Gal. Tough Storage Tote",
      category: "supplies",
    } as LocationIdentityProductOut;

    expect(
      toLocationCard({ ...baseLocation, type: null, product }).identity,
    ).toBe("27 Gal. Tough Storage Tote");
  });
});

describe("toIngredientCard", () => {
  it("leads with the product photo standing in for the ingredient", () => {
    const card = toIngredientCard({
      id: "ING-4K7M",
      name: "olive oil",
      aliases: [],
      multiplePrices: false,
      recipeCount: 3,
      thumbUrl: "https://example.com/oil.jpg",
      products: [],
    });

    expect(card.body?.[0]).toEqual({
      kind: "thumb",
      url: "https://example.com/oil.jpg",
    });
  });
});
