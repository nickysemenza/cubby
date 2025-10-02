import { describe, expect, test, vi } from "vitest";
import {
  foodLookupParamFromProduct,
  findProductByName,
  findProductsByFoodIdentifier,
  findOrCreateProduct,
} from "./product";
import { Product } from "@prisma/client";
import { type Database } from "~/server/db";
import { type ProductConfigItem } from "~/schemas/config";
import { unsafeProjectId } from "~/schemas/identifiers";

describe("product repository helpers", () => {
  describe("foodLookupParamFromProduct", () => {
    test("returns UPC lookup when UPC is present", () => {
      const product = { upc: "123456789012", ndb_number: null };
      const result = foodLookupParamFromProduct(product);

      expect(result).toEqual({
        kind: "upc",
        gtin_upc: "123456789012",
      });
    });

    test("returns NDB lookup when UPC is null but NDB is present", () => {
      const product = { upc: null, ndb_number: 12345 };
      const result = foodLookupParamFromProduct(product);

      expect(result).toEqual({
        kind: "ndb",
        ndb_number: 12345,
      });
    });

    test("returns null when both UPC and NDB are null", () => {
      const product = { upc: null, ndb_number: null };
      const result = foodLookupParamFromProduct(product);

      expect(result).toBeNull();
    });

    test("prioritizes UPC over NDB when both are present", () => {
      const product = { upc: "123456789012", ndb_number: 12345 };
      const result = foodLookupParamFromProduct(product);

      expect(result).toEqual({
        kind: "upc",
        gtin_upc: "123456789012",
      });
    });
  });

  describe("findProductByName", () => {
    test("returns product when single match found", async () => {
      const mockProduct = { id: "product-1", name: "Test Product" } as Product;
      const mockDb = {
        product: {
          findMany: vi.fn().mockResolvedValue([mockProduct]),
        },
      } as unknown as Database;

      const result = await findProductByName(mockDb, "Test Product");

      expect(mockDb.product.findMany).toHaveBeenCalledWith({
        where: {
          name: {
            equals: "Test Product",
            mode: "insensitive",
          },
        },
      });
      expect(result).toEqual(mockProduct);
    });

    test("throws error when no products found", async () => {
      const mockDb = {
        product: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as unknown as Database;

      await expect(findProductByName(mockDb, "Nonexistent")).rejects.toThrow(
        "Product Nonexistent not found",
      );
    });

    test("throws error when multiple products found", async () => {
      const mockProducts = [
        { id: "product-1", name: "Test Product" },
        { id: "product-2", name: "Test Product" },
      ] as Product[];

      const mockDb = {
        product: {
          findMany: vi.fn().mockResolvedValue(mockProducts),
        },
      } as unknown as Database;

      await expect(findProductByName(mockDb, "Test Product")).rejects.toThrow(
        "findProductByName: Product Test Product is ambiguous",
      );
    });
  });

  describe("findProductsByFoodIdentifier", () => {
    test("returns empty array when lookup is undefined", async () => {
      const mockDb = {} as unknown as Database;
      const result = await findProductsByFoodIdentifier(mockDb, undefined);
      expect(result).toEqual([]);
    });

    test("finds products by UPC", async () => {
      const mockProducts = [
        { id: "product-1", upc: "123456789012" },
      ] as Product[];
      const mockDb = {
        product: {
          findMany: vi.fn().mockResolvedValue(mockProducts),
        },
      } as unknown as Database;

      const lookup = { kind: "upc" as const, gtin_upc: "123456789012" };
      const result = await findProductsByFoodIdentifier(mockDb, lookup);

      expect(mockDb.product.findMany).toHaveBeenCalledWith({
        where: { upc: "123456789012" },
      });
      expect(result).toEqual(mockProducts);
    });

    test("finds products by NDB number", async () => {
      const mockProducts = [
        { id: "product-1", ndb_number: 12345 },
      ] as Product[];
      const mockDb = {
        product: {
          findMany: vi.fn().mockResolvedValue(mockProducts),
        },
      } as unknown as Database;

      const lookup = { kind: "ndb" as const, ndb_number: 12345 };
      const result = await findProductsByFoodIdentifier(mockDb, lookup);

      expect(mockDb.product.findMany).toHaveBeenCalledWith({
        where: { ndb_number: 12345 },
      });
      expect(result).toEqual(mockProducts);
    });

    test("validates lookup parameter with zod", async () => {
      const mockDb = {
        product: {
          findMany: vi.fn(),
        },
      } as unknown as Database;

      const invalidLookup = {
        kind: "invalid",
        value: "test",
      } as unknown as Parameters<typeof findProductsByFoodIdentifier>[1];

      await expect(
        findProductsByFoodIdentifier(mockDb, invalidLookup),
      ).rejects.toThrow(); // Should throw zod validation error
    });
  });

  describe("findOrCreateProduct", () => {
    const mockDate = new Date("2023-01-01T12:00:00Z");

    test("creates new product without ingredient", async () => {
      const mockProduct = { id: "product-1", name: "Test Product" } as Product;
      const mockDb = {
        product: {
          upsert: vi.fn().mockResolvedValue(mockProduct),
        },
        productUnitMappings: {
          deleteMany: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue({}),
        },
      } as unknown as Database;

      const productConfig: ProductConfigItem = {
        name: "Test Product",
        manufacturer: "Test Manufacturer",
        upc: "123456789012",
        model: "TEST-123",
        ndb_number: 12345,
        ingredient: false,
      };

      const result = await findOrCreateProduct(
        mockDb,
        mockDate,
        productConfig,
        unsafeProjectId("00000000-0000-0000-0000-000000000000"),
      );

      expect(mockDb.product.upsert).toHaveBeenCalledWith({
        where: {
          projectId_name_manufacturer: {
            projectId: "00000000-0000-0000-0000-000000000000",
            name: "Test Product",
            manufacturer: "Test Manufacturer",
          },
        },
        create: {
          name: "Test Product",
          manufacturer: "Test Manufacturer",
          upc: "123456789012",
          ndb_number: 12345,
          model: "TEST-123",
          updatedAt: mockDate,
          Ingredient: undefined,
          project: {
            connect: {
              id: "00000000-0000-0000-0000-000000000000",
            },
          },
        },
        update: {
          name: "Test Product",
          manufacturer: "Test Manufacturer",
          upc: "123456789012",
          ndb_number: 12345,
          model: "TEST-123",
          updatedAt: mockDate,
          Ingredient: undefined,
          project: {
            connect: {
              id: "00000000-0000-0000-0000-000000000000",
            },
          },
        },
      });
      expect(result).toEqual(mockProduct);
    });

    test("creates product with price_per mapping", async () => {
      const mockProduct = { id: "product-1", name: "Test Product" } as Product;
      const mockDb = {
        product: {
          upsert: vi.fn().mockResolvedValue(mockProduct),
        },
        productUnitMappings: {
          deleteMany: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue({}),
        },
      } as unknown as Database;

      const productConfig: ProductConfigItem = {
        name: "Test Product",
        manufacturer: "Test Manufacturer",
        ingredient: false,
        price_per: 2.5,
      };

      await findOrCreateProduct(
        mockDb,
        mockDate,
        productConfig,
        unsafeProjectId("00000000-0000-0000-0000-000000000000"),
      );

      expect(mockDb.productUnitMappings.createMany).toHaveBeenCalledWith({
        data: [
          {
            productId: "product-1",
            a: { value: 1, unit: "each" },
            b: { value: 2.5, unit: "dollar" },
            source: "config",
          },
        ],
      });
    });

    test("creates product with unit_mappings", async () => {
      const mockProduct = { id: "product-1", name: "Test Product" } as Product;
      const mockDb = {
        product: {
          upsert: vi.fn().mockResolvedValue(mockProduct),
        },
        productUnitMappings: {
          deleteMany: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue({}),
        },
      } as unknown as Database;

      const productConfig: ProductConfigItem = {
        name: "Test Product",
        manufacturer: "Test Manufacturer",
        ingredient: false,
        unit_mappings: [
          {
            a: { value: 1, unit: "cup" },
            b: { value: 240, unit: "ml" },
            source: "config",
          },
        ],
      };

      await findOrCreateProduct(
        mockDb,
        mockDate,
        productConfig,
        unsafeProjectId("00000000-0000-0000-0000-000000000000"),
      );

      expect(mockDb.productUnitMappings.createMany).toHaveBeenCalledWith({
        data: [
          {
            productId: "product-1",
            a: { value: 1, unit: "cup" },
            b: { value: 240, unit: "ml" },
            source: "config",
          },
        ],
      });
    });

    test("combines price_per and unit_mappings", async () => {
      const mockProduct = { id: "product-1", name: "Test Product" } as Product;
      const mockDb = {
        product: {
          upsert: vi.fn().mockResolvedValue(mockProduct),
        },
        productUnitMappings: {
          deleteMany: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue({}),
        },
      } as unknown as Database;

      const productConfig: ProductConfigItem = {
        name: "Test Product",
        manufacturer: "Test Manufacturer",
        ingredient: false,
        price_per: 1.99,
        unit_mappings: [
          {
            a: { value: 100, unit: "grams" },
            b: { value: 0.5, unit: "cup" },
            source: "config",
          },
        ],
      };

      await findOrCreateProduct(
        mockDb,
        mockDate,
        productConfig,
        unsafeProjectId("00000000-0000-0000-0000-000000000000"),
      );

      expect(mockDb.productUnitMappings.createMany).toHaveBeenCalledWith({
        data: [
          {
            productId: "product-1",
            a: { value: 100, unit: "grams" },
            b: { value: 0.5, unit: "cup" },
            source: "config",
          },
          {
            productId: "product-1",
            a: { value: 1, unit: "each" },
            b: { value: 1.99, unit: "dollar" },
            source: "config",
          },
        ],
      });
    });

    test("cleans up existing mappings before creating new ones", async () => {
      const mockProduct = { id: "product-1", name: "Test Product" } as Product;
      const mockDb = {
        product: {
          upsert: vi.fn().mockResolvedValue(mockProduct),
        },
        productUnitMappings: {
          deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
          createMany: vi.fn().mockResolvedValue({}),
        },
      } as unknown as Database;

      const productConfig: ProductConfigItem = {
        name: "Test Product",
        manufacturer: "Test Manufacturer",
        ingredient: false,
      };

      await findOrCreateProduct(
        mockDb,
        mockDate,
        productConfig,
        unsafeProjectId("00000000-0000-0000-0000-000000000000"),
      );

      expect(mockDb.productUnitMappings.deleteMany).toHaveBeenCalledWith({
        where: { productId: "product-1" },
      });
      expect(mockDb.productUnitMappings.createMany).toHaveBeenCalledWith({
        data: [],
      });
    });

    // Note: Testing ingredient creation would require extensive mocking
    // and is better suited for integration tests
  });
});
