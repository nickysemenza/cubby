import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import {
  createProduct,
  getProductByID,
  productList,
  updateProduct,
  findProductByName,
} from "./product";
import { createIngredient } from "./ingredient";
import {
  unsafeIngredientId,
  unsafeProductId,
  type OrganizationId,
} from "~/schemas/identifiers";

// Test user ID for audit logging
const TEST_USER_ID = "test-user-id";

describe("product repository", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());
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
    };

    // Create the product
    const createdProduct = await createProduct(
      db,
      productData,
      organizationId,
      TEST_USER_ID,
    );

    // Verify the product was created correctly
    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.upc).toEqual(productData.upc);

    // Retrieve the product by ID
    const retrievedProduct = await getProductByID(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
    );

    // Verify the retrieved product matches the created product
    expect(retrievedProduct.id).toEqual(createdProduct.id);
    expect(retrievedProduct.name).toEqual(productData.name);
    expect(retrievedProduct.manufacturer).toEqual(productData.manufacturer);
    expect(retrievedProduct.unitMappings).toEqual([]);
    expect(retrievedProduct.ingredient).toBeNull();
  });

  it("should find a product by name", async () => {
    const productName = "Unique Product Name";

    // Create a test product
    await createProduct(
      db,
      {
        name: productName,
        manufacturer: "Test Manufacturer",
        model: "MODEL-123",
        upc: "123456789012",
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: null,
        unitMappings: [],
      },
      organizationId,
      TEST_USER_ID,
    );

    // Test finding the product by name
    const foundProduct = await findProductByName(db, productName);

    // Verify the product was found correctly
    expect(foundProduct).toBeDefined();
    expect(foundProduct.name).toEqual(productName);
  });

  it("should throw error when finding a non-existent product by name", async () => {
    await expect(findProductByName(db, "Non-existent Product")).rejects.toThrow(
      'Product with name "Non-existent Product" not found',
    );
  });

  it("should throw error when finding an ambiguous product by name", async () => {
    const ambiguousName = "Ambiguous Product";

    // Create two products with the same name
    await createProduct(
      db,
      {
        name: ambiguousName,
        manufacturer: "Manufacturer 1",
        model: "MODEL-1",
        upc: "111111111111",
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: null,
        unitMappings: [],
      },
      organizationId,
      TEST_USER_ID,
    );
    await createProduct(
      db,
      {
        name: ambiguousName,
        manufacturer: "Manufacturer 2",
        model: "MODEL-2",
        upc: "222222222222",
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: null,
        unitMappings: [],
      },
      organizationId,
      TEST_USER_ID,
    );

    await expect(findProductByName(db, ambiguousName)).rejects.toThrow(
      `Multiple products found with name "${ambiguousName}", please use ID`,
    );
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
        },
        organizationId,
        TEST_USER_ID,
      );
    }

    // Test listing with pagination - first page
    const firstPage = await productList(
      db,
      organizationId,
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
      organizationId,
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
      organizationId,
      undefined,
      "Manufacturer X",
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
    };

    // Create the product
    const createdProduct = await createProduct(
      db,
      productData,
      organizationId,
      TEST_USER_ID,
    );

    // Update the product
    const updatedProduct = await updateProduct(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
      {
        name: "Updated Product",
        manufacturer: "Updated Manufacturer",
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 5.99, unit: "dollar" },
            source: "test",
          },
        ],
      },
      TEST_USER_ID,
    );

    // Verify the product was updated correctly
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged

    // Retrieve the product to verify unit mappings
    const retrievedProduct = await getProductByID(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
    );

    // Verify unit mappings were created
    expect(retrievedProduct.unitMappings.length).toEqual(1);
    expect(retrievedProduct.unitMappings[0].a).toEqual({
      value: 1,
      unit: "each",
    });
    expect(retrievedProduct.unitMappings[0].b).toEqual({
      value: 5.99,
      unit: "dollar",
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
      organizationId,
      TEST_USER_ID,
    );

    // Create a product linked to the ingredient
    const productData = {
      name: "Test Product with Ingredient",
      manufacturer: "Test Manufacturer",
      model: "TEST-ING-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: unsafeIngredientId(ingredient.id),
      unitMappings: [],
    };

    // Create the product
    const createdProduct = await createProduct(
      db,
      productData,
      organizationId,
      TEST_USER_ID,
    );

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
    );

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
      organizationId,
      TEST_USER_ID,
    );

    const ingredient2 = await createIngredient(
      db,
      {
        name: "Ingredient 2",
        aliases: ["ing2"],
      },
      organizationId,
      TEST_USER_ID,
    );

    // Create a product linked to the first ingredient
    const productData = {
      name: "Test Product with Ingredient",
      manufacturer: "Test Manufacturer",
      model: "TEST-ING-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: unsafeIngredientId(ingredient1.id),
      unitMappings: [],
    };

    // Create the product
    const createdProduct = await createProduct(
      db,
      productData,
      organizationId,
      TEST_USER_ID,
    );

    // Update the product to link to the second ingredient
    await updateProduct(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
      {
        ingredientId: unsafeIngredientId(ingredient2.id),
      },
      TEST_USER_ID,
    );

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
    );

    // Verify the ingredient association was updated
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient2.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Ingredient 2");

    // Update the product to remove ingredient association
    await updateProduct(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
      {
        ingredientId: null,
      },
      TEST_USER_ID,
    );

    // Retrieve the product again
    const updatedProduct = await getProductByID(
      db,
      unsafeProductId(createdProduct.id),
      organizationId,
    );

    // Verify the ingredient association was removed
    expect(updatedProduct.ingredient).toBeNull();
  });
});
