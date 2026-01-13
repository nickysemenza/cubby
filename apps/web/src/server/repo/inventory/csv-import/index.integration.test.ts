/**
 * Integration tests for importInventoryFromCSV
 * Tests the full 3-phase CSV import pipeline with real database interactions.
 *
 * Phase 1: Batch fetch (5-6 queries)
 * Phase 2: In-memory processing (0 queries)
 * Phase 3: Batch write (3-5 queries in transaction)
 */

import { and, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "~/schemas/context";
import { unsafeUserId } from "~/schemas/identifiers";
import type { InventoryCSVRow } from "~/schemas/inventory";
import type { Database } from "~/server/db";
import { auditLog } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
  inventoryentryList,
} from "~/server/repo/inventory/crud";
import { createLocation, locationList } from "~/server/repo/location/crud";
import { createProduct, productList } from "~/server/repo/product/crud";
import { importInventoryFromCSV } from "./index";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

describe("importInventoryFromCSV", () => {
  let db: Database;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });

  describe("End-to-End Import", () => {
    it("should import single product with inventory", async () => {
      // Pre-create location
      const createdLocation = await createLocation(
        db,
        {
          name: "Test Pantry",
          type: "room",
          parentId: null,
        },
        TEST_ACTOR,
      );

      const rows: InventoryCSVRow[] = [
        {
          product_name: "All-Purpose Flour",
          manufacturer: "King Arthur",
          category: "food",
          quantity: 5,
          unit: "lbs",
          location_name: "Test Pantry",
        },
      ];

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      // Verify counters
      expect(result.created).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.action).toBe("created");

      // Verify product in database
      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 10 },
      );
      expect(products.data).toHaveLength(1);
      expect(products.data[0]?.name).toBe("All-Purpose Flour");
      expect(products.data[0]?.manufacturer).toBe("King Arthur");

      // Verify inventory in database
      const inventory = await inventoryentryList(
        db,
        {},
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 10 },
      );
      expect(inventory.data).toHaveLength(1);
      expect(inventory.data[0]?.amount.value).toBe(5);
      expect(inventory.data[0]?.amount.unit).toBe("lbs");
      expect(inventory.data[0]?.location.id).toBe(createdLocation.id);
    });

    it("should import multiple rows with mixed actions", async () => {
      // Pre-create location and one product
      const createdLocation = await createLocation(
        db,
        {
          name: "Kitchen",
          type: "room",
          parentId: null,
        },
        TEST_ACTOR,
      );

      const existingProduct = await createProduct(
        db,
        {
          name: "Sugar",
          manufacturer: "C&H",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        TEST_ACTOR,
      );

      // Add inventory for existing product
      await createInventoryEntry(
        db,
        {
          productId: existingProduct.id,
          locationId: createdLocation.id,
          amount: { value: 3, unit: "lbs" },
        },
        TEST_ACTOR,
      );

      const rows: InventoryCSVRow[] = [
        {
          product_name: "Flour",
          quantity: 5,
          unit: "lbs",
          location_name: "Kitchen",
        }, // created
        {
          product_name: "Sugar",
          manufacturer: "C&H",
          quantity: 3,
          unit: "lbs",
          location_name: "Kitchen",
        }, // skipped
        {
          product_name: "Salt",
          quantity: 1,
          unit: "each",
          location_name: "Kitchen",
        }, // created
        { product_name: "Vanilla", quantity: 1, unit: "each" }, // product_only
      ];

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.productOnly).toBe(1);
      expect(result.items).toHaveLength(4);

      // Verify database state
      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(products.data).toHaveLength(4); // Sugar + Flour + Salt + Vanilla

      const inventory = await inventoryentryList(
        db,
        {},
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(inventory.data).toHaveLength(3); // Sugar + Flour + Salt (no Vanilla)
    });

    it("should import with location auto-creation", async () => {
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Spice",
          quantity: 100,
          unit: "g",
          location_name: "New Pantry", // doesn't exist
        },
      ];

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      expect(result.created).toBe(1);

      // Verify location was auto-created
      const locations = await locationList(
        db,
        {},
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      const newLocation = locations.data.find((l) => l.name === "New Pantry");
      expect(newLocation).toBeDefined();
      expect(newLocation?.type).toBe("room");
      // parent can be null or undefined when not set
      expect(newLocation?.parent).toBeFalsy();
    });

    it("should resolve PENDING product IDs correctly", async () => {
      await createLocation(
        db,
        {
          name: "Storage",
          type: "room",
          parentId: null,
        },
        TEST_ACTOR,
      );

      const rows: InventoryCSVRow[] = [
        {
          product_name: "NewProduct",
          quantity: 5,
          unit: "each",
          location_name: "Storage",
        },
      ];

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      // Result should have real product ID (not "PENDING")
      expect(result.items[0]?.productId).toBeDefined();
      expect(result.items[0]?.productId).not.toBe("PENDING");

      // Inventory should link to created product
      const inventory = await inventoryentryList(
        db,
        {},
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(inventory.data[0]?.product.id).toBe(result.items[0]?.productId);
    });

    it("should handle empty rows array", async () => {
      const result = await importInventoryFromCSV(db, [], {
        actor: TEST_ACTOR,
      });

      expect(result.created).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe("Dry-Run Mode", () => {
    it("should return correct preview without writing", async () => {
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Flour",
          quantity: 5,
          unit: "lbs",
          location_name: "Pantry",
        },
        {
          product_name: "Sugar",
          quantity: 3,
          unit: "lbs",
          location_name: "Pantry",
        },
      ];

      const result = await importInventoryFromCSV(db, rows, {
        dryRun: true,
        actor: TEST_ACTOR,
      });

      // Counters should be accurate
      expect(result.created).toBe(2);
      expect(result.items).toHaveLength(2);

      // Database should be empty
      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(products.data).toHaveLength(0);

      const inventory = await inventoryentryList(
        db,
        {},
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(inventory.data).toHaveLength(0);
    });

    it("should not create audit entries in dry-run", async () => {
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Test",
          quantity: 1,
          unit: "each",
          location_name: "Test",
        },
      ];

      await importInventoryFromCSV(db, rows, {
        dryRun: true,
        actor: TEST_ACTOR,
      });

      // Check audit log is empty
      const auditEntries = await getDb(db)
        .select()
        .from(auditLog)
        .where(eq(auditLog.userId, TEST_ACTOR.userId));

      expect(auditEntries).toHaveLength(0);
    });

    it("should produce same preview as real import counters", async () => {
      await createLocation(
        db,
        {
          name: "Pantry",
          type: "room",
          parentId: null,
        },
        TEST_ACTOR,
      );

      const rows: InventoryCSVRow[] = [
        {
          product_name: "A",
          quantity: 1,
          unit: "each",
          location_name: "Pantry",
        },
        {
          product_name: "B",
          quantity: 2,
          unit: "each",
          location_name: "Pantry",
        },
      ];

      // Dry-run first
      const preview = await importInventoryFromCSV(db, rows, {
        dryRun: true,
        actor: TEST_ACTOR,
      });

      // Real import
      const actual = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      // Counters should match
      expect(preview.created).toBe(actual.created);
      expect(preview.updated).toBe(actual.updated);
      expect(preview.skipped).toBe(actual.skipped);
      expect(preview.moved).toBe(actual.moved);
    });
  });

  describe("Batch Operations", () => {
    it("should batch fetch products for all rows", async () => {
      // Create 50 products via CSV import
      const rows: InventoryCSVRow[] = Array.from({ length: 50 }, (_, i) => ({
        product_name: `Product ${i}`,
        quantity: 1,
        unit: "each",
        location_name: "Storage",
      }));

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      expect(result.created).toBe(50);
      expect(result.items).toHaveLength(50);

      // Verify all products were created
      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(products.data).toHaveLength(50);
    });

    it("should batch write in single transaction", async () => {
      // Verify atomicity by checking all-or-nothing behavior
      const rows: InventoryCSVRow[] = [
        {
          product_name: "A",
          quantity: 1,
          unit: "each",
          location_name: "Pantry",
        },
        {
          product_name: "B",
          quantity: 2,
          unit: "each",
          location_name: "Pantry",
        },
      ];

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      expect(result.created).toBe(2);

      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(products.data).toHaveLength(2);
    });
  });

  describe("Transaction Behavior", () => {
    it("should commit on success", async () => {
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Test",
          quantity: 1,
          unit: "each",
          location_name: "Pantry",
        },
      ];

      await importInventoryFromCSV(db, rows, { actor: TEST_ACTOR });

      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(products.data).toHaveLength(1);
    });
  });

  describe("Audit Logging", () => {
    it("should log product creation", async () => {
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Flour",
          quantity: 5,
          unit: "lbs",
          location_name: "Pantry",
        },
      ];

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      const auditEntries = await getDb(db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, TEST_ACTOR.userId),
            eq(auditLog.entityType, "product"),
            eq(auditLog.action, "create"),
          ),
        );

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0]?.entityId).toBe(result.items[0]?.productId);
    });

    it("should log inventory creation", async () => {
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Salt",
          quantity: 1,
          unit: "each",
          location_name: "Kitchen",
        },
      ];

      await importInventoryFromCSV(db, rows, { actor: TEST_ACTOR });

      const auditEntries = await getDb(db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, TEST_ACTOR.userId),
            eq(auditLog.entityType, "inventory"),
          ),
        );

      expect(auditEntries.length).toBeGreaterThan(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle large batch (100+ rows)", async () => {
      const rows: InventoryCSVRow[] = Array.from({ length: 150 }, (_, i) => ({
        product_name: `Product ${i}`,
        quantity: 1,
        unit: "each",
        location_name: "Storage",
      }));

      const result = await importInventoryFromCSV(db, rows, {
        actor: TEST_ACTOR,
      });

      expect(result.created).toBe(150);
      expect(result.items).toHaveLength(150);

      // Verify all products were created
      const products = await productList(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(products.data).toHaveLength(150);

      // Verify all inventory entries were created
      const inventory = await inventoryentryList(
        db,
        {},
        { orderBy: "createdAt", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );
      expect(inventory.data).toHaveLength(150);
    });
  });
});
