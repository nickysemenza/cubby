import type { ActorContext } from "@cubby/schemas/context";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { createIngredient } from "./ingredient";
import {
  createProduct,
  findProductByNameFuzzyManufacturer,
  getProductByID,
  productList,
  updateProduct,
} from "./product";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

describe("product repository", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });

  it("should create a product and retrieve it by ID", async () => {
    // Create a test product
    const productData = {
      name: "Test Product",
      manufacturer: "Test Manufacturer",
      model: "TEST-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: null,
      unitMappings: [],
      externalIds: [],
    };

    // Create the product
    const createdProduct = await createProduct(db, productData, TEST_ACTOR);

    // Verify the product was created correctly
    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.upc).toEqual(productData.upc);

    // Retrieve the product by ID
    const retrievedProduct = await getProductByID(db, createdProduct.id);

    // Verify the retrieved product matches the created product
    expect(retrievedProduct.id).toEqual(createdProduct.id);
    expect(retrievedProduct.name).toEqual(productData.name);
    expect(retrievedProduct.manufacturer).toEqual(productData.manufacturer);
    expect(retrievedProduct.unitMappings).toEqual([]);
    expect(retrievedProduct.ingredient).toBeNull();
  });

  it("should list products with pagination and sorting", async () => {
    // Create multiple test products
    const products = [
      {
        name: "Product A",
        manufacturer: "Manufacturer X",
        model: "MODEL-A",
        upc: "111111111111",
        ndb_number: null,
      },
      {
        name: "Product B",
        manufacturer: "Manufacturer Y",
        model: "MODEL-B",
        upc: "222222222222",
        ndb_number: null,
      },
      {
        name: "Product C",
        manufacturer: "Manufacturer X",
        model: "MODEL-C",
        upc: "333333333333",
        ndb_number: null,
      },
    ];

    for (const product of products) {
      await createProduct(
        db,
        {
          ...product,
          ingredientId: null,
          expectedQuantity: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );
    }

    // Test listing with pagination - first page
    const firstPage = await productList(
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      { orderBy: "name", direction: "asc" },
      { pageIndex: 0, pageSize: 2 },
    );

    // Should return first 2 products sorted by name ascending
    expect(firstPage.data.length).toEqual(2);
    expect(firstPage.count).toEqual(3); // Total count should be 3
    expect(firstPage.data[0].name).toEqual("Product A");
    expect(firstPage.data[1].name).toEqual("Product B");

    // Test listing with pagination - second page
    const secondPage = await productList(
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      { orderBy: "name", direction: "asc" },
      { pageIndex: 1, pageSize: 2 },
    );

    // Should return the last product
    expect(secondPage.data.length).toEqual(1);
    expect(secondPage.count).toEqual(3);
    expect(secondPage.data[0].name).toEqual("Product C");

    // Test listing with filtering by manufacturer
    const filteredList = await productList(
      db,
      undefined,
      "Manufacturer X",
      undefined,
      undefined,
      { orderBy: "name", direction: "asc" },
      { pageIndex: 0, pageSize: 10 },
    );

    // Should return only products from Manufacturer X
    expect(filteredList.data.length).toEqual(2);
    expect(filteredList.count).toEqual(2);
    expect(filteredList.data[0].manufacturer).toEqual("Manufacturer X");
    expect(filteredList.data[1].manufacturer).toEqual("Manufacturer X");
  });

  it("should update a product", async () => {
    // Create a test product
    const productData = {
      name: "Original Product",
      manufacturer: "Original Manufacturer",
      model: "Original-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: null,
      unitMappings: [],
      externalIds: [],
    };

    // Create the product
    const createdProduct = await createProduct(db, productData, TEST_ACTOR);

    // Update the product
    const updatedProduct = await updateProduct(
      db,
      createdProduct.id,
      {
        name: "Updated Product",
        manufacturer: "Updated Manufacturer",
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 5.99, unit: "lb" },
            source: "test",
          },
        ],
      },
      TEST_ACTOR,
    );

    // Verify the product was updated correctly
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged

    // Retrieve the product to verify unit mappings
    const retrievedProduct = await getProductByID(db, createdProduct.id);

    // Verify unit mappings were created
    expect(retrievedProduct.unitMappings.length).toEqual(1);
    expect(retrievedProduct.unitMappings[0].a).toEqual({
      value: 1,
      unit: "each",
    });
    expect(retrievedProduct.unitMappings[0].b).toEqual({
      value: 5.99,
      unit: "lb",
    });
    expect(retrievedProduct.unitMappings[0].source).toEqual("test");
  });

  it("should link a product to an ingredient", async () => {
    // First create an ingredient
    const ingredient = await createIngredient(
      db,
      {
        name: "Test Ingredient",
        aliases: ["test", "ingredient"],
      },
      TEST_ACTOR,
    );

    // Create a product linked to the ingredient
    const productData = {
      name: "Test Product with Ingredient",
      manufacturer: "Test Manufacturer",
      model: "TEST-ING-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: ingredient.id,
      unitMappings: [],
      externalIds: [],
    };

    // Create the product
    const createdProduct = await createProduct(db, productData, TEST_ACTOR);

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(db, createdProduct.id);

    // Verify the ingredient association
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Test Ingredient");
  });

  it("should update ingredient association", async () => {
    // Create two ingredients
    const ingredient1 = await createIngredient(
      db,
      {
        name: "Ingredient 1",
        aliases: ["ing1"],
      },
      TEST_ACTOR,
    );

    const ingredient2 = await createIngredient(
      db,
      {
        name: "Ingredient 2",
        aliases: ["ing2"],
      },
      TEST_ACTOR,
    );

    // Create a product linked to the first ingredient
    const productData = {
      name: "Test Product with Ingredient",
      manufacturer: "Test Manufacturer",
      model: "TEST-ING-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: ingredient1.id,
      unitMappings: [],
      externalIds: [],
    };

    // Create the product
    const createdProduct = await createProduct(db, productData, TEST_ACTOR);

    // Update the product to link to the second ingredient
    await updateProduct(
      db,
      createdProduct.id,
      {
        ingredientId: ingredient2.id,
      },
      TEST_ACTOR,
    );

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(db, createdProduct.id);

    // Verify the ingredient association was updated
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient2.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Ingredient 2");

    // Update the product to remove ingredient association
    await updateProduct(
      db,
      createdProduct.id,
      {
        ingredientId: null,
      },
      TEST_ACTOR,
    );

    // Retrieve the product again
    const updatedProduct = await getProductByID(db, createdProduct.id);

    // Verify the ingredient association was removed
    expect(updatedProduct.ingredient).toBeNull();
  });

  describe("findProductByNameFuzzyManufacturer", () => {
    it("should find product by exact name and manufacturer match", async () => {
      // Create a product with specific manufacturer
      await createProduct(
        db,
        {
          name: "Power Drill",
          manufacturer: "DeWalt",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find exact match
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Power Drill",
        "DeWalt",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Power Drill");
      expect(found!.manufacturer).toEqual("DeWalt");
    });

    it("should find product when incoming manufacturer is (unspecified)", async () => {
      // Create a product with specific manufacturer
      await createProduct(
        db,
        {
          name: "Router Table",
          manufacturer: "Bosch",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find product when searching with "(unspecified)" - matches by name only
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Router Table",
        "(unspecified)",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Router Table");
      expect(found!.manufacturer).toEqual("Bosch");
    });

    it("should find product when incoming manufacturer is empty string", async () => {
      // Create a product with specific manufacturer
      await createProduct(
        db,
        {
          name: "Table Saw",
          manufacturer: "Makita",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find product when searching with empty string
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Table Saw",
        "",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Table Saw");
    });

    it("should find product when incoming manufacturer is null", async () => {
      // Create a product with specific manufacturer
      await createProduct(
        db,
        {
          name: "Circular Saw",
          manufacturer: "Ryobi",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find product when searching with null
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Circular Saw",
        null,
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Circular Saw");
    });

    it("should fallback to (unspecified) manufacturer when specific manufacturer not found", async () => {
      // Create a product with (unspecified) manufacturer
      await createProduct(
        db,
        {
          name: "Hammer",
          manufacturer: "(unspecified)",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find product with "(unspecified)" when searching for specific manufacturer
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Hammer",
        "Stanley",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Hammer");
      expect(found!.manufacturer).toEqual("(unspecified)");
    });

    it("should NOT find product when both have different specific manufacturers", async () => {
      // Create a product with specific manufacturer
      await createProduct(
        db,
        {
          name: "Jigsaw",
          manufacturer: "DeWalt",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should NOT find product when manufacturers are both specific and different
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Jigsaw",
        "Bosch",
      );

      expect(found).toBeNull();
    });

    it("should prefer exact manufacturer match over (unspecified)", async () => {
      // Create two products: one with specific manufacturer, one with (unspecified)
      await createProduct(
        db,
        {
          name: "Screwdriver",
          manufacturer: "Stanley",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      await createProduct(
        db,
        {
          name: "Screwdriver",
          manufacturer: "(unspecified)",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find exact match first
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Screwdriver",
        "Stanley",
      );

      expect(found).not.toBeNull();
      expect(found!.manufacturer).toEqual("Stanley");
    });

    it("should return null when product does not exist", async () => {
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "Non-existent Product",
        "Any Manufacturer",
      );

      expect(found).toBeNull();
    });

    it("should be case insensitive for product name", async () => {
      await createProduct(
        db,
        {
          name: "Power Drill PRO",
          manufacturer: "DeWalt",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Should find with different case
      const found = await findProductByNameFuzzyManufacturer(
        db,
        "POWER DRILL PRO",
        "dewalt", // also lowercase
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Power Drill PRO");
    });
  });
});
