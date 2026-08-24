import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { ingredientWithFoodOut } from "@cubby/schemas/ingredient";
import { infLocation } from "@cubby/schemas/location";
import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { toIngredientCard, toLocationCard } from "./EntityPreviewContent";
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

describe("toLocationCard", () => {
  it("emits a thumb block when the location resolves a cover image", () => {
    const data = mock(infLocation, {
      seed: 1,
      overrides: {
        name: "garbage bin area",
        type: "area",
        product: null,
        images: [{ url: "https://example.com/bin.jpg" }],
        totalItemCount: 2,
      },
    });

    expect(toLocationCard(data).body).toEqual([
      { kind: "thumb", url: "https://example.com/bin.jpg" },
      { kind: "stats", stats: [{ label: "On hand", value: 2 }] },
    ]);
  });

  it("emits no thumb block when there is no cover image", () => {
    const data = mock(infLocation, {
      seed: 2,
      overrides: {
        name: "garbage bin area",
        type: "area",
        product: null,
        images: [],
        totalItemCount: 2,
      },
    });

    expect(toLocationCard(data).body).toEqual([
      { kind: "stats", stats: [{ label: "On hand", value: 2 }] },
    ]);
  });

  it("names the SKU a product-linked bin IS, which carries no type of its own", () => {
    const data = mock(infLocation, {
      seed: 3,
      overrides: {
        name: "garbage bin area",
        type: null,
        product: {
          id: unsafeProductShortcode("PRD-9H64"),
          name: "27 Gal. Tough Storage Tote",
          category: "supplies",
        },
      },
    });

    expect(toLocationCard(data).identity).toBe("27 Gal. Tough Storage Tote");
  });
});

describe("toIngredientCard", () => {
  it("leads with the product photo standing in for the ingredient", () => {
    const data = mock(ingredientWithFoodOut, {
      seed: 1,
      overrides: {
        name: "olive oil",
        aliases: [],
        appearsInRecipes: [],
        product: [
          mock(productWithMappingsAndFoodOut, {
            seed: 2,
            overrides: { images: [{ url: "https://example.com/oil.jpg" }] },
          }),
        ],
      },
    });

    const card = toIngredientCard(data);

    expect(card.body?.[0]).toEqual({
      kind: "thumb",
      url: "https://example.com/oil.jpg",
    });
  });
});
