import { describe, expect, it } from "vitest";
import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
} from "~/schemas/identifiers";
import type { InventoryCSVRow } from "~/schemas/inventory";
import type { LocationCSVRow } from "~/schemas/location";
import type { SyncState } from "~/schemas/sync";
import type { InventoryCSVExportRow } from "~/server/repo/inventory/types";
import type { LocationCSVExportRow } from "~/server/repo/location/types";
import { compareInventoryForSync, compareLocationsForSync } from "./comparison";

// Helper to create a minimal app row (from database)
const makeAppRow = (
  overrides: Partial<InventoryCSVExportRow> & {
    product_name: string;
    manufacturer: string;
  },
): InventoryCSVExportRow => {
  const { product_name, manufacturer, ...rest } = overrides;
  return {
    product_shortcode: null,
    product_name,
    manufacturer,
    category: null,
    upc: "",
    model: null,
    ndb_number: null,
    location_shortcode: null,
    location_name: "",
    location_id: null,
    inventory_entry_id: null,
    product_id: unsafeProductId("prod-1"),
    quantity: null,
    unit: null,
    expected_qty: null,
    price: null,
    unit_mappings: null,
    ingredient_name: null,
    aliases: null,
    notes: null,
    product_image: null,
    ...rest,
  };
};

// Helper to create a minimal sheet row (from Google Sheet)
const makeSheetRow = (
  overrides: Partial<InventoryCSVRow> & { product_name: string },
): InventoryCSVRow => {
  const { product_name, ...rest } = overrides;
  return {
    product_name,
    quantity: 1,
    unit: "each",
    ...rest,
  };
};

// Count items by state for easy assertion
const countByState = (
  result: ReturnType<typeof compareInventoryForSync>,
): Record<SyncState, number> => {
  const counts: Record<SyncState, number> = {
    matched: 0,
    conflict: 0,
    app_only: 0,
    sheet_only: 0,
    renamed: 0,
    moved: 0,
  };
  for (const item of result) {
    counts[item.state]++;
  }
  return counts;
};

// Test case definition for table-driven tests
interface RenameTestCase {
  name: string;
  app: {
    product_name: string;
    manufacturer: string;
    location_name?: string;
    upc?: string;
    model?: string;
  };
  sheet: {
    product_name: string;
    manufacturer?: string;
    location_name?: string;
    upc?: string;
    model?: string;
  };
  expectedCounts: Partial<Record<SyncState, number>>;
  // For renamed items
  renamedFrom?: string;
  renamedTo?: string;
  // For moved items
  movedFrom?: string;
  movedTo?: string;
}

describe("compareInventoryForSync - rename detection", () => {
  const shouldDetectRename: RenameTestCase[] = [
    {
      name: "typo fix with same location + manufacturer",
      app: {
        product_name: "misc: rwrenches, pliers, knives",
        manufacturer: "misc",
        location_name: "packout 2 drawer",
      },
      sheet: {
        product_name: "misc: wrenches, pliers, knives",
        manufacturer: "misc",
        location_name: "packout 2 drawer",
      },
      expectedCounts: { renamed: 1 },
      renamedFrom: "misc: rwrenches, pliers, knives",
      renamedTo: "misc: wrenches, pliers, knives",
    },
    {
      name: "matching UPC",
      app: {
        product_name: "18 Ga Brad Nailer",
        manufacturer: "DeWalt",
        location_name: "tool shelf",
        upc: "885911548793",
      },
      sheet: {
        product_name: "Brad Nailer 18 Gauge",
        manufacturer: "DeWalt",
        location_name: "tool shelf",
        upc: "885911548793",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "matching model number",
      app: {
        product_name: "Cordless Drill",
        manufacturer: "Milwaukee",
        location_name: "garage",
        model: "2804-20",
      },
      sheet: {
        product_name: "M18 FUEL 1/2 in. Hammer Drill",
        manufacturer: "Milwaukee",
        location_name: "garage",
        model: "2804-20",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "one name contains the other (adding misc: prefix)",
      app: {
        product_name: "misc: paper bags",
        manufacturer: "(unspecified)",
        location_name: "kitchen pantry",
      },
      sheet: {
        product_name: "paper bags",
        manufacturer: "(unspecified)",
        location_name: "kitchen pantry",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "name shortened",
      app: {
        product_name: "3M Command Hooks",
        manufacturer: "3M",
        location_name: "closet",
      },
      sheet: {
        product_name: "3M Command Hooks Large",
        manufacturer: "3M",
        location_name: "closet",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "same location with (unspecified) manufacturers",
      app: {
        product_name: "screws, assorted",
        manufacturer: "(unspecified)",
        location_name: "hardware drawer",
      },
      sheet: {
        product_name: "assorted screws",
        manufacturer: "(unspecified)",
        location_name: "hardware drawer",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "misc: prefix pattern - reordered items",
      app: {
        product_name: "misc: nails, screws, bolts",
        manufacturer: "misc",
        location_name: "hardware bin",
      },
      sheet: {
        product_name: "misc: nails, bolts, screws",
        manufacturer: "misc",
        location_name: "hardware bin",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "brand name in product name removed",
      app: {
        product_name: "DeWalt 20V MAX Drill",
        manufacturer: "DeWalt",
        location_name: "tool wall",
      },
      sheet: {
        product_name: "20V MAX Drill",
        manufacturer: "DeWalt",
        location_name: "tool wall",
      },
      expectedCounts: { renamed: 1 },
    },
    {
      name: "UPC match overrides location+manufacturer mismatch",
      app: {
        product_name: "Old Name",
        manufacturer: "Brand A",
        location_name: "shelf 1",
        upc: "123456789012",
      },
      sheet: {
        product_name: "New Name",
        manufacturer: "Brand B",
        location_name: "shelf 2",
        upc: "123456789012",
      },
      expectedCounts: { renamed: 1 },
    },
  ];

  describe("SHOULD detect renames", () => {
    it.each(shouldDetectRename)("$name", ({
      app,
      sheet,
      expectedCounts,
      renamedFrom,
      renamedTo,
    }) => {
      const appRows = [
        makeAppRow({
          ...app,
          location_id: app.location_name
            ? unsafeLocationId("loc-1")
            : undefined,
          inventory_entry_id: app.location_name
            ? unsafeInventoryId("inv-1")
            : undefined,
        }),
      ];
      const sheetRows = [makeSheetRow(sheet)];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // Assert exact counts for all states
      expect(counts).toEqual({
        matched: expectedCounts.matched ?? 0,
        conflict: expectedCounts.conflict ?? 0,
        app_only: expectedCounts.app_only ?? 0,
        sheet_only: expectedCounts.sheet_only ?? 0,
        renamed: expectedCounts.renamed ?? 0,
        moved: expectedCounts.moved ?? 0,
      });

      // Assert rename details if provided
      if (renamedFrom || renamedTo) {
        const renamed = result.find((i) => i.state === "renamed");
        expect(renamed).toBeDefined();
        if (renamedFrom) expect(renamed?.renamedFrom).toBe(renamedFrom);
        if (renamedTo) expect(renamed?.renamedTo).toBe(renamedTo);
      }
    });
  });

  const shouldNotDetectRename: RenameTestCase[] = [
    {
      name: "completely different products at DIFFERENT locations",
      app: {
        product_name: "Hammer",
        manufacturer: "Stanley",
        location_name: "garage toolbox",
      },
      sheet: {
        product_name: "Screwdriver",
        manufacturer: "Stanley",
        location_name: "workshop drawer",
      },
      expectedCounts: { app_only: 1, sheet_only: 1 },
    },
    {
      name: "different specific manufacturers (even with name containment)",
      app: {
        product_name: "Circular Saw",
        manufacturer: "DeWalt",
        location_name: "workshop",
      },
      sheet: {
        product_name: "Circular Saw 7-1/4 inch",
        manufacturer: "Makita",
        location_name: "workshop",
      },
      expectedCounts: { app_only: 1, sheet_only: 1 },
    },
    {
      name: "completely unrelated names",
      app: {
        product_name: "Flour, all purpose",
        manufacturer: "King Arthur",
        location_name: "pantry",
      },
      sheet: {
        product_name: "Sugar, white",
        manufacturer: "Domino",
        location_name: "pantry",
      },
      expectedCounts: { app_only: 1, sheet_only: 1 },
    },
  ];

  describe("should NOT detect renames (false positives)", () => {
    it.each(shouldNotDetectRename)("$name", ({
      app,
      sheet,
      expectedCounts,
    }) => {
      const appRows = [
        makeAppRow({
          ...app,
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [makeSheetRow(sheet)];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: expectedCounts.matched ?? 0,
        conflict: expectedCounts.conflict ?? 0,
        app_only: expectedCounts.app_only ?? 0,
        sheet_only: expectedCounts.sheet_only ?? 0,
        renamed: expectedCounts.renamed ?? 0,
        moved: expectedCounts.moved ?? 0,
      });
    });

    it("may detect false positive for unrelated products at same location+manufacturer (known limitation)", () => {
      // Trade-off: we catch real typo fixes like "wrenches" -> "rwrenches"
      // but may also match completely different items at same location
      const appRows = [
        makeAppRow({
          product_name: "Hammer",
          manufacturer: "Stanley",
          location_name: "toolbox",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Screwdriver",
          manufacturer: "Stanley",
          location_name: "toolbox",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // Accept either outcome - users can resolve in sync preview
      expect(counts.renamed).toBeLessThanOrEqual(1);
      expect(result).toHaveLength(counts.renamed === 1 ? 1 : 2);
    });

    it("should NOT detect rename when identical product exists at multiple locations", () => {
      const appRows = [
        makeAppRow({
          product_name: "WD-40",
          manufacturer: "WD-40 Company",
          location_name: "garage",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
        makeAppRow({
          product_name: "WD-40",
          manufacturer: "WD-40 Company",
          location_name: "workshop",
          location_id: unsafeLocationId("loc-2"),
          inventory_entry_id: unsafeInventoryId("inv-2"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "WD-40",
          manufacturer: "WD-40 Company",
          location_name: "garage",
        }),
        makeSheetRow({
          product_name: "WD-40",
          manufacturer: "WD-40 Company",
          location_name: "workshop",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 2,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });
    });
  });

  const moveTests: RenameTestCase[] = [
    {
      name: "same product changes location",
      app: {
        product_name: "Drill Press",
        manufacturer: "DeWalt",
        location_name: "garage corner",
      },
      sheet: {
        product_name: "Drill Press",
        manufacturer: "DeWalt",
        location_name: "workshop bench",
      },
      expectedCounts: { moved: 1 },
      movedFrom: "garage corner",
      movedTo: "workshop bench",
    },
    {
      name: "case insensitive product name",
      app: {
        product_name: "drill press",
        manufacturer: "DeWalt",
        location_name: "garage",
      },
      sheet: {
        product_name: "Drill Press",
        manufacturer: "DeWalt",
        location_name: "workshop",
      },
      expectedCounts: { moved: 1 },
    },
  ];

  describe("move detection", () => {
    it.each(moveTests)("$name", ({
      app,
      sheet,
      expectedCounts,
      movedFrom,
      movedTo,
    }) => {
      const appRows = [
        makeAppRow({
          ...app,
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [makeSheetRow(sheet)];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: expectedCounts.matched ?? 0,
        conflict: expectedCounts.conflict ?? 0,
        app_only: expectedCounts.app_only ?? 0,
        sheet_only: expectedCounts.sheet_only ?? 0,
        renamed: expectedCounts.renamed ?? 0,
        moved: expectedCounts.moved ?? 0,
      });

      if (movedFrom || movedTo) {
        const moved = result.find((i) => i.state === "moved");
        expect(moved).toBeDefined();
        if (movedFrom) expect(moved?.movedFrom).toBe(movedFrom);
        if (movedTo) expect(moved?.movedTo).toBe(movedTo);
      }
    });
  });

  describe("manufacturer change detection", () => {
    it("should detect manufacturer-only change as conflict", () => {
      const appRows = [
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "(unspecified)",
          location_name: "",
          location_id: null,
          inventory_entry_id: null,
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "Kirkland",
          location_name: "",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 0,
        conflict: 1,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });

      const conflict = result.find((i) => i.state === "conflict");
      expect(conflict?.fieldDiffs).toBeDefined();
      expect(
        conflict?.fieldDiffs?.some((d) => d.field === "manufacturer"),
      ).toBe(true);
    });

    it("should detect manufacturer change with same location as conflict", () => {
      const appRows = [
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "Generic",
          location_name: "pantry",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "Kirkland",
          location_name: "pantry",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 0,
        conflict: 1,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });
    });

    it("should detect manufacturer change when both have no location as conflict", () => {
      // This tests the scenario where a product exists without inventory entries
      // (product-only row) and only the manufacturer changes
      const appRows = [
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "(unspecified)",
          location_name: "",
          location_id: null,
          inventory_entry_id: null,
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "Kirkland",
          location_name: "",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // Should be detected as conflict, not sheet_only + app_only
      expect(counts).toEqual({
        matched: 0,
        conflict: 1,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });

      const conflict = result.find((i) => i.state === "conflict");
      expect(
        conflict?.fieldDiffs?.some((d) => d.field === "manufacturer"),
      ).toBe(true);
    });

    it("should detect manufacturer AND location change as moved (manufacturer diff is secondary)", () => {
      // When both location and manufacturer change, the move takes precedence
      const appRows = [
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "(unspecified)",
          location_name: "pantry",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "Kirkland",
          location_name: "kitchen",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // Location change takes precedence, becomes "moved"
      expect(counts).toEqual({
        matched: 0,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 1,
      });
    });

    it("should detect change via UPC when there are multiple entries for same product", () => {
      // When there are multiple inventory entries for the same product,
      // but one has a matching UPC, we can identify the match
      const appRows = [
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "CA olive range", // Typo in app
          location_name: "",
          location_id: null,
          inventory_entry_id: null,
          upc: "850687100339",
        }),
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "Another Brand",
          location_name: "pantry",
          location_id: unsafeLocationId("loc-2"),
          inventory_entry_id: unsafeInventoryId("inv-2"),
          upc: "999999999999",
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "CA olive ranch", // Corrected in sheet
          location_name: "",
          upc: "850687100339",
        }),
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "Another Brand",
          location_name: "pantry",
          upc: "999999999999",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // UPC match allows us to identify the manufacturer change
      expect(counts).toEqual({
        matched: 1, // The "Another Brand" one matches exactly
        conflict: 1, // The "CA olive range/ranch" one is a conflict
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });

      const conflict = result.find((i) => i.state === "conflict");
      expect(
        conflict?.fieldDiffs?.some((d) => d.field === "manufacturer"),
      ).toBe(true);
    });

    it("should fall back to app_only/sheet_only when no UPC and multiple entries", () => {
      // When there are multiple entries without UPC, we can't determine which one changed
      const appRows = [
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "(unspecified)",
          location_name: "pantry",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
        makeAppRow({
          product_name: "olive oil",
          manufacturer: "(unspecified)",
          location_name: "garage",
          location_id: unsafeLocationId("loc-2"),
          inventory_entry_id: unsafeInventoryId("inv-2"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "olive oil",
          manufacturer: "Kirkland",
          location_name: "",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // Can't detect - falls through to app_only and sheet_only
      expect(counts).toEqual({
        matched: 0,
        conflict: 0,
        app_only: 2,
        sheet_only: 1,
        renamed: 0,
        moved: 0,
      });
    });
  });

  describe("edge cases", () => {
    it("should handle empty manufacturer matching with (unspecified)", () => {
      const appRows = [
        makeAppRow({
          product_name: "Zip Ties",
          manufacturer: "(unspecified)",
          location_name: "drawer",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Zip Ties",
          manufacturer: undefined,
          location_name: "drawer",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 1,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });
    });

    it("should handle product-only rows (no location)", () => {
      const appRows = [
        makeAppRow({
          product_name: "Widget",
          manufacturer: "Acme",
          location_name: "",
          location_id: null,
          inventory_entry_id: null,
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Widget",
          manufacturer: "Acme",
          location_name: "",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 1,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });
    });

    it("should pick best match when multiple potential rename candidates exist", () => {
      const appRows = [
        makeAppRow({
          product_name: "Screwdriver Set",
          manufacturer: "Stanley",
          location_name: "toolbox",
          upc: "111111111111",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "6-Piece Screwdriver Set", // Name containment
          manufacturer: "Stanley",
          location_name: "toolbox",
          upc: "",
        }),
        makeSheetRow({
          product_name: "Phillips Screwdriver", // No containment but has UPC
          manufacturer: "Stanley",
          location_name: "toolbox",
          upc: "111111111111",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // UPC match wins, other sheet row becomes sheet_only
      expect(counts).toEqual({
        matched: 0,
        conflict: 0,
        app_only: 0,
        sheet_only: 1,
        renamed: 1,
        moved: 0,
      });

      const renamed = result.find((i) => i.state === "renamed");
      expect(renamed?.renamedTo).toBe("Phillips Screwdriver");

      const sheetOnly = result.find((i) => i.state === "sheet_only");
      expect(sheetOnly?.sheetData?.productName).toBe("6-Piece Screwdriver Set");
    });
  });

  describe("shortcode-based location matching", () => {
    it("should match by shortcode when location name differs (no false move)", () => {
      const appRows = [
        makeAppRow({
          product_name: "Drill Press",
          manufacturer: "DeWalt",
          location_name: "rolling chrome shelf",
          location_shortcode: unsafeLocationShortcode("L-0042"),
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Drill Press",
          manufacturer: "DeWalt",
          location_name: "white metal shelf",
          location_shortcode: "L-0042",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      // Should match on shortcode, not produce a false "moved"
      expect(counts).toEqual({
        matched: 1,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 0,
      });
    });

    it("should still detect moves when shortcodes differ", () => {
      const appRows = [
        makeAppRow({
          product_name: "Drill Press",
          manufacturer: "DeWalt",
          location_name: "garage",
          location_shortcode: unsafeLocationShortcode("L-0042"),
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Drill Press",
          manufacturer: "DeWalt",
          location_name: "workshop",
          location_shortcode: "L-0099",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 0,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 1,
      });
    });

    it("should fall back to name comparison when shortcodes are absent", () => {
      const appRows = [
        makeAppRow({
          product_name: "Drill Press",
          manufacturer: "DeWalt",
          location_name: "garage",
          location_shortcode: null,
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Drill Press",
          manufacturer: "DeWalt",
          location_name: "workshop",
        }),
      ];

      const result = compareInventoryForSync(appRows, sheetRows);
      const counts = countByState(result);

      expect(counts).toEqual({
        matched: 0,
        conflict: 0,
        app_only: 0,
        sheet_only: 0,
        renamed: 0,
        moved: 1,
      });
    });
  });
});

// ── Location sync tests ──────────────────────────────────────────────

// Helper to create a minimal location app row
const makeLocationAppRow = (
  overrides: Partial<LocationCSVExportRow> & { location_name: string },
): LocationCSVExportRow => {
  const { location_name, ...rest } = overrides;
  return {
    location_shortcode: null,
    location_name,
    parent_name: null,
    location_type: "shelf",
    description: null,
    location_image: null,
    last_inventory_date: null,
    location_id: unsafeLocationId("loc-1"),
    ...rest,
  };
};

// Helper to create a minimal location sheet row
const makeLocationSheetRow = (
  overrides: Partial<LocationCSVRow> & { location_name: string },
): LocationCSVRow => {
  const { location_name, ...rest } = overrides;
  return {
    location_name,
    ...rest,
  };
};

// Count location items by state
const countLocationsByState = (
  result: ReturnType<typeof compareLocationsForSync>,
): Record<SyncState, number> => {
  const counts: Record<SyncState, number> = {
    matched: 0,
    conflict: 0,
    app_only: 0,
    sheet_only: 0,
    renamed: 0,
    moved: 0,
  };
  for (const item of result) {
    counts[item.state]++;
  }
  return counts;
};

describe("compareLocationsForSync - parent rename handling", () => {
  it("should not report parent_name conflict when parent was renamed", () => {
    // Parent "rolling chrome shelf" renamed to "white metal shelf"
    // Children reference parent by name, so both sides have different parent names
    const appRows = [
      // The renamed parent itself
      makeLocationAppRow({
        location_name: "rolling chrome shelf",
        location_shortcode: unsafeLocationShortcode("L-0001"),
        location_id: unsafeLocationId("loc-parent"),
        location_type: "shelf",
        description: "metal shelf unit",
      }),
      // A child whose parent_name differs because of the rename
      makeLocationAppRow({
        location_name: "shelf A",
        location_shortcode: unsafeLocationShortcode("L-0002"),
        parent_name: "rolling chrome shelf",
        location_id: unsafeLocationId("loc-child"),
      }),
    ];

    const sheetRows = [
      // Renamed parent in sheet
      makeLocationSheetRow({
        location_name: "white metal shelf",
        location_shortcode: "L-0001",
        location_type: "shelf",
        description: "metal shelf unit",
      }),
      // Child still references renamed parent
      makeLocationSheetRow({
        location_name: "shelf A",
        location_shortcode: "L-0002",
        parent_name: "white metal shelf",
      }),
    ];

    const result = compareLocationsForSync(appRows, sheetRows);
    const counts = countLocationsByState(result);

    // Parent should be "renamed", child should be "matched" (not "conflict")
    expect(counts.renamed).toBe(1);
    expect(counts.matched).toBe(1);
    expect(counts.conflict).toBe(0);

    const child = result.find((i) => i.appData?.locationName === "shelf A");
    expect(child?.state).toBe("matched");
  });

  it("should keep real parent_name conflicts when not explained by a rename", () => {
    const appRows = [
      makeLocationAppRow({
        location_name: "drawer A",
        location_shortcode: unsafeLocationShortcode("L-0010"),
        parent_name: "kitchen",
        location_id: unsafeLocationId("loc-1"),
      }),
    ];

    const sheetRows = [
      makeLocationSheetRow({
        location_name: "drawer A",
        location_shortcode: "L-0010",
        parent_name: "living room",
      }),
    ];

    const result = compareLocationsForSync(appRows, sheetRows);
    const counts = countLocationsByState(result);

    expect(counts.conflict).toBe(1);
    const item = result.find((i) => i.appData?.locationName === "drawer A");
    expect(item?.state).toBe("conflict");
    expect(item?.fieldDiffs?.some((d) => d.field === "parent_name")).toBe(true);
  });
});
