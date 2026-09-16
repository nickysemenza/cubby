import { entityRefKey } from "@cubby/schemas/entity";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  gardenEntryImage,
  locationImage,
  productImage,
  vendor as vendorTable,
} from "~/server/db/schema";
import { createExpense } from "~/server/repo/expense/crud";
import { createUploadedImageRecord } from "~/server/repo/image";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createVendor } from "~/server/repo/vendor";
import { createWish, updateWish, wishList } from "~/server/repo/wish";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { setCookbookProduct, upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import {
  resolveEntityDisplayImages,
  withDisplayImages,
} from "./entity-display-image";
import {
  createIngredientFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeCookbookExtraction,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";

// One image per test row is enough to prove wiring; the ordering tests below
// use several. Every key is unique per call so the live `Image_key_key`
// index never collides across tests.
describe("entity display image resolver", () => {
  const ctx = withTestDb();

  const makeImage = (
    overrides: Partial<Parameters<typeof createUploadedImageRecord>[1]> = {},
  ) =>
    createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "photo.jpg",
      contentType: "image/jpeg",
      size: 100,
      ...overrides,
    });

  describe("product", () => {
    it("orders displayImages by sortOrder and excludes PDF, missing, and soft-deleted links", async () => {
      const p = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Ordered Product" }),
        ctx.actor,
      );
      const imgA = await makeImage(); // sortOrder 2
      const imgB = await makeImage(); // sortOrder 0
      const imgC = await makeImage(); // sortOrder 1
      const imgPdf = await makeImage({ contentType: "application/pdf" });
      const imgMissing = await makeImage({ storageStatus: "missing" });
      const imgSoftDeleted = await makeImage();

      const db = getDb(ctx.db);
      await db.insert(productImage).values([
        { productId: p.entityId, imageId: imgA.id, sortOrder: 2 },
        { productId: p.entityId, imageId: imgB.id, sortOrder: 0 },
        { productId: p.entityId, imageId: imgC.id, sortOrder: 1 },
        { productId: p.entityId, imageId: imgPdf.id, sortOrder: 3 },
        { productId: p.entityId, imageId: imgMissing.id, sortOrder: 4 },
      ]);
      const [softDeletedLink] = await db
        .insert(productImage)
        .values({
          productId: p.entityId,
          imageId: imgSoftDeleted.id,
          sortOrder: 5,
        })
        .returning({ id: productImage.id });
      await db
        .update(productImage)
        .set({ deletedAt: new Date() })
        .where(eq(productImage.id, softDeletedLink!.id));

      const rows = await withDisplayImages(
        ctx.db,
        "product",
        [{ id: p.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: imgB.shortcode, url: getR2PublicUrl(imgB.key) },
        { id: imgC.shortcode, url: getR2PublicUrl(imgC.key) },
        { id: imgA.shortcode, url: getR2PublicUrl(imgA.key) },
      ]);
    });

    it("returns an empty list for a product with no images", async () => {
      const p = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Bare Product" }),
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "product",
        [{ id: p.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([]);
    });
  });

  describe("location", () => {
    it("prefers its own gallery, falling back to the identity product's images", async () => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Shelf SKU" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: product.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Bin A", productId: product.id }),
        ctx.actor,
      );
      const locationImg = await makeImage();
      await getDb(ctx.db).insert(locationImage).values({
        locationId: location.entityId,
        imageId: locationImg.id,
        sortOrder: 0,
      });

      const rows = await withDisplayImages(
        ctx.db,
        "location",
        [{ id: location.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: locationImg.shortcode, url: getR2PublicUrl(locationImg.key) },
        { id: productImg.shortcode, url: getR2PublicUrl(productImg.key) },
      ]);
    });
  });

  describe("vendor", () => {
    it("uses its direct displayable logo", async () => {
      const logo = await makeImage();
      const created = await createVendor(
        ctx.db,
        {
          name: `Logo Vendor ${crypto.randomUUID()}`,
          website: null,
          orderUrlTemplate: null,
          notes: null,
        },
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(vendorTable)
        .set({ logoImageId: logo.id })
        .where(eq(vendorTable.id, created.entityId));

      const rows = await withDisplayImages(
        ctx.db,
        "vendor",
        [{ id: created.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: logo.shortcode, url: getR2PublicUrl(logo.key) },
      ]);
    });
  });

  describe("cookbook", () => {
    it("prefers its own cover", async () => {
      const cover = await makeImage();
      const cb = await upsertCookbook(
        ctx.db,
        {
          name: "Covered Book",
          rawJson: makeCookbookExtraction(),
          sourceLabel: "covered.epub",
          coverImageId: cover.id,
        },
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "cookbook",
        [{ id: cb.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: cover.shortcode, url: getR2PublicUrl(cover.key) },
      ]);
    });

    it("falls back to the linked product's photo when it has no cover", async () => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Shelf Copy" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: product.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const cb = await upsertCookbook(
        ctx.db,
        {
          name: "Coverless Book",
          rawJson: makeCookbookExtraction(),
          sourceLabel: "coverless.epub",
        },
        ctx.actor,
      );
      await setCookbookProduct(
        ctx.db,
        ctx.actor,
        cb.entityId,
        product.entityId,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "cookbook",
        [{ id: cb.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: productImg.shortcode, url: getR2PublicUrl(productImg.key) },
      ]);
    });
  });

  describe("ingredient (borrowed)", () => {
    it("orders linked products' images by product creation time, older first", async () => {
      const ingredient = await createIngredientFixture(
        ctx.db,
        { name: "Borrowed Ingredient" },
        ctx.actor,
      );

      const older = await createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Older Product",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const olderImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: older.entityId,
        imageId: olderImg.id,
        sortOrder: 0,
      });

      const newer = await createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Newer Product",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const newerImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: newer.entityId,
        imageId: newerImg.id,
        sortOrder: 0,
      });

      const rows = await withDisplayImages(
        ctx.db,
        "ingredient",
        [{ id: ingredient.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: olderImg.shortcode, url: getR2PublicUrl(olderImg.key) },
        { id: newerImg.shortcode, url: getR2PublicUrl(newerImg.key) },
      ]);
    });
  });

  describe("wish (borrowed)", () => {
    it("orders candidates' product images in candidate link order", async () => {
      const pA = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Candidate A", category: "tools" }),
        ctx.actor,
      );
      const imgA = await makeImage();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId: pA.entityId, imageId: imgA.id, sortOrder: 0 });

      const pB = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Candidate B", category: "tools" }),
        ctx.actor,
      );
      const imgB = await makeImage();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId: pB.entityId, imageId: imgB.id, sortOrder: 0 });

      const wish = await createWish(
        ctx.db,
        { name: "Wishlist item", notes: null, candidateProductIds: [pA.id] },
        ctx.actor,
      );
      await updateWish(
        ctx.db,
        wish.output.id,
        { candidateProductIds: [pA.id, pB.id] },
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "wish",
        [{ id: wish.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: imgA.shortcode, url: getR2PublicUrl(imgA.key) },
        { id: imgB.shortcode, url: getR2PublicUrl(imgB.key) },
      ]);

      // Regression: `wishList` handed hydrated rows (shortcode `id`) to the
      // uuid-keyed resolver, so /wishes failed with "invalid input syntax for
      // type uuid" whenever any wish existed.
      const listed = await wishList(ctx.db, {}, [], {
        pageIndex: 0,
        pageSize: 10,
      });
      expect(
        listed.data.find((row) => row.id === wish.output.id)?.displayImages,
      ).toEqual([
        { id: imgA.shortcode, url: getR2PublicUrl(imgA.key) },
        { id: imgB.shortcode, url: getR2PublicUrl(imgB.key) },
      ]);
    });
  });

  describe("inventory and expense (borrowed)", () => {
    it("an inventory entry shows its product's images", async () => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Inventoried Product" }),
        ctx.actor,
      );
      const img = await makeImage();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId: product.entityId, imageId: img.id, sortOrder: 0 });
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Inventory Bin" }),
        ctx.actor,
      );
      const entry = await createInventoryFixture(
        ctx.db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "inventory",
        [{ id: entry.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: img.shortcode, url: getR2PublicUrl(img.key) },
      ]);
    });

    it("an expense shows its product's images", async () => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Expensed Product" }),
        ctx.actor,
      );
      const img = await makeImage();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId: product.entityId, imageId: img.id, sortOrder: 0 });
      const expense = await createExpense(
        ctx.db,
        makeExpenseInput({ productId: product.id }),
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "expense",
        [{ id: expense.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: img.shortcode, url: getR2PublicUrl(img.key) },
      ]);
    });
  });

  describe("gardenEntry", () => {
    it("shows its gallery in sortOrder", async () => {
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Garden Bed" }),
        ctx.actor,
      );
      const entry = await insertWithShortcode(ctx.db, "gardenEntry", {
        locationId: location.entityId,
        kind: "observation",
        observedOn: "2024-01-01",
      });
      const first = await makeImage(); // sortOrder 0
      const second = await makeImage(); // sortOrder 1
      await getDb(ctx.db)
        .insert(gardenEntryImage)
        .values([
          { gardenEntryId: entry.id, imageId: second.id, sortOrder: 1 },
          { gardenEntryId: entry.id, imageId: first.id, sortOrder: 0 },
        ]);

      const rows = await withDisplayImages(
        ctx.db,
        "gardenEntry",
        [{ id: entry.id }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: first.shortcode, url: getR2PublicUrl(first.key) },
        { id: second.shortcode, url: getR2PublicUrl(second.key) },
      ]);
    });
  });

  describe("resolveEntityDisplayImages", () => {
    it("returns only the cover and omits refs with no image", async () => {
      const withImage = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Covered" }),
        ctx.actor,
      );
      const cover = await makeImage();
      const second = await makeImage();
      await getDb(ctx.db)
        .insert(productImage)
        .values([
          { productId: withImage.entityId, imageId: cover.id, sortOrder: 0 },
          { productId: withImage.entityId, imageId: second.id, sortOrder: 1 },
        ]);
      const withoutImage = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Coverless" }),
        ctx.actor,
      );

      const result = await resolveEntityDisplayImages(ctx.db, [
        { entityType: "product", entityId: withImage.entityId },
        { entityType: "product", entityId: withoutImage.entityId },
      ]);

      expect(result.get(entityRefKey("product", withImage.entityId))).toEqual({
        url: getR2PublicUrl(cover.key),
      });
      expect(result.has(entityRefKey("product", withoutImage.entityId))).toBe(
        false,
      );
    });

    it("silently omits an unsupported entity type", async () => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Real Entity" }),
        ctx.actor,
      );
      const img = await makeImage();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId: product.entityId, imageId: img.id, sortOrder: 0 });
      const financialAccountId = crypto.randomUUID();

      const result = await resolveEntityDisplayImages(ctx.db, [
        { entityType: "product", entityId: product.entityId },
        { entityType: "financialAccount", entityId: financialAccountId },
      ]);

      expect(result.get(entityRefKey("product", product.entityId))).toEqual({
        url: getR2PublicUrl(img.key),
      });
      expect(
        result.has(entityRefKey("financialAccount", financialAccountId)),
      ).toBe(false);
    });

    it("resolves a mixed batch of several entity types independently", async () => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Product" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: product.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Mixed Location" }),
        ctx.actor,
      );
      const locationImg = await makeImage();
      await getDb(ctx.db).insert(locationImage).values({
        locationId: location.entityId,
        imageId: locationImg.id,
        sortOrder: 0,
      });

      const cover = await makeImage();
      const cookbook = await upsertCookbook(
        ctx.db,
        {
          name: "Mixed Book",
          rawJson: makeCookbookExtraction(),
          sourceLabel: "mixed.epub",
          coverImageId: cover.id,
        },
        ctx.actor,
      );

      const ingredient = await createIngredientFixture(
        ctx.db,
        { name: "Mixed Ingredient" },
        ctx.actor,
      );
      const ingredientProduct = await createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Mixed Ingredient Product",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const ingredientImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: ingredientProduct.entityId,
        imageId: ingredientImg.id,
        sortOrder: 0,
      });

      const wishProduct = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Wish Product", category: "tools" }),
        ctx.actor,
      );
      const wishImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: wishProduct.entityId,
        imageId: wishImg.id,
        sortOrder: 0,
      });
      const wish = await createWish(
        ctx.db,
        {
          name: "Mixed Wish",
          notes: null,
          candidateProductIds: [wishProduct.id],
        },
        ctx.actor,
      );

      const invProduct = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Inventory Product" }),
        ctx.actor,
      );
      const invImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: invProduct.entityId,
        imageId: invImg.id,
        sortOrder: 0,
      });
      const invLocation = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Mixed Inventory Bin" }),
        ctx.actor,
      );
      const inventoryEntry = await createInventoryFixture(
        ctx.db,
        {
          productId: invProduct.id,
          locationId: invLocation.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      const expProduct = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Expense Product" }),
        ctx.actor,
      );
      const expImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: expProduct.entityId,
        imageId: expImg.id,
        sortOrder: 0,
      });
      const expense = await createExpense(
        ctx.db,
        makeExpenseInput({ productId: expProduct.id }),
        ctx.actor,
      );

      const gardenLocation = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Mixed Garden Bed" }),
        ctx.actor,
      );
      const gardenEntryRow = await insertWithShortcode(ctx.db, "gardenEntry", {
        locationId: gardenLocation.entityId,
        kind: "observation",
        observedOn: "2024-01-01",
      });
      const gardenImg = await makeImage();
      await getDb(ctx.db).insert(gardenEntryImage).values({
        gardenEntryId: gardenEntryRow.id,
        imageId: gardenImg.id,
        sortOrder: 0,
      });

      const result = await resolveEntityDisplayImages(ctx.db, [
        { entityType: "product", entityId: product.entityId },
        { entityType: "location", entityId: location.entityId },
        { entityType: "cookbook", entityId: cookbook.entityId },
        { entityType: "ingredient", entityId: ingredient.entityId },
        { entityType: "wish", entityId: wish.entityId },
        { entityType: "inventory", entityId: inventoryEntry.entityId },
        { entityType: "expense", entityId: expense.entityId },
        { entityType: "gardenEntry", entityId: gardenEntryRow.id },
      ]);

      expect(result.get(entityRefKey("product", product.entityId))).toEqual({
        url: getR2PublicUrl(productImg.key),
      });
      expect(result.get(entityRefKey("location", location.entityId))).toEqual({
        url: getR2PublicUrl(locationImg.key),
      });
      expect(result.get(entityRefKey("cookbook", cookbook.entityId))).toEqual({
        url: getR2PublicUrl(cover.key),
      });
      expect(
        result.get(entityRefKey("ingredient", ingredient.entityId)),
      ).toEqual({
        url: getR2PublicUrl(ingredientImg.key),
      });
      expect(result.get(entityRefKey("wish", wish.entityId))).toEqual({
        url: getR2PublicUrl(wishImg.key),
      });
      expect(
        result.get(entityRefKey("inventory", inventoryEntry.entityId)),
      ).toEqual({ url: getR2PublicUrl(invImg.key) });
      expect(result.get(entityRefKey("expense", expense.entityId))).toEqual({
        url: getR2PublicUrl(expImg.key),
      });
      expect(
        result.get(entityRefKey("gardenEntry", gardenEntryRow.id)),
      ).toEqual({ url: getR2PublicUrl(gardenImg.key) });
    });
  });
});
