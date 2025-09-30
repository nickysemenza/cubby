import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import {
  createProduct,
  getProductByID,
  productList,
  updateProduct,
  findProductByName,
} from "./product";

describe("product repository", () => {
  let prisma: PrismaClient;
  let projectId: string;
  beforeEach(async () => {
    const { prisma: db, projectId: pId, teardown } = await buildTestDB();
    prisma = db;
    projectId = pId;

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
    };

    // Create the product
    const createdProduct = await createProduct(prisma, productData, projectId);

    // Verify the product was created correctly
    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.upc).toEqual(productData.upc);

    // Retrieve the product by ID
    const retrievedProduct = await getProductByID(
      prisma,
      createdProduct.id,
      projectId,
    );

    // Verify the retrieved product matches the created product
    expect(retrievedProduct.id).toEqual(createdProduct.id);
    expect(retrievedProduct.name).toEqual(productData.name);
    expect(retrievedProduct.manufacturer).toEqual(productData.manufacturer);
    expect(retrievedProduct.unitMappings).toEqual([]);
    expect(retrievedProduct.ingredient).toBeNull();
  });

  it("should find a product by name", async () => {
    // Create test products in a transaction to use findProductByName
    const productName = "Unique Product Name";

    await prisma.$transaction(async (tx) => {
      await tx.product.create({
        data: {
          project: { connect: { id: projectId } },
          name: productName,
          manufacturer: "Test Manufacturer",
          model: "MODEL-123",
          upc: "123456789012",
        },
      });

      // Test finding the product by name
      const foundProduct = await findProductByName(tx, productName);

      // Verify the product was found correctly
      expect(foundProduct).toBeDefined();
      expect(foundProduct.name).toEqual(productName);
    });
  });

  it("should throw error when finding a non-existent product by name", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await findProductByName(tx, "Non-existent Product");
      }),
    ).rejects.toThrow("Product Non-existent Product not found");
  });

  it("should throw error when finding an ambiguous product by name", async () => {
    const ambiguousName = "Ambiguous Product";

    // Create two products with the same name
    await prisma.product.createMany({
      data: [
        {
          projectId: projectId,
          name: ambiguousName,
          manufacturer: "Manufacturer 1",
          model: "MODEL-1",
          upc: "111111111111",
        },
        {
          projectId: projectId,
          name: ambiguousName,
          manufacturer: "Manufacturer 2",
          model: "MODEL-2",
          upc: "222222222222",
        },
      ],
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await findProductByName(tx, ambiguousName);
      }),
    ).rejects.toThrow(
      `findProductByName: Product ${ambiguousName} is ambiguous`,
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
        prisma,
        {
          ...product,
          ingredientId: null,
          expectedQuantity: null,
        },
        projectId,
      );
    }

    // Test listing with pagination - first page
    const firstPage = await productList(
      prisma,
      projectId,
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
      prisma,
      projectId,
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
      prisma,
      projectId,
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
    };

    // Create the product
    const createdProduct = await createProduct(prisma, productData, projectId);

    // Update the product
    const updatedProduct = await updateProduct(
      prisma,
      createdProduct.id,
      projectId,
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
    );

    // Verify the product was updated correctly
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged

    // Retrieve the product to verify unit mappings
    const retrievedProduct = await getProductByID(
      prisma,
      createdProduct.id,
      projectId,
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
    const ingredient = await prisma.ingredient.create({
      data: {
        project: { connect: { id: projectId } },
        name: "Test Ingredient",
        aliases: ["test", "ingredient"],
      },
    });

    // Create a product linked to the ingredient
    const productData = {
      name: "Test Product with Ingredient",
      manufacturer: "Test Manufacturer",
      model: "TEST-ING-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: ingredient.id,
    };

    // Create the product
    const createdProduct = await createProduct(prisma, productData, projectId);

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(
      prisma,
      createdProduct.id,
      projectId,
    );

    // Verify the ingredient association
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Test Ingredient");
  });

  it("should update ingredient association", async () => {
    // Create two ingredients
    const ingredient1 = await prisma.ingredient.create({
      data: {
        project: { connect: { id: projectId } },
        name: "Ingredient 1",
        aliases: ["ing1"],
      },
    });

    const ingredient2 = await prisma.ingredient.create({
      data: {
        project: { connect: { id: projectId } },
        name: "Ingredient 2",
        aliases: ["ing2"],
      },
    });

    // Create a product linked to the first ingredient
    const productData = {
      name: "Test Product with Ingredient",
      manufacturer: "Test Manufacturer",
      model: "TEST-ING-123",
      upc: "123456789012",
      ndb_number: null,
      expectedQuantity: null,
      ingredientId: ingredient1.id,
    };

    // Create the product
    const createdProduct = await createProduct(prisma, productData, projectId);

    // Update the product to link to the second ingredient
    await updateProduct(prisma, createdProduct.id, projectId, {
      ingredientId: ingredient2.id,
    });

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(
      prisma,
      createdProduct.id,
      projectId,
    );

    // Verify the ingredient association was updated
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient2.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Ingredient 2");

    // Update the product to remove ingredient association
    await updateProduct(prisma, createdProduct.id, projectId, {
      ingredientId: null,
    });

    // Retrieve the product again
    const updatedProduct = await getProductByID(
      prisma,
      createdProduct.id,
      projectId,
    );

    // Verify the ingredient association was removed
    expect(updatedProduct.ingredient).toBeNull();
  });
});
