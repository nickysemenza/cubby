import { financialAccountOut } from "@cubby/schemas/financial-account";
import { financialTransactionOut } from "@cubby/schemas/financial-transaction";
import { gardenEntryOut } from "@cubby/schemas/garden-entry";
import { imageOut, imageWithEntitySchema } from "@cubby/schemas/image";
import { ingredientWithFoodOut } from "@cubby/schemas/ingredient";
import { infLocation } from "@cubby/schemas/location";
import { plantingOut } from "@cubby/schemas/planting";
import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { wishOut } from "@cubby/schemas/wish";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { categorySummaryFixture } from "../../../tooling/product-category-fixtures";
import {
  toFinancialAccountCard,
  toFinancialTransactionCard,
  toGardenEntryCard,
  toImageCard,
  toIngredientCard,
  toLocationCard,
  toPlantingCard,
  toWishCard,
} from "./EntityPreviewContent";
import type { BodyBlock } from "./preview/manifest-card";
import { PreviewQuery } from "./preview/preview-query";

const withMedia = <T,>(value: T, url?: string) => ({
  ...value,
  displayImages: url
    ? [{ id: testShortcode("image", "IMG-PREVIEW"), url }]
    : [],
  attachments: [],
});

/** The planting card's first body block is its stats row; anything else is a test failure. */
function locationStatOf(body: readonly BodyBlock[] | undefined) {
  const block = body?.[0];
  if (block?.kind !== "stats") throw new Error("expected a stats block");
  const stat = block.stats[1];
  if (!stat) throw new Error("expected a Location stat");
  return stat;
}

describe("PreviewQuery", () => {
  it("distinguishes loading, failure, deletion, and success states", () => {
    const refetch = vi.fn();
    const { rerender } = render(
      <PreviewQuery
        query={{ data: undefined, isLoading: true, isError: false, refetch }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{ data: undefined, isLoading: false, isError: true, refetch }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(
      screen.getByText("Product could not be loaded."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();

    rerender(
      <PreviewQuery
        query={{ data: undefined, isLoading: false, isError: false, refetch }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Product (deleted)")).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{
          data: { name: "Olive oil" },
          isLoading: false,
          isError: false,
          refetch,
        }}
        label="Product"
      >
        {(data) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Olive oil")).toBeInTheDocument();
  });

  it("clears record-owned controls while unavailable", () => {
    const onUnavailable = vi.fn();
    const { rerender } = render(
      <PreviewQuery
        query={{
          data: { name: "Olive oil" },
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }}
        label="Product"
        onUnavailable={onUnavailable}
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(onUnavailable).not.toHaveBeenCalled();

    rerender(
      <PreviewQuery
        query={{
          data: undefined,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }}
        label="Product"
        onUnavailable={onUnavailable}
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(onUnavailable).toHaveBeenCalledOnce();
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
        images: [
          mock(imageOut, {
            seed: 2,
            overrides: { url: "https://example.com/bin.jpg" },
          }),
        ],
        totalItemCount: 2,
      },
    });

    expect(
      toLocationCard(withMedia(data, "https://example.com/bin.jpg")).body,
    ).toEqual([
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

    expect(toLocationCard(withMedia(data)).body).toEqual([
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
          id: testShortcode("product", "PRD-9H64"),
          name: "27 Gal. Tough Storage Tote",
          manufacturer: "Example",
          model: null,
          category: categorySummaryFixture("supplies"),
          coverImage: null,
          price: null,
        },
      },
    });

    expect(toLocationCard(withMedia(data)).identity).toBe(
      "27 Gal. Tough Storage Tote",
    );
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
            overrides: {
              externalIds: [],
              images: [
                {
                  ...mock(imageOut, {
                    seed: 3,
                    overrides: { url: "https://example.com/oil.jpg" },
                  }),
                  purpose: null,
                },
              ],
            },
          }),
        ],
      },
    });

    const card = toIngredientCard(
      withMedia(data, "https://example.com/oil.jpg"),
    );

    expect(card.body?.[0]).toEqual({
      kind: "thumb",
      url: "https://example.com/oil.jpg",
    });
  });
});

describe("first-wave compact cards", () => {
  it("summarizes account identity and transaction count from the existing detail payload", () => {
    const account = mock(financialAccountOut, {
      seed: 4,
      overrides: {
        name: "Household Visa",
        identity: {
          kind: "credit_card",
          issuer: "Example Bank",
          network: "visa",
          last4: "4242",
        },
        provisional: false,
        transactionCount: 23,
      },
    });

    const card = toFinancialAccountCard(withMedia(account));

    expect(card.name).toBe("Household Visa");
    expect(card.identity).toBe("Credit card · Example Bank · •••• 4242");
    expect(card.body).toEqual([
      {
        kind: "stats",
        stats: [
          { label: "Transactions", value: 23 },
          { label: "Status", value: "Known" },
        ],
      },
    ]);
  });

  it("keeps a transaction's account connection in its compact card", () => {
    const transaction = mock(financialTransactionOut, {
      seed: 5,
      overrides: {
        accountId: testShortcode("financialAccount", "FAC-4K7M"),
        accountName: "Household Visa",
        merchant: "Hardware store",
        rawDescription: null,
        displayName: "Hardware store",
        allocations: [],
      },
    });

    const card = toFinancialTransactionCard(withMedia(transaction));

    expect(card.name).toBe("Hardware store");
    expect(card.crossLinks).toEqual([
      expect.objectContaining({
        to: "/financial-accounts/$shortcode",
        params: { shortcode: "FAC-4K7M" },
        label: "Household Visa",
      }),
    ]);
  });

  it("shows wish candidates and preserves unknown prices as unknown", () => {
    const wish = mock(wishOut, {
      seed: 6,
      overrides: {
        name: "Workshop light",
        acquiredAt: null,
        candidates: [
          {
            id: testShortcode("product", "PRD-4K7M"),
            name: "Bench lamp",
            manufacturer: "Example",
            model: null,
            price: null,
            inventoried: false,
          },
        ],
      },
    });

    const card = toWishCard(withMedia(wish));

    expect(card.identity).toBe("Open");
    expect(card.body).toEqual([
      {
        kind: "stats",
        stats: [
          { label: "Candidates", value: 1 },
          { label: "Price range", value: "—" },
        ],
      },
      {
        kind: "products",
        products: [
          {
            id: "PRD-4K7M",
            name: "Bench lamp",
            manufacturer: "Example",
          },
        ],
      },
    ]);
  });

  it("shows every existing image association without a second query", () => {
    const image = mock(imageWithEntitySchema, {
      seed: 7,
      overrides: {
        filename: "workbench.jpg",
        status: "UPLOADED",
        width: 1600,
        height: 1200,
        associations: [
          {
            entityType: "product",
            entityId: testShortcode("product", "PRD-4K7M"),
            entityName: "Bench lamp",
            role: "cover",
          },
          {
            entityType: "project",
            entityId: testShortcode("project", "PRJ-7M2X"),
            entityName: "Workshop refresh",
            role: "attachment",
          },
        ],
      },
    });

    const card = toImageCard(withMedia(image, image.url));

    expect(card.crossLinks).toEqual([
      expect.objectContaining({
        to: "/products/$shortcode",
        params: { shortcode: "PRD-4K7M" },
        label: "Bench lamp · cover",
      }),
      expect.objectContaining({
        to: "/projects/$shortcode",
        params: { shortcode: "PRJ-7M2X" },
        label: "Workshop refresh · attachment",
      }),
    ]);
    expect(card.body).toEqual(
      expect.arrayContaining([
        { kind: "thumb", url: image.url },
        {
          kind: "stats",
          stats: [
            { label: "Dimensions", value: "1600 × 1200" },
            { label: "Associations", value: 2 },
          ],
        },
      ]),
    );
  });

  it("titles a planting card from displayName and reports its status", () => {
    const growingTomato = mock(plantingOut, {
      seed: 8,
      overrides: {
        locationId: testShortcode("location", "LOC-4K7M"),
        locationName: "Raised bed 2",
        status: "growing",
        displayName: "Tomato · Cherokee Purple",
      },
    });

    const card = toPlantingCard(withMedia(growingTomato));

    expect(card.name).toBe("Tomato · Cherokee Purple");
    expect(card.body).toEqual([
      {
        kind: "stats",
        stats: [
          { label: "Status", value: "Growing" },
          { label: "Location", value: expect.anything() },
        ],
      },
    ]);

    // The Location stat renders the resolved name, not the raw shortcode.
    const locationStat = locationStatOf(card.body);
    render(<>{locationStat.value}</>);
    expect(screen.getByText("Raised bed 2")).toBeInTheDocument();
  });

  it("falls back to the location shortcode when a planting has no locationName", () => {
    const namelessBed = mock(plantingOut, {
      seed: 8,
      overrides: {
        locationId: testShortcode("location", "LOC-4K7M"),
        locationName: null,
        status: "growing",
        displayName: "Tomato · Cherokee Purple",
      },
    });

    const card = toPlantingCard(withMedia(namelessBed));
    const locationStat = locationStatOf(card.body);
    render(<>{locationStat.value}</>);
    expect(screen.getByText("LOC-4K7M")).toBeInTheDocument();
  });

  it("titles a gardenEntry card from displayName and maps note to Note", () => {
    const bedOverview = mock(gardenEntryOut, {
      seed: 9,
      overrides: {
        kind: "note",
        observedOn: "2026-10-06",
        locationName: "Garden test bed",
        displayName: "Note · 2026-10-06 · Garden test bed",
        images: [],
      },
    });

    const card = toGardenEntryCard(withMedia(bedOverview));

    expect(card.name).toBe("Note · 2026-10-06 · Garden test bed");
    expect(card.body).toEqual([
      {
        kind: "stats",
        stats: [
          { label: "Kind", value: "Note" },
          { label: "Date", value: expect.any(String) },
          { label: "Location", value: expect.anything() },
        ],
      },
    ]);
  });
});
