import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createIngredient } from "./ingredient";
import {
  createProduct,
  findProductByNameFuzzyManufacturer,
  getProductByID,
  productList,
  updateProduct,
} from "./product";
import { makeProductInput } from "./repo.fixtures";

describe("product repository", () => {
  const ctx = withTestDb();

  it("should create a product and retrieve it by ID", async () => {
    const productData = makeProductInput({ upc: "123456789012" });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Verify the product was created correctly
    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.upc).toEqual(productData.upc);

    // Retrieve the product by ID
    const retrievedProduct = await getProductByID(ctx.db, createdProduct.id);

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
        upc: "111111111111",
      },
      {
        name: "Product B",
        manufacturer: "Manufacturer Y",
        upc: "222222222222",
      },
      {
        name: "Product C",
        manufacturer: "Manufacturer X",
        upc: "333333333333",
      },
    ];

    for (const product of products) {
      await createProduct(ctx.db, makeProductInput(product), ctx.actor);
    }

    // Test listing with pagination - first page
    const firstPage = await productList(
      ctx.db,
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
    expect(firstPage.data[0]!.name).toEqual("Product A");
    expect(firstPage.data[1]!.name).toEqual("Product B");

    // Test listing with pagination - second page
    const secondPage = await productList(
      ctx.db,
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
    expect(secondPage.data[0]!.name).toEqual("Product C");

    // Test listing with filtering by manufacturer
    const filteredList = await productList(
      ctx.db,
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
    expect(filteredList.data[0]!.manufacturer).toEqual("Manufacturer X");
    expect(filteredList.data[1]!.manufacturer).toEqual("Manufacturer X");
  });

  it("should update a product", async () => {
    const productData = makeProductInput({
      name: "Original Product",
      manufacturer: "Original Manufacturer",
      model: "Original-123",
      upc: "123456789012",
    });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Update the product
    const updatedProduct = await updateProduct(
      ctx.db,
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
      ctx.actor,
    );

    // Verify the product was updated correctly
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged

    // Retrieve the product to verify unit mappings
    const retrievedProduct = await getProductByID(ctx.db, createdProduct.id);

    // Verify unit mappings were created
    expect(retrievedProduct.unitMappings.length).toEqual(1);
    expect(retrievedProduct.unitMappings[0]!.a).toEqual({
      value: 1,
      unit: "each",
    });
    expect(retrievedProduct.unitMappings[0]!.b).toEqual({
      value: 5.99,
      unit: "lb",
    });
    expect(retrievedProduct.unitMappings[0]!.source).toEqual("test");
  });

  it("should link a product to an ingredient", async () => {
    // First create an ingredient
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Test Ingredient", aliases: ["test", "ingredient"] },
      ctx.actor,
    );

    // Create a product linked to the ingredient
    const productData = makeProductInput({
      name: "Test Product with Ingredient",
      model: "TEST-ING-123",
      upc: "123456789012",
      ingredientId: ingredient.id,
    });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(ctx.db, createdProduct.id);

    // Verify the ingredient association
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Test Ingredient");
  });

  it("should update ingredient association", async () => {
    // Create two ingredients
    const ingredient1 = await createIngredient(
      ctx.db,
      { name: "Ingredient 1", aliases: ["ing1"] },
      ctx.actor,
    );

    const ingredient2 = await createIngredient(
      ctx.db,
      { name: "Ingredient 2", aliases: ["ing2"] },
      ctx.actor,
    );

    // Create a product linked to the first ingredient
    const productData = makeProductInput({
      name: "Test Product with Ingredient",
      model: "TEST-ING-123",
      upc: "123456789012",
      ingredientId: ingredient1.id,
    });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Update the product to link to the second ingredient
    await updateProduct(
      ctx.db,
      createdProduct.id,
      { ingredientId: ingredient2.id },
      ctx.actor,
    );

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(ctx.db, createdProduct.id);

    // Verify the ingredient association was updated
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient2.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Ingredient 2");

    // Update the product to remove ingredient association
    await updateProduct(
      ctx.db,
      createdProduct.id,
      { ingredientId: null },
      ctx.actor,
    );

    // Retrieve the product again
    const updatedProduct = await getProductByID(ctx.db, createdProduct.id);

    // Verify the ingredient association was removed
    expect(updatedProduct.ingredient).toBeNull();
  });

  describe("findProductByNameFuzzyManufacturer", () => {
    it("should find product by exact name and manufacturer match", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Power Drill",
          manufacturer: "DeWalt",
          model: null,
        }),
        ctx.actor,
      );

      // Should find exact match
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Power Drill",
        "DeWalt",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Power Drill");
      expect(found!.manufacturer).toEqual("DeWalt");
    });

    it("should find product when incoming manufacturer is (unspecified)", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Router Table",
          manufacturer: "Bosch",
          model: null,
        }),
        ctx.actor,
      );

      // Should find product when searching with "(unspecified)" - matches by name only
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Router Table",
        "(unspecified)",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Router Table");
      expect(found!.manufacturer).toEqual("Bosch");
    });

    it("should find product when incoming manufacturer is empty string", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Table Saw",
          manufacturer: "Makita",
          model: null,
        }),
        ctx.actor,
      );

      // Should find product when searching with empty string
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Table Saw",
        "",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Table Saw");
    });

    it("should find product when incoming manufacturer is null", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Circular Saw",
          manufacturer: "Ryobi",
          model: null,
        }),
        ctx.actor,
      );

      // Should find product when searching with null
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Circular Saw",
        null,
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Circular Saw");
    });

    it("should fallback to (unspecified) manufacturer when specific manufacturer not found", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Hammer",
          manufacturer: "(unspecified)",
          model: null,
        }),
        ctx.actor,
      );

      // Should find product with "(unspecified)" when searching for specific manufacturer
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Hammer",
        "Stanley",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Hammer");
      expect(found!.manufacturer).toEqual("(unspecified)");
    });

    it("should NOT find product when both have different specific manufacturers", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Jigsaw",
          manufacturer: "DeWalt",
          model: null,
        }),
        ctx.actor,
      );

      // Should NOT find product when manufacturers are both specific and different
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Jigsaw",
        "Bosch",
      );

      expect(found).toBeNull();
    });

    it("should prefer exact manufacturer match over (unspecified)", async () => {
      // Create two products: one with specific manufacturer, one with (unspecified)
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Screwdriver",
          manufacturer: "Stanley",
          model: null,
        }),
        ctx.actor,
      );

      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Screwdriver",
          manufacturer: "(unspecified)",
          model: null,
        }),
        ctx.actor,
      );

      // Should find exact match first
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Screwdriver",
        "Stanley",
      );

      expect(found).not.toBeNull();
      expect(found!.manufacturer).toEqual("Stanley");
    });

    it("should return null when product does not exist", async () => {
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Non-existent Product",
        "Any Manufacturer",
      );

      expect(found).toBeNull();
    });

    it("should be case insensitive for product name", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Power Drill PRO",
          manufacturer: "DeWalt",
          model: null,
        }),
        ctx.actor,
      );

      // Should find with different case
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "POWER DRILL PRO",
        "dewalt", // also lowercase
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Power Drill PRO");
    });
  });
});
