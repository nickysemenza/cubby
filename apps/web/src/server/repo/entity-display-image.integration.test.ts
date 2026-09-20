import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  gardenEntryImage,
  image,
  locationImage,
  productImage,
  projectImage,
  purchaseImage,
  vendor as vendorTable,
} from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createExpense } from "~/server/repo/expense/crud";
import { createGardenEntry, createPlanting } from "~/server/repo/garden";
import { createUploadedImageRecord } from "~/server/repo/image";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createVendor } from "~/server/repo/vendor";
import { createWish, updateWish, wishList } from "~/server/repo/wish";
import { createTestRequestContext } from "~/server/testing/request-context";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { setCookbookProduct, upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import {
  resolveEntityDisplayImages,
  resolveEntityAttachments,
  withDisplayImages,
  withUniversalEntityMedia,
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
          orderEvidence: null,
          orderEmailSenders: [],
          browserDomains: [],
          returnWindowDays: null,
          agentHints: {
            ordersListUrl: null,
            pagination: null,
            orderLinkPattern: null,
            notes: [],
          },
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
      expect(
        (
          await resolveEntityAttachments(ctx.db, "vendor", [created.entityId])
        ).get(created.entityId),
      ).toMatchObject([{ id: logo.shortcode, role: "logo", position: 0 }]);
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
      expect(
        (await resolveEntityAttachments(ctx.db, "cookbook", [cb.entityId])).get(
          cb.entityId,
        ),
      ).toMatchObject([{ id: cover.shortcode, role: "cover", position: 0 }]);
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
      const [detail] = await withUniversalEntityMedia(
        ctx.db,
        "ingredient",
        [{ id: ingredient.id }],
        true,
      );
      expect(detail?.attachments).toEqual([]);
    });
  });

  describe("direct attachments", () => {
    it("preserves file/status metadata and deterministic order while excluding tombstones", async () => {
      const owner = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Attachment policy product" }),
        ctx.actor,
      );
      const associationTime = new Date("2026-09-16T12:00:00.000Z");
      const records = await Promise.all([
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-000000000001",
          key: `images/${crypto.randomUUID()}.heic`,
          filename: "pending.heic",
          contentType: "image/heic",
          size: 101,
          status: "PENDING",
        }),
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-000000000002",
          key: `images/${crypto.randomUUID()}.bin`,
          filename: "legacy.bin",
          contentType: "application/octet-stream",
          size: 102,
          status: "UPLOADED",
          renderStatus: "failed",
          storageStatus: "missing",
        }),
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-000000000003",
          key: `images/${crypto.randomUUID()}.pdf`,
          filename: "receipt.pdf",
          contentType: "application/pdf",
          size: 103,
          status: "UPLOADED",
          renderStatus: "verified",
          storageStatus: "metadata_mismatch",
        }),
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-000000000004",
          key: `images/${crypto.randomUUID()}.jpg`,
          filename: "verified.jpg",
          contentType: "image/jpeg",
          size: 104,
          status: "UPLOADED",
          width: 640,
          height: 480,
          detectedContentType: "image/jpeg",
          sha256: "a".repeat(64),
          renderStatus: "unverified",
          storageStatus: "available",
          verifiedAt: associationTime,
        }),
      ]);
      const deletedImage = await makeImage();
      const deletedAssociationImage = await makeImage();
      await getDb(ctx.db)
        .update(image)
        .set({ deletedAt: associationTime })
        .where(eq(image.id, deletedImage.id));
      await getDb(ctx.db)
        .insert(productImage)
        .values([
          ...records.map((record, index) => ({
            productId: owner.entityId,
            imageId: record.id,
            sortOrder: index === 0 ? 0 : index < 3 ? 1 : 2,
            createdAt: associationTime,
          })),
          {
            productId: owner.entityId,
            imageId: deletedImage.id,
            sortOrder: 3,
          },
          {
            productId: owner.entityId,
            imageId: deletedAssociationImage.id,
            sortOrder: 4,
            deletedAt: associationTime,
          },
        ]);

      const attachments = (
        await resolveEntityAttachments(ctx.db, "product", [owner.entityId])
      ).get(owner.entityId);
      expect(
        attachments?.map(({ id, position }) => ({ id, position })),
      ).toEqual(
        records.map((record, position) => ({ id: record.shortcode, position })),
      );
      expect(attachments).toMatchObject([
        {
          contentType: "image/heic",
          status: "PENDING",
          width: null,
          renderStatus: null,
          storageStatus: null,
        },
        {
          contentType: "application/octet-stream",
          renderStatus: "failed",
          storageStatus: "missing",
        },
        {
          contentType: "application/pdf",
          renderStatus: "verified",
          storageStatus: "metadata_mismatch",
        },
        {
          contentType: "image/jpeg",
          width: 640,
          height: 480,
          detectedContentType: "image/jpeg",
          sha256: "a".repeat(64),
          storageStatus: "available",
        },
      ]);
    });

    it("kernel get hydrates purchase and project from their real repository shapes", async () => {
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: `Attachment vendor ${crypto.randomUUID()}`,
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-16",
      });
      const project = await insertWithShortcode(ctx.db, "project", {
        name: `Attachment project ${crypto.randomUUID()}`,
      });
      const purchasePhoto = await makeImage({
        filename: "purchase.heic",
        contentType: "image/heic",
      });
      const projectPhoto = await makeImage();
      await getDb(ctx.db).insert(purchaseImage).values({
        purchaseId: purchase.id,
        imageId: purchasePhoto.id,
      });
      await getDb(ctx.db).insert(projectImage).values({
        projectId: project.id,
        imageId: projectPhoto.id,
      });
      const context = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      );

      const purchaseRead = await executeEntity(context, {
        action: "get",
        entity: "purchase",
        id: purchase.shortcode,
        missing: "error",
      });
      const projectRead = await executeEntity(context, {
        action: "get",
        entity: "project",
        id: project.shortcode,
        missing: "error",
      });
      if (purchaseRead.action !== "get" || projectRead.action !== "get")
        throw new Error("expected get results");
      if (!purchaseRead.item || !projectRead.item)
        throw new Error("expected live items");
      expect(purchaseRead.item.attachments).toMatchObject([
        { id: purchasePhoto.shortcode, contentType: "image/heic" },
      ]);
      expect(projectRead.item.attachments).toMatchObject([
        { id: projectPhoto.shortcode },
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
        kind: "note",
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

  describe("planting", () => {
    // `createPlanting` returns the public shortcode as `id`; `withDisplayImages`
    // needs the private uuid, resolved the same way `garden.integration.test.ts`
    // does for repo-level assertions.
    const plantingEntityId = async (shortcode: string) =>
      parseEntityId(
        "planting",
        (await resolveLiveShortcode(ctx.db, shortcode, "planting"))!,
      );

    // Planting carries no gallery of its own (decision: journal entries are
    // the only photo surface) — its cover borrows the latest journal entry's
    // first photo, falling back to the seed/source product's.
    it("prefers the newest journal entry's first photo over an older entry's and over the seed product", async () => {
      const seedPacket = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Planting fallback seed packet" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: seedPacket.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const crop = await createIngredientFixture(
        ctx.db,
        { name: "Planting fallback crop" },
        ctx.actor,
      );
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Planting fallback bed", type: "bed" }),
        ctx.actor,
      );
      const planted = await createPlanting(
        ctx.db,
        {
          ingredientId: crop.id,
          locationId: location.id,
          sourceProductId: seedPacket.id,
          status: "growing",
        },
        ctx.actor,
      );

      const olderImg = await makeImage();
      await createGardenEntry(
        ctx.db,
        {
          locationId: location.id,
          plantingIds: [planted.id],
          kind: "note",
          observedOn: "2026-01-01",
          pendingImageIds: [olderImg.shortcode],
        },
        ctx.actor,
      );
      const newerImg = await makeImage();
      await createGardenEntry(
        ctx.db,
        {
          locationId: location.id,
          plantingIds: [planted.id],
          kind: "note",
          observedOn: "2026-02-01",
          pendingImageIds: [newerImg.shortcode],
        },
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "planting",
        [{ id: await plantingEntityId(planted.id) }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: newerImg.shortcode, url: getR2PublicUrl(newerImg.key) },
        { id: olderImg.shortcode, url: getR2PublicUrl(olderImg.key) },
        { id: productImg.shortcode, url: getR2PublicUrl(productImg.key) },
      ]);
    });

    it("falls back to the seed product's photo when there are no journal entries", async () => {
      const seedPacket = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "No-entry seed packet" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await getDb(ctx.db).insert(productImage).values({
        productId: seedPacket.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const crop = await createIngredientFixture(
        ctx.db,
        { name: "No-entry crop" },
        ctx.actor,
      );
      const planted = await createPlanting(
        ctx.db,
        {
          ingredientId: crop.id,
          sourceProductId: seedPacket.id,
          status: "planned",
        },
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "planting",
        [{ id: await plantingEntityId(planted.id) }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        { id: productImg.shortcode, url: getR2PublicUrl(productImg.key) },
      ]);
    });

    it("is empty with neither journal entries nor a seed product", async () => {
      const crop = await createIngredientFixture(
        ctx.db,
        { name: "Empty fallback crop" },
        ctx.actor,
      );
      const planted = await createPlanting(
        ctx.db,
        { ingredientId: crop.id, status: "planned" },
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "planting",
        [{ id: await plantingEntityId(planted.id) }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([]);
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
        kind: "note",
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
