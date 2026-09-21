import { productListItemOut } from "@cubby/schemas/product";
import { kitComponentRowOut } from "@cubby/schemas/product-components";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  productTreeSubRows,
} from "./product-kit-rows";

const productId = (seed: string) => testShortcode("product", seed);

const productAt = (shortcode: string, componentCount = 0) =>
  productListItemOut.parse({
    id: testShortcode("product", shortcode),
    displayImages: [],
    name: `Product ${shortcode}`,
    aliases: [],
    tags: [],
    primaryGtin: null,
    fdc_id: null,
    growsIngredientId: null,
    manufacturer: "Test",
    model: null,
    modelPresence: false,
    upcPresence: false,
    notesPresence: false,
    dataGaps: [],
    notes: null,
    labelNutrition: null,
    expectedQuantity: null,
    categoryId: null,
    category: null,
    images: [],
    labelImages: [],
    itemImageCount: 0,
    labelImageCount: 0,
    classificationEvidence: "",
    externalIds: [],
    price: null,
    pricing: {
      derivedPrice: null,
      effectivePrice: null,
      source: "none",
      knownExpenseCount: 0,
      unknownExpenseCount: 0,
      knownUnitCount: 0,
      partial: false,
    },
    usdaUnavailable: null,
    stockTracked: null,
    dataQuality: {
      status: "complete",
      facets: [],
      gaps: [],
      exceptions: [],
      relatedGaps: [],
      relatedExceptions: [],
    },
    unitMappings: [],
    ingredient: null,
    inventoryEntry: [],
    expenseCount: 0,
    componentCount,
    expenseTotal: 0,
    purchaseDate: null,
    quantityLedger: {
      acquiredUnits: 0,
      exitedUnits: 0,
      expectedQuantity: 0,
      unknownAcquisitionLines: 0,
      unknownExitLines: 0,
      locationCount: 0,
    },
    onHandUnits: 0,
    quantityVariance: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  });

const componentOf = (parent: string, child: string, quantity = 1) =>
  kitComponentRowOut.parse({
    parentProductId: testShortcode("product", parent),
    quantity,
    product: productAt(child),
  });

describe("buildProductTreeRows", () => {
  it("namespaces child ids by parent so a shared component never collides", () => {
    const rows = buildProductTreeRows(
      [
        productAt("PRD-KITA", 1),
        productAt("PRD-KITB", 1),
        productAt("PRD-SHRD"),
      ],
      groupComponentsByParent([
        componentOf("PRD-KITA", "PRD-SHRD"),
        componentOf("PRD-KITB", "PRD-SHRD"),
      ]),
    );

    const childKeys = rows
      .flatMap((row) => row.subRows ?? [])
      .map((r) => r.rowKey);
    expect(childKeys).toEqual([
      `${productId("PRD-KITA")}:${productId("PRD-SHRD")}`,
      `${productId("PRD-KITB")}:${productId("PRD-SHRD")}`,
    ]);
    expect(new Set(childKeys).size).toBe(2);
    expect(childKeys).not.toContain(productId("PRD-SHRD"));
    expect(rows.map((r) => r.rowKey)).toContain(productId("PRD-SHRD"));
  });

  it("keeps the real shortcode on every row, at both depths", () => {
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1)],
      groupComponentsByParent([componentOf("PRD-KITA", "PRD-PART")]),
    );

    // The regression this guards: namespacing `id` itself would send every
    // link, inline edit, and row action on a component to `PRD-KITA:PRD-PART`,
    // and the type system cannot catch it — a branded shortcode's *input* type
    // is a plain string, so the bad value assigns cleanly into every mutation.
    expect(rows[0]?.id).toBe(productId("PRD-KITA"));
    expect(rows[0]?.subRows?.[0]?.id).toBe(productId("PRD-PART"));
    expect(rows[0]?.subRows?.[0]?.rowKey).toBe(
      `${productId("PRD-KITA")}:${productId("PRD-PART")}`,
    );
  });

  it("omits subRows entirely when a product has no components", () => {
    // Not an empty array: `getCanExpand()` must be false so the name column
    // renders no chevron that opens nothing.
    const [row] = buildProductTreeRows(
      [productAt("PRD-PLAIN")],
      groupComponentsByParent([]),
    );
    expect(row && "subRows" in row).toBe(false);
    expect(productTreeSubRows(row!)).toBeUndefined();
  });

  it("carries each parent's own edge quantity", () => {
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1), productAt("PRD-KITB", 1)],
      groupComponentsByParent([
        componentOf("PRD-KITA", "PRD-SHRD", 2),
        componentOf("PRD-KITB", "PRD-SHRD", 1),
      ]),
    );
    expect(rows[0]?.subRows?.[0]?.componentQuantity).toBe(2);
    expect(rows[1]?.subRows?.[0]?.componentQuantity).toBe(1);
  });

  it("distinguishes a component row from a top-level row", () => {
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1)],
      groupComponentsByParent([componentOf("PRD-KITA", "PRD-PART")]),
    );
    // Drives `rowIsEntity`, which turns selection and the row-action menu off
    // for children — every mutation on this table targets a product id, and a
    // namespaced one was never minted by any endpoint.
    expect(isKitComponentRow(rows[0]!)).toBe(false);
    expect(isKitComponentRow(rows[0]!.subRows![0]!)).toBe(true);
  });

  it("nests one level only — a component never gets children", () => {
    // A component is allowed to be a kit (zero are today), but expansion stops
    // at depth 1, so a child must never carry subRows of its own.
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1)],
      groupComponentsByParent([componentOf("PRD-KITA", "PRD-KITB")]),
    );
    expect(productTreeSubRows(rows[0]!.subRows![0]!)).toBeUndefined();
  });
});
