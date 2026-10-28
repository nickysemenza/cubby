import { displayImagesField } from "@cubby/schemas/display-images";
import { computedFieldEnvelope } from "@cubby/schemas/field-envelope";
import { locationPickerAncestorOut } from "@cubby/schemas/location";
import { productResolveCandidateOut } from "@cubby/schemas/product";
import type { SearchHit } from "@cubby/schemas/search";
import { testShortcode } from "@cubby/schemas/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as testingRender } from "@testing-library/react";
import type { ReactNode } from "react";
import { categoryReadFixture } from "tooling/product-category-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import {
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildRecordComboboxItem,
  buildSearchHitComboboxItem,
  buildVendorComboboxItem,
} from "./combobox-builders";

let queryClient: Awaited<ReturnType<typeof metadataQueryClient>>;
beforeEach(async () => {
  queryClient = await metadataQueryClient();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

function MetadataProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function render(ui: ReactNode, options?: Parameters<typeof testingRender>[1]) {
  return testingRender(ui, { wrapper: MetadataProvider, ...options });
}

function locationSearchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  const base: SearchHit = {
    id: "LOC-3ABC",
    entityKind: "location",
    title: "Workshop drawer",
    subtitle: "Garage › Main area",
    facts: [],
    typeHint: "drawer",
    imageUrl: "https://example.com/workshop-drawer.jpg",
    matchKind: "text",
    matchField: "title",
    matchReason: "Text match in title",
    matchTerms: ["workshop"],
  };
  return { ...base, ...overrides };
}

describe("entity picker value adapters", () => {
  it("keeps manifest record, LOC, PRD and persisted VEN assignments shortcode-valued", () => {
    const ingredientId = testShortcode("ingredient", "ING-2ABC");
    const locationId = testShortcode("location", "LOC-3ABC");
    const product = testShortcode("product", "PRD-5ABC");
    const vendor = testShortcode("vendor", "VEN-8ABC");

    // The manifest's `titleField` names the row; declared aliases stay searchable.
    expect(
      buildRecordComboboxItem(queryClient, "ingredient", {
        id: ingredientId,
        name: "Scallion",
        aliases: ["green onion"],
      }),
    ).toMatchObject({
      id: ingredientId,
      shortcode: ingredientId,
      name: "Scallion",
      aliases: ["green onion"],
    });
    expect(
      buildRecordComboboxItem(queryClient, "plant", {
        id: "PLANT-4ABC",
        displayName: "Tomato",
      }),
    ).toMatchObject({ id: "PLANT-4ABC", name: "Tomato" });
    expect(
      buildLocationComboboxItem({
        id: locationId,
        name: "Pantry",
        type: "room",
      }),
    ).toMatchObject({ id: locationId, shortcode: locationId });
    expect(
      buildProductComboboxItem({
        id: product,
        name: "Drill",
        brandName: "Makita",
      }),
    ).toMatchObject({ id: product, shortcode: product, secondary: "Makita" });
    expect(
      buildVendorComboboxItem(
        { id: vendor, name: "Acme" },
        { itemId: "shortcode" },
      ),
    ).toMatchObject({ id: vendor, shortcode: vendor });
  });

  it("reads canonical current picker metadata without requiring raw aliases", () => {
    expect(
      buildProductComboboxItem({
        id: testShortcode("product", "PRD-4K7M"),
        name: "Synthetic drill",
        fields: {
          brandName: fieldValueFixture(
            productResolveCandidateOut.shape.fields.shape.brandName,
            "Synthetic maker",
          ),
        },
      }).secondary,
    ).toBe("Synthetic maker");
    expect(
      buildLocationComboboxItem({
        id: testShortcode("location", "LOC-4K7M"),
        name: "Synthetic shelf",
        fields: {
          type: fieldValueFixture(
            locationPickerAncestorOut.shape.fields.shape.type,
            "shelf",
          ),
        },
      }).secondary,
    ).toBe("shelf");
  });

  it("keeps the expense vendor adapter name-valued", () => {
    const vendor = testShortcode("vendor", "VEN-9ABC");
    expect(
      buildVendorComboboxItem({ id: vendor, name: "Acme" }, { itemId: "name" }),
    ).toMatchObject({ id: "Acme", shortcode: vendor, name: "Acme" });
  });
});

// Regression: generic record rows always used the glyph, even for a record
// with a cover image.
describe("generic record picture", () => {
  it("uses the record's cover and keeps the glyph as its fallback", () => {
    const recipe = testShortcode("recipe", "RCP-2ABC");
    const cover = "https://images.example.test/stew.jpg";
    const item = buildRecordComboboxItem(queryClient, "recipe", {
      id: recipe,
      name: "Winter stew",
      fields: {
        displayImages: fieldValueFixture(
          computedFieldEnvelope(displayImagesField),
          [{ id: testShortcode("image", "IMG-2ABC"), url: cover }],
        ),
      },
    });
    expect(item.thumb?.imageUrl).toBe(cover);
    expect(item.thumb?.fallback).toBeTruthy();
    expect(
      buildRecordComboboxItem(queryClient, "recipe", {
        id: recipe,
        name: "Plain soup",
      }).thumb?.imageUrl,
    ).toBeNull();
  });
});

describe("buildLocationComboboxItem tree presentation", () => {
  it("shows the server path for a typed location search hit", () => {
    const item = buildSearchHitComboboxItem(
      locationSearchHit({ facts: ["Garage › Workbench › Workshop drawer"] }),
      "location",
    );
    expect(item.name).toBe("Workshop drawer");
    expect(item.secondary).toBe("Garage › Workbench › Workshop drawer");
  });
  it("groups under the root ancestor and sets depth to the path length", () => {
    const locationId = testShortcode("location", "LOC-9ABC");
    const rootId = testShortcode("location", "LOC-1ABC");
    const parentId = testShortcode("location", "LOC-2ABC");

    const item = buildLocationComboboxItem({
      id: locationId,
      name: "Drawer 2",
      type: "drawer",
      ancestors: [
        { id: rootId, name: "Garage" },
        { id: parentId, name: "Workbench" },
      ],
    });

    expect(item.presentation).toEqual({
      group: { id: rootId, label: "Garage", order: 0 },
      depth: 2,
    });
  });

  it("groups a root location under itself at depth 0", () => {
    const locationId = testShortcode("location", "LOC-1ABC");

    const item = buildLocationComboboxItem({
      id: locationId,
      name: "Garage",
      type: "room",
      ancestors: [],
    });

    expect(item.presentation).toEqual({
      group: { id: locationId, label: "Garage", order: 0 },
      depth: 0,
    });
  });

  it("carries no presentation when ancestors were never loaded", () => {
    const locationId = testShortcode("location", "LOC-1ABC");

    const item = buildLocationComboboxItem({
      id: locationId,
      name: "Freshly created shelf",
      type: "shelf",
    });

    expect(item.presentation).toBeUndefined();
  });
});

describe("location search picker imagery", () => {
  it("pictures a location by its cover, falling back to its type glyph", () => {
    const pictured = buildSearchHitComboboxItem(
      locationSearchHit({ typeHint: "drawer" }),
      "location",
    );
    expect(pictured.thumb?.imageUrl).toBe(
      "https://example.com/workshop-drawer.jpg",
    );
    const bare = buildSearchHitComboboxItem(
      locationSearchHit({ imageUrl: null, typeHint: null }),
      "location",
    );
    expect(bare.thumb?.imageUrl).toBeNull();
    const { container } = render(bare.thumb?.fallback);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("product stock picker evidence", () => {
  const product = testShortcode("product", "PRD-5ABC");
  const base = {
    id: product,
    name: "Back Brace",
    brandName: "BraceAbility",
    category: categoryReadFixture("household"),
    quantityLedger: {
      acquiredUnits: 1,
      exitedUnits: 0,
      expectedQuantity: 1,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
      locationCount: 0,
    },
  } as const;

  it("leads with the missing quantity and its evidence", () => {
    expect(
      buildProductComboboxItem({ ...base, onHand: { state: "none" } }, "stock")
        .presentation,
    ).toEqual({
      group: { id: "needs-stock", label: "Needs stocking", order: 0 },
      trailing: [
        { text: "Need 1", tone: "positive" },
        { text: "0 on hand / 1 expected" },
      ],
    });
  });

  it("keeps the product cover photo beside quantity evidence", () => {
    const photographed = {
      ...base,
      coverImageUrl: "https://example.com/back-brace.png",
      onHand: { state: "none" } as const,
    };
    const item = buildProductComboboxItem(photographed, "stock");

    expect(item.thumb?.imageUrl).toBe(photographed.coverImageUrl);
  });

  it("omits inventory chips for service categories even with retained stock evidence", () => {
    const item = buildProductComboboxItem(
      {
        ...base,
        category: categoryReadFixture("software"),
        fields: {
          categoryFeature: fieldValueFixture(
            productResolveCandidateOut.shape.fields.shape.categoryFeature,
            "software",
          ),
        },
        onHand: { state: "counted", units: 2 },
      },
      "stock",
    );
    expect(item.presentation).toBeUndefined();
  });

  it("keeps a fully returned product visible below likely choices", () => {
    expect(
      buildProductComboboxItem(
        {
          ...base,
          quantityLedger: {
            ...base.quantityLedger,
            exitedUnits: 1,
            expectedQuantity: 0,
          },
          onHand: { state: "none" },
        },
        "stock",
      ).presentation,
    ).toEqual({
      group: { id: "other", label: "Other products", order: 2 },
      trailing: [{ text: "Returned" }, { text: "0 on hand" }],
    });
  });

  it("does not manufacture a need from mixed or incomplete quantities", () => {
    const item = buildProductComboboxItem(
      {
        ...base,
        quantityLedger: {
          ...base.quantityLedger,
          unknownAcquisitionLines: 1,
        },
        onHand: { state: "mixed" },
      },
      "stock",
    );
    expect(item.presentation).toMatchObject({
      group: { id: "check" },
      trailing: [
        { text: "Check quantity", tone: "warning" },
        { text: "Mixed units on hand", tone: "warning" },
        { text: "1 line without quantity", tone: "warning" },
      ],
    });
  });

  it("derives mixed stock evidence from a full product detail result", () => {
    const item = buildProductComboboxItem(
      {
        ...base,
        onHandUnits: null,
        inventoryEntry: [
          { amount: { value: 1, unit: "each" } },
          { amount: { value: 2, unit: "box" } },
        ],
      },
      "stock",
    );

    expect(item.presentation).toMatchObject({ group: { id: "check" } });
    expect(item.presentation?.trailing?.map((chip) => chip.text)).toContain(
      "Mixed units on hand",
    );
  });
});

it.each([{ images: undefined }, { images: [] }])(
  "keeps missing and empty picker covers authoritative",
  ({ images }) => {
    const fields = {
      displayImages: fieldValueFixture(
        computedFieldEnvelope(displayImagesField),
        images,
      ),
    };
    const snapshot = [
      {
        id: testShortcode("image", "IMG-4K7M"),
        url: "https://example.test/stale.jpg",
      },
    ];
    expect(
      buildRecordComboboxItem(queryClient, "recipe", {
        id: "RCP-4K7M",
        name: "Synthetic stew",
        fields,
        displayImages: snapshot,
      }).thumb?.imageUrl,
    ).toBeNull();
    expect(
      buildProductComboboxItem({
        id: testShortcode("product", "PRD-4K7M"),
        name: "Synthetic kettle",
        fields,
        coverImageUrl: "https://example.test/stale.jpg",
      }).thumb?.imageUrl,
    ).toBeNull();
  },
);
