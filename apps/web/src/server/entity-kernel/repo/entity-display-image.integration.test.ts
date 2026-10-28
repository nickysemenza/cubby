import { entityRefKey } from "@cubby/schemas/entity";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { rawLocationList } from "@cubby/schemas/location-raw-read";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { getDb, mapImages } from "~/server/db/helpers";
import {
  entityAttachment,
  financialTransaction,
  sourceTransactionRecord,
  image,
  imageDerivative,
  product,
  vendor,
} from "~/server/db/schema";
import {
  setCookbookProduct,
  upsertCookbook,
} from "~/server/domains/cookbook/repo/cookbook";
import { createDevice } from "~/server/domains/device/repo/device";
import { createExpense } from "~/server/domains/expense/repo/crud";
import {
  createGardenEntry,
  createPlanting,
} from "~/server/domains/garden/repo/garden";
import {
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  loadImageRepresentations,
} from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { hydrateImageReadProjection } from "~/server/domains/image/repo/image-read-projection";
import {
  getInventoryByLocationIds,
  readInventory,
} from "~/server/domains/inventory/repo/crud";
import {
  getLocationCoverImageUrlsByLocationIds,
  locationSearch,
} from "~/server/domains/location/repo/crud";
import { buildLocationTree } from "~/server/domains/location/repo/tree";
import { createFinancialEvidenceFixture } from "~/server/domains/transaction-import/repo/source-transaction-record.fixtures";
import { createVendor } from "~/server/domains/vendor/repo/vendor";
import {
  createWish,
  updateWish,
  wishScaffold,
} from "~/server/domains/wish/repo";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  listReadPlan,
  selectedListProjection,
} from "~/server/generic/list/repo/list-projection";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createIngredientFixture,
  createInventoryFixture,
  createLocationFixture,
  createPlantFixture,
  createProductIdentityFixture,
  makeCookbookExtraction,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  entityDisplayImagePresenceSql,
  loadDisplayImageSources,
  resolveEntityDisplayImageChain,
  resolvePublicEntityDisplayImages,
  resolveEntityDisplayImages,
  resolveEntityAttachments,
  withDisplayImages,
  withListEntityMedia,
  withUniversalEntityMedia,
} from "./entity-display-image";

// One image per test row is enough to prove wiring; the ordering tests below
// use several. Every key is unique per call so the live `Image_key_key`
// index never collides across tests.
describe("entity display image resolver", () => {
  const ctx = withTestDb();

  it("borrows a source record logo only through live accepted evidence", async () => {
    const { record } = await createFinancialEvidenceFixture(ctx.db);
    const ref = {
      entityKind: "sourceTransactionRecord",
      entityId: record.shortcode,
    } as const;
    const key = entityRefKey(ref.entityKind, ref.entityId);
    expect(
      (await resolvePublicEntityDisplayImages(ctx.db, [ref])).get(key),
    ).toBeUndefined();
    const logo = await makeImage();
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic linked seller",
    });
    await insertEntityAttachments(ctx.db, {
      entityId: seller.entityId,
      role: "logo",
      imageId: logo.id,
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.output.id,
      date: "2026-01-01",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic linked account",
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 1,
      postedDate: "2026-01-01",
      sourceRefs: [{ source: record.source, externalId: record.externalId }],
      allocations: [{ purchaseId: purchase.output.id, amount: 1 }],
    });
    expect(
      (await resolvePublicEntityDisplayImages(ctx.db, [ref])).get(key),
    ).toEqual({
      url: getR2PublicUrl(logo.key),
      representations: expectedRepresentations(logo.key),
    });
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, transaction.entityId));
    expect(
      (await resolvePublicEntityDisplayImages(ctx.db, [ref])).get(key),
    ).toBeUndefined();
  });

  it("uses a supported unique merchant logo after confirmed images and rejects ambiguity", async () => {
    const { record } = await createFinancialEvidenceFixture(ctx.db);
    const merchant = `Synthetic merchant ${crypto.randomUUID()}`;
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ merchant })
      .where(eq(sourceTransactionRecord.id, record.id));
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic inferred seller",
    });
    const logo = await makeImage();
    await insertEntityAttachments(ctx.db, {
      entityId: seller.entityId,
      role: "logo",
      imageId: logo.id,
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: seller.output.id,
      date: "2026-01-01",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic merchant history",
    });
    const addHistory = (purchaseId: typeof purchase.output.id) =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        amount: 1,
        postedDate: "2026-01-01",
        merchant,
        allocations: [{ purchaseId, amount: 1 }],
      });
    const ref = {
      entityKind: "sourceTransactionRecord",
      entityId: record.shortcode,
    } as const;
    const key = entityRefKey(ref.entityKind, ref.entityId);
    await addHistory(purchase.output.id);
    expect(
      (await resolvePublicEntityDisplayImages(ctx.db, [ref])).get(key)?.url,
    ).toBe(getR2PublicUrl(logo.key));
    await addHistory(purchase.output.id);
    const presence = await getDb(ctx.db).execute(
      sql`SELECT ${entityDisplayImagePresenceSql("sourceTransactionRecord", sql`${record.id}::uuid`)} AS present`,
    );
    expect(presence.rows).toEqual([{ present: true }]);
    const otherSeller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic competing seller",
    });
    const otherLogo = await makeImage();
    await insertEntityAttachments(ctx.db, {
      entityId: otherSeller.entityId,
      role: "logo",
      imageId: otherLogo.id,
    });
    const otherPurchase = await createRepoEntity(ctx, "purchase", {
      vendorId: otherSeller.output.id,
      date: "2026-01-01",
    });
    const confirmed = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 1,
      postedDate: "2026-01-01",
      sourceRefs: [{ source: record.source, externalId: record.externalId }],
      allocations: [{ purchaseId: otherPurchase.output.id, amount: 1 }],
    });
    expect(
      (await resolvePublicEntityDisplayImages(ctx.db, [ref])).get(key)?.url,
    ).toBe(getR2PublicUrl(otherLogo.key));
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, confirmed.entityId));
    await addHistory(otherPurchase.output.id);
    expect(
      (await resolvePublicEntityDisplayImages(ctx.db, [ref])).get(key),
    ).toBeUndefined();
  });

  it("keeps images already resolved by a repository list", async () => {
    const record = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic list item" }),
      ctx.actor,
    );
    const photo = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "unlinked.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    const rows = [
      {
        id: record.id,
        displayImages: [
          { id: photo.shortcode, url: getR2PublicUrl(photo.key) },
        ],
      },
    ];

    const hydrated = await withListEntityMedia(ctx.db, "product", rows);
    expect(hydrated[0]?.displayImages).toBe(rows[0]?.displayImages);
    expect(hydrated).toEqual(rows);
  });

  const expectedRepresentations = (key: string) => {
    const original = getR2PublicUrl(key);
    return {
      original,
      transparent: null,
      preferred: original,
      preferredKind: "original" as const,
    };
  };

  const expectedDisplayImage = (record: {
    shortcode: string;
    key: string;
  }) => ({
    id: record.shortcode,
    url: getR2PublicUrl(record.key),
    representations: expectedRepresentations(record.key),
  });

  const expectedImageUrl = (record: { key: string }) => ({
    url: getR2PublicUrl(record.key),
    representations: expectedRepresentations(record.key),
  });

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

  it("replaces stale display representations for duplicate nested references", async () => {
    const owner = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic representation reuse" }),
      ctx.actor,
    );
    const photo = await makeImage();
    await insertEntityAttachments(ctx.db, {
      entityId: owner.entityId,
      imageId: photo.id,
      sortOrder: 0,
    });
    const stale = {
      id: photo.shortcode,
      url: getR2PublicUrl(photo.key),
      representations: expectedRepresentations("images/stale.jpg"),
    };
    const rows = await withDisplayImages(
      ctx.db,
      "product",
      [{ id: owner.entityId }],
      (row) => ({
        id: row.id,
        nested: [stale, { photo: stale }],
      }),
    );

    expect(rows).toEqual([
      {
        id: owner.entityId,
        nested: [
          expectedDisplayImage(photo),
          { photo: expectedDisplayImage(photo) },
        ],
        displayImages: [expectedDisplayImage(photo)],
      },
    ]);
  });

  it("prefetches non-displayable attachments without trusting their supplied representations", async () => {
    const owner = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic attachment shelf" }),
      ctx.actor,
    );
    const file = await makeImage({ contentType: "application/pdf" });
    await insertEntityAttachments(ctx.db, {
      entityId: owner.entityId,
      imageId: file.id,
      sortOrder: 0,
    });
    const row = {
      id: owner.entityId,
      shortcode: owner.id,
      images: mapImages([file]).map((image) => ({
        ...image,
        representations: expectedRepresentations("images/stale.jpg"),
      })),
    };
    const plan = listReadPlan<typeof row>("location", {
      media: true,
      bindings: (bind) => [
        bind(rawLocationList.pick({ images: true }), (row) => ({
          images: row.images,
        })),
      ],
    });
    const projection = selectedListProjection("location", [
      "images",
      "displayImages",
    ]);
    const early = plan.prefetch(ctx.db, [owner.entityId], projection);
    await Promise.all(Object.values(early));
    expect(
      await plan.read(ctx.db, [row], projection, undefined, undefined, early),
    ).toMatchObject([
      {
        images: [
          {
            id: file.shortcode,
            representations: expectedRepresentations(file.key),
          },
        ],
        displayImages: [],
      },
    ]);
    expect(row.images[0]?.representations).toEqual(
      expectedRepresentations("images/stale.jpg"),
    );
  });

  it("hydrates missing nested image codes while preserving trusted preloads and tombstones", async () => {
    const preloadedPhoto = await makeImage();
    const missingPhoto = await makeImage();
    const deletedPhoto = await makeImage();
    await getDb(ctx.db)
      .update(image)
      .set({ deletedAt: new Date() })
      .where(eq(image.id, deletedPhoto.id));
    const preloaded = await loadImageRepresentations(ctx.db, [
      preloadedPhoto.shortcode,
    ]);
    const rawPhoto = {
      id: missingPhoto.shortcode,
      url: getR2PublicUrl(missingPhoto.key),
      representations: expectedRepresentations("images/stale.jpg"),
    };
    const rawDeleted = {
      id: deletedPhoto.shortcode,
      url: getR2PublicUrl(deletedPhoto.key),
    };
    const observedAt = new Date("2026-01-01T00:00:00Z");
    const complete = [expectedDisplayImage(preloadedPhoto)];
    expect(
      await hydrateImageReadProjection(ctx.db, complete, preloaded),
    ).toEqual(complete);

    const hydrated = await hydrateImageReadProjection(
      ctx.db,
      {
        images: complete,
        nested: [rawPhoto, { photo: rawPhoto }, rawDeleted],
        observedAt,
      },
      preloaded,
    );
    expect(hydrated).toEqual({
      images: complete,
      nested: [
        expectedDisplayImage(missingPhoto),
        { photo: expectedDisplayImage(missingPhoto) },
        rawDeleted,
      ],
      observedAt,
    });
    expect(hydrated.observedAt).toBe(observedAt);
    expect(preloaded.size).toBe(1);
    expect(rawPhoto.representations).toEqual(
      expectedRepresentations("images/stale.jpg"),
    );

    const empty: unknown[] = [];
    expect(await hydrateImageReadProjection(ctx.db, empty, preloaded)).toBe(
      empty,
    );
  });

  it("uses a linked product image for a device without image storage", async () => {
    const hardware = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic tablet" }),
      ctx.actor,
    );
    const photo = await makeImage();
    await insertEntityAttachments(ctx.db, {
      entityId: hardware.entityId,
      imageId: photo.id,
      sortOrder: 0,
    });
    const device = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Test device",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
        productId: hardware.id,
      },
      ctx.actor,
    );

    const rows = await withDisplayImages(
      ctx.db,
      "device",
      [{ id: device.entityId }],
      (row) => ({ id: row.id }),
    );
    expect(rows[0]?.displayImages).toEqual([expectedDisplayImage(photo)]);

    const chain = await resolveEntityDisplayImageChain(ctx.db, {
      entityKind: "device",
      entityId: device.entityId,
    });
    expect(chain).toEqual([
      {
        image: expectedDisplayImage(photo),
        priority: expect.any(Number),
        sourceId: hardware.entityId,
      },
    ]);
    expect(await loadDisplayImageSources(ctx.db, chain)).toEqual(
      new Map([
        [hardware.entityId, { entityKind: "product", entityId: hardware.id }],
      ]),
    );
  });

  describe("product", () => {
    it("uses a Brand logo through Products and their consumers, including quality presence", async () => {
      const brand = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic CAD brand",
      });
      const logo = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: brand.entityId,
        imageId: logo.id,
        role: "logo",
      });
      const item = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic CAD subscription",
          brandId: brand.output.id,
        }),
        ctx.actor,
      );
      const brandedBin = await createLocationFixture(
        ctx.db,
        makeLocationInput({
          name: "Synthetic branded bin",
          productId: item.id,
        }),
        ctx.actor,
      );
      expect(
        (
          await getLocationCoverImageUrlsByLocationIds(ctx.db, [
            brandedBin.entityId,
          ])
        ).get(brandedBin.entityId),
      ).toBe(getR2PublicUrl(logo.key));
      const picker = await locationSearch(
        ctx.db,
        { nameFilter: "Synthetic branded bin" },
        [],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(picker.data[0]?.coverImage?.id).toBe(logo.shortcode);
      const tree = await buildLocationTree(ctx.db);
      const locations = tree.flatMap((root) => [
        root,
        ...(root.children ?? []),
      ]);
      expect(
        locations.find((location) => location.id === brandedBin.id)
          ?.displayImages?.[0]?.id,
      ).toBe(logo.shortcode);
      const expense = await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({ productId: item.id }),
      );
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Synthetic image shelf" }),
        ctx.actor,
      );
      const entry = await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      const inventoryRead = await getInventoryByLocationIds(ctx.db, [
        location.entityId,
      ]);
      expect(
        inventoryRead.find((row) => row.id === entry.id)?.product
          .displayImages[0]?.id,
      ).toBe(logo.shortcode);
      const inventoryDetail = await readInventory(ctx.db, entry.id);
      expect(inventoryDetail?.product.displayImages[0]?.id).toBe(
        logo.shortcode,
      );
      const refs = [
        { entityKind: "product" as const, entityId: item.entityId },
        { entityKind: "expense" as const, entityId: expense.entityId },
        { entityKind: "inventory" as const, entityId: entry.entityId },
      ];
      const images = await resolveEntityDisplayImages(ctx.db, refs);
      expect(
        refs.map((ref) =>
          images.get(entityRefKey(ref.entityKind, ref.entityId)),
        ),
      ).toEqual(refs.map(() => expectedImageUrl(logo)));
      const publicImages = await resolvePublicEntityDisplayImages(ctx.db, [
        { entityKind: "product", entityId: item.id },
      ]);
      expect(publicImages.get(entityRefKey("product", item.id))).toEqual(
        expectedImageUrl(logo),
      );
      const qualities = await loadDataQualities(ctx.db, "product", [
        item.entityId,
      ]);
      expect(qualities.has(item.entityId)).toBe(true);
      expect(
        qualities.get(item.entityId)?.gaps.map((gap) => gap.check),
      ).not.toContain("product_display_image");
      await publishQualityFixtures(ctx.db, "product");
      const stored = await loadDataQualities(
        ctx.db,
        "product",
        [item.entityId],
        "stored",
      );
      expect(stored.has(item.entityId)).toBe(true);
      expect(
        stored.get(item.entityId)?.gaps.map((gap) => gap.check),
      ).not.toContain("product_display_image");
      const label = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: item.entityId,
        imageId: label.id,
        purpose: "label",
      });
      expect(
        (await resolveEntityDisplayImages(ctx.db, refs)).get(
          entityRefKey("product", item.entityId),
        ),
      ).toEqual(expectedImageUrl(logo));
      const ownImage = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: item.entityId,
        imageId: ownImage.id,
      });
      expect(
        (await resolveEntityDisplayImages(ctx.db, refs)).get(
          entityRefKey("product", item.entityId),
        ),
      ).toEqual(expectedImageUrl(ownImage));
      await getDb(ctx.db)
        .update(image)
        .set({ storageStatus: "missing" })
        .where(eq(image.id, ownImage.id));
      expect(
        (await resolveEntityDisplayImages(ctx.db, refs)).get(
          entityRefKey("product", item.entityId),
        ),
      ).toEqual(expectedImageUrl(logo));
      await getDb(ctx.db)
        .update(vendor)
        .set({ deletedAt: new Date() })
        .where(eq(vendor.id, brand.entityId));
      expect((await resolveEntityDisplayImages(ctx.db, refs)).size).toBe(0);
      const missingQualities = await loadDataQualities(ctx.db, "product", [
        item.entityId,
      ]);
      expect(
        missingQualities.get(item.entityId)?.gaps.map((gap) => gap.check),
      ).toContain("product_display_image");
    });

    it("uses an Expense Vendor logo without Product or Purchase images", async () => {
      const vendor = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic service seller",
      });
      const logo = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: vendor.entityId,
        imageId: logo.id,
        role: "logo",
      });
      const expense = await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({ vendor: vendor.output.name }),
      );
      const images = await resolveEntityDisplayImages(ctx.db, [
        { entityKind: "expense", entityId: expense.entityId },
      ]);
      expect(images.get(entityRefKey("expense", expense.entityId))).toEqual(
        expectedImageUrl(logo),
      );
    });

    it("orders displayImages by sortOrder and excludes PDF, missing, and soft-deleted links", async () => {
      const p = await createProductIdentityFixture(
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
      await insertEntityAttachments(db, [
        { entityId: p.entityId, imageId: imgA.id, sortOrder: 2 },
        { entityId: p.entityId, imageId: imgB.id, sortOrder: 0 },
        { entityId: p.entityId, imageId: imgC.id, sortOrder: 1 },
        { entityId: p.entityId, imageId: imgPdf.id, sortOrder: 3 },
        { entityId: p.entityId, imageId: imgMissing.id, sortOrder: 4 },
      ]);
      const [softDeletedLink] = await insertEntityAttachments(db, {
        entityId: p.entityId,
        imageId: imgSoftDeleted.id,
        sortOrder: 5,
      });
      await db
        .update(entityAttachment)
        .set({ deletedAt: new Date() })
        .where(eq(entityAttachment.id, softDeletedLink!.id));

      const rows = await withDisplayImages(
        ctx.db,
        "product",
        [{ id: p.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        expectedDisplayImage(imgB),
        expectedDisplayImage(imgC),
        expectedDisplayImage(imgA),
      ]);
    });

    it("returns an empty list for a product with no images", async () => {
      const p = await createProductIdentityFixture(
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

    it("hides label attachments from direct and borrowed covers while keeping items", async () => {
      const labelledProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Labelled product" }),
        ctx.actor,
      );
      const label = await makeImage();
      const item = await makeImage();
      await insertEntityAttachments(ctx.db, [
        {
          entityId: labelledProduct.entityId,
          imageId: label.id,
          sortOrder: 0,
          purpose: "label",
        },
        {
          entityId: labelledProduct.entityId,
          imageId: item.id,
          sortOrder: 1,
        },
      ]);
      const direct = await withDisplayImages(
        ctx.db,
        "product",
        [{ id: labelledProduct.entityId }],
        (row) => ({ id: row.id }),
      );
      expect(direct[0]?.displayImages).toEqual([expectedDisplayImage(item)]);

      const context = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      );
      const detail = await executeEntity(context, {
        action: "get",
        entity: "product",
        id: labelledProduct.id,
        missing: "error",
      });
      if (detail.action !== "get" || !detail.item)
        throw new Error("Expected Product detail");
      expect(fieldValueOf(detail.item.fields.images)).toMatchObject([
        { id: item.shortcode, purpose: "item" },
      ]);
      expect(detail.item.labelImages).toMatchObject([
        { id: label.shortcode, purpose: "label" },
      ]);
      expect(detail.item.attachments).toHaveLength(2);

      const ingredient = await createIngredientFixture(
        ctx.db,
        { name: "Labelled borrowed ingredient" },
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ ingredientId: ingredient.entityId })
        .where(eq(product.id, labelledProduct.entityId));
      const borrowed = await withDisplayImages(
        ctx.db,
        "ingredient",
        [{ id: ingredient.entityId }],
        (row) => ({ id: row.id }),
      );
      expect(borrowed[0]?.displayImages).toEqual([expectedDisplayImage(item)]);
    });
  });

  describe("location", () => {
    it("prefers its own gallery, falling back to the identity product's images", async () => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Shelf SKU" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: product.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Bin A", productId: product.id }),
        ctx.actor,
      );
      const locationImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: location.entityId,
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
        expectedDisplayImage(locationImg),
        expectedDisplayImage(productImg),
      ]);
    });
  });

  describe("vendor", () => {
    it("uses its direct displayable logo", async () => {
      const logo = await makeImage();
      const created = await createVendor(
        ctx.db,
        {
          defaultSpendingCategoryId: null,
          spendingProfile: "unspecified",
          aliases: [],
          name: `Logo Vendor ${crypto.randomUUID()}`,
          website: null,
          orderUrlTemplate: null,
          itemizationExpectation: null,
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
      await insertEntityAttachments(ctx.db, {
        entityId: created.entityId,
        role: "logo",
        imageId: logo.id,
      });

      const rows = await withDisplayImages(
        ctx.db,
        "vendor",
        [{ id: created.entityId }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([expectedDisplayImage(logo)]);
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

      expect(rows[0]?.displayImages).toEqual([expectedDisplayImage(cover)]);
      expect(
        (await resolveEntityAttachments(ctx.db, "cookbook", [cb.entityId])).get(
          cb.entityId,
        ),
      ).toMatchObject([{ id: cover.shortcode, role: "cover", position: 0 }]);
    });

    it("falls back to the linked product's photo when it has no cover", async () => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Shelf Copy" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: product.entityId,
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
        expectedDisplayImage(productImg),
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

      const older = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Older Product",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const olderImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: older.entityId,
        imageId: olderImg.id,
        sortOrder: 0,
      });

      const newer = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Newer Product",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const newerImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: newer.entityId,
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
        expectedDisplayImage(olderImg),
        expectedDisplayImage(newerImg),
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
      const owner = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Attachment policy product" }),
        ctx.actor,
      );
      const associationTime = new Date("2026-09-16T12:00:00.000Z");
      const records = await Promise.all([
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-0000000001a1",
          key: `images/${crypto.randomUUID()}.heic`,
          filename: "pending.heic",
          contentType: "image/heic",
          size: 101,
          status: "PENDING",
        }),
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-0000000001a2",
          key: `images/${crypto.randomUUID()}.bin`,
          filename: "legacy.bin",
          contentType: "application/octet-stream",
          size: 102,
          status: "UPLOADED",
          renderStatus: "failed",
          storageStatus: "missing",
        }),
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-0000000001a3",
          key: `images/${crypto.randomUUID()}.pdf`,
          filename: "receipt.pdf",
          contentType: "application/pdf",
          size: 103,
          status: "UPLOADED",
          renderStatus: "verified",
          storageStatus: "metadata_mismatch",
        }),
        insertWithShortcode(ctx.db, "image", {
          id: "00000000-0000-4000-8000-0000000001a4",
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
      await insertEntityAttachments(ctx.db, [
        ...records.map((record, index) => ({
          entityId: owner.entityId,
          imageId: record.id,
          sortOrder: index === 0 ? 0 : index < 3 ? 1 : 2,
          createdAt: associationTime,
        })),
        {
          entityId: owner.entityId,
          imageId: deletedImage.id,
          sortOrder: 3,
        },
        {
          entityId: owner.entityId,
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
      await insertEntityAttachments(ctx.db, {
        entityId: purchase.id,
        imageId: purchasePhoto.id,
      });
      await insertEntityAttachments(ctx.db, {
        entityId: project.id,
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
      const pA = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Candidate A",
          categoryId: taxonomyShortcode("tools"),
        }),
        ctx.actor,
      );
      const imgA = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: pA.entityId,
        imageId: imgA.id,
        sortOrder: 0,
      });

      const pB = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Candidate B",
          categoryId: taxonomyShortcode("tools"),
        }),
        ctx.actor,
      );
      const imgB = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: pB.entityId,
        imageId: imgB.id,
        sortOrder: 0,
      });

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
        expectedDisplayImage(imgA),
        expectedDisplayImage(imgB),
      ]);

      // Regression: the wish list handed hydrated rows (shortcode `id`) to the
      // uuid-keyed resolver, so /wishes failed with "invalid input syntax for
      // type uuid" whenever any wish existed.
      const listed = await wishScaffold.read(ctx.db, {
        filters: {},
        sorts: [],
        pagination: {
          pageIndex: 0,
          pageSize: 10,
        },
      });
      expect(
        listed.data.find((row) => row.id === wish.output.id)?.displayImages,
      ).toEqual([expectedDisplayImage(imgA), expectedDisplayImage(imgB)]);
    });
  });

  describe("inventory and expense (borrowed)", () => {
    it("an inventory entry shows its product's images", async () => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Inventoried Product" }),
        ctx.actor,
      );
      const img = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: product.entityId,
        imageId: img.id,
        sortOrder: 0,
      });
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

      expect(rows[0]?.displayImages).toEqual([expectedDisplayImage(img)]);
    });

    it("an expense shows its product's images", async () => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Expensed Product" }),
        ctx.actor,
      );
      const img = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: product.entityId,
        imageId: img.id,
        sortOrder: 0,
      });
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

      expect(rows[0]?.displayImages).toEqual([expectedDisplayImage(img)]);
    });

    it("a project borrows principal product images from explicit and purchase-default expenses", async () => {
      const owner = await insertWithShortcode(ctx.db, "project", {
        name: `Image owner ${crypto.randomUUID()}`,
      });
      const inherited = await insertWithShortcode(ctx.db, "project", {
        name: `Purchase project ${crypto.randomUUID()}`,
      });
      const unrelated = await insertWithShortcode(ctx.db, "project", {
        name: `Unrelated project ${crypto.randomUUID()}`,
      });
      const purchasedProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic purchased product" }),
        ctx.actor,
      );
      const photo = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: purchasedProduct.entityId,
        imageId: photo.id,
        sortOrder: 0,
      });
      await createExpense(
        ctx.db,
        makeExpenseInput({
          projectId: owner.shortcode,
          productId: purchasedProduct.id,
        }),
        ctx.actor,
      );
      const vendor = await insertWithShortcode(ctx.db, "vendor", {
        name: `Synthetic vendor ${crypto.randomUUID()}`,
      });
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        date: "2026-09-01",
        defaultProjectId: inherited.id,
      });
      await createExpense(
        ctx.db,
        makeExpenseInput({
          purchaseId: purchase.shortcode,
          productId: purchasedProduct.id,
        }),
        ctx.actor,
      );
      const overriddenProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic override product" }),
        ctx.actor,
      );
      const overridePhoto = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: overriddenProduct.entityId,
        imageId: overridePhoto.id,
        sortOrder: 0,
      });
      await createExpense(
        ctx.db,
        makeExpenseInput({
          projectId: owner.shortcode,
          purchaseId: purchase.shortcode,
          productId: overriddenProduct.id,
        }),
        ctx.actor,
      );

      const rows = await withDisplayImages(
        ctx.db,
        "project",
        [{ id: owner.id }, { id: inherited.id }, { id: unrelated.id }],
        (row) => ({ id: row.id }),
      );
      expect(rows[0]?.displayImages).toHaveLength(2);
      expect(new Set(rows[0]?.displayImages.map((image) => image.id))).toEqual(
        new Set([photo.shortcode, overridePhoto.shortcode]),
      );
      expect(rows[1]?.displayImages).toEqual([expectedDisplayImage(photo)]);
      expect(rows[2]?.displayImages).toEqual([]);
    });
  });

  describe("project through tasks", () => {
    it("composes Task/Project fallbacks and deduplicates reciprocal image paths", async () => {
      const project = await createRepoEntity(ctx, "project", {
        name: "Synthetic media project",
        defaultTrade: "other",
      });
      const secondBrand = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic second brand",
      });
      const brand = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic nested brand",
      });
      const oldLogo = await makeImage();
      const newLogo = await makeImage();
      await insertEntityAttachments(ctx.db, [
        { entityId: brand.entityId, imageId: oldLogo.id, role: "logo" },
        { entityId: secondBrand.entityId, imageId: newLogo.id, role: "logo" },
      ]);
      const olderProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic old subject",
          brandId: brand.output.id,
        }),
        ctx.actor,
      );
      const newerProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic new subject",
          brandId: secondBrand.output.id,
        }),
        ctx.actor,
      );
      await createRepoEntity(ctx, "task", {
        name: "Synthetic old task",
        projectId: project.output.id,
        subjectProductId: olderProduct.id,
        subjectProductMode: "explicit",
      });
      await createRepoEntity(ctx, "task", {
        name: "Synthetic new task",
        projectId: project.output.id,
        subjectProductId: newerProduct.id,
        subjectProductMode: "explicit",
      });
      const rows = await withDisplayImages(
        ctx.db,
        "project",
        [{ id: project.entityId }],
        (row) => row,
      );
      expect(rows[0]?.displayImages).toEqual([
        expectedDisplayImage(oldLogo),
        expectedDisplayImage(newLogo),
      ]);
      const bareTask = await createRepoEntity(ctx, "task", {
        name: "Synthetic task without a subject",
        projectId: project.output.id,
      });
      const images = await resolveEntityDisplayImages(ctx.db, [
        { entityKind: "task", entityId: bareTask.entityId },
      ]);
      expect(images.get(entityRefKey("task", bareTask.entityId))).toEqual(
        expectedImageUrl(oldLogo),
      );
      const direct = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: project.entityId,
        imageId: direct.id,
      });
      expect(
        (
          await resolveEntityDisplayImages(ctx.db, [
            { entityKind: "task", entityId: bareTask.entityId },
          ])
        ).get(entityRefKey("task", bareTask.entityId)),
      ).toEqual(expectedImageUrl(direct));
    });

    // An inherited Task project joins through a statement-local effective
    // relation; a child Task with no project of its own still lends its image
    // to its parent's project, and never to another project.
    it("borrows images from tasks whose project is inherited from a parent task", async () => {
      const owner = await insertWithShortcode(ctx.db, "project", {
        name: `Task image owner ${crypto.randomUUID()}`,
      });
      const unrelated = await insertWithShortcode(ctx.db, "project", {
        name: `Task image unrelated ${crypto.randomUUID()}`,
      });
      const parent = await insertWithShortcode(ctx.db, "task", {
        name: "Synthetic parent task",
        projectId: owner.id,
        projectMode: "explicit",
      });
      const child = await insertWithShortcode(ctx.db, "task", {
        name: "Synthetic inheriting task",
        parentTaskId: parent.id,
        projectMode: "inherit",
      });
      const photo = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: child.id,
        imageId: photo.id,
        sortOrder: 0,
      });

      const rows = await withDisplayImages(
        ctx.db,
        "project",
        [{ id: owner.id }, { id: unrelated.id }],
        (row) => ({ id: row.id }),
      );
      expect(rows[0]?.displayImages).toEqual([expectedDisplayImage(photo)]);
      expect(rows[1]?.displayImages).toEqual([]);
      // Image-presence filters read the same inherited relation.
      const presence = await getDb(ctx.db).execute(sql`SELECT
        ${entityDisplayImagePresenceSql("project", sql`${owner.id}::uuid`)} AS owner,
        ${entityDisplayImagePresenceSql("project", sql`${unrelated.id}::uuid`)} AS unrelated`);
      expect(presence.rows).toEqual([{ owner: true, unrelated: false }]);
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
      await insertEntityAttachments(ctx.db, [
        { entityId: entry.id, imageId: second.id, sortOrder: 1 },
        { entityId: entry.id, imageId: first.id, sortOrder: 0 },
      ]);

      const rows = await withDisplayImages(
        ctx.db,
        "gardenEntry",
        [{ id: entry.id }],
        (row) => ({ id: row.id }),
      );

      expect(rows[0]?.displayImages).toEqual([
        expectedDisplayImage(first),
        expectedDisplayImage(second),
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
      const seedPacket = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Planting fallback seed packet" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: seedPacket.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const crop = await createPlantFixture(
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
          plantId: crop.id,
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
        expectedDisplayImage(newerImg),
        expectedDisplayImage(olderImg),
        expectedDisplayImage(productImg),
      ]);
    });

    it("falls back to the seed product's photo when there are no journal entries", async () => {
      const seedPacket = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "No-entry seed packet" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: seedPacket.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const crop = await createPlantFixture(
        ctx.db,
        { name: "No-entry crop" },
        ctx.actor,
      );
      const planted = await createPlanting(
        ctx.db,
        {
          plantId: crop.id,
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
        expectedDisplayImage(productImg),
      ]);
    });

    it("is empty with neither journal entries nor a seed product", async () => {
      const crop = await createPlantFixture(
        ctx.db,
        { name: "Empty fallback crop" },
        ctx.actor,
      );
      const planted = await createPlanting(
        ctx.db,
        { plantId: crop.id, status: "planned" },
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
    it("selects the current ready derivative and honors the original override", async () => {
      const owner = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Image representation fixture" }),
        ctx.actor,
      );
      const cover = await makeImage();
      const sourceHash = "a".repeat(64);
      const derivativeKey = `images/${crypto.randomUUID()}.png`;
      await getDb(ctx.db)
        .update(image)
        .set({ sha256: sourceHash })
        .where(eq(image.id, cover.id));
      await insertEntityAttachments(ctx.db, {
        entityId: owner.entityId,
        imageId: cover.id,
        sortOrder: 0,
      });
      await getDb(ctx.db)
        .insert(imageDerivative)
        .values({
          imageId: parseEntityId("image", cover.id),
          purpose: "transparent",
          status: "ready",
          key: derivativeKey,
          sourceContentHash: sourceHash,
          processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
          contentType: "image/png",
          sha256: "b".repeat(64),
          width: 10,
          height: 10,
        });
      const ref = [
        { entityKind: "product" as const, entityId: owner.entityId },
      ];
      const key = entityRefKey("product", owner.entityId);
      const original = getR2PublicUrl(cover.key);
      const transparent = getR2PublicUrl(derivativeKey);

      expect((await resolveEntityDisplayImages(ctx.db, ref)).get(key)).toEqual({
        url: transparent,
        representations: {
          original,
          transparent,
          preferred: transparent,
          preferredKind: "transparent",
        },
      });

      await getDb(ctx.db)
        .update(image)
        .set({ useOriginal: true })
        .where(eq(image.id, cover.id));
      expect((await resolveEntityDisplayImages(ctx.db, ref)).get(key)).toEqual({
        url: original,
        representations: {
          original,
          transparent,
          preferred: original,
          preferredKind: "original",
        },
      });

      await getDb(ctx.db)
        .update(image)
        .set({ useOriginal: false, sha256: "c".repeat(64) })
        .where(eq(image.id, cover.id));
      expect((await resolveEntityDisplayImages(ctx.db, ref)).get(key)).toEqual(
        expectedImageUrl(cover),
      );
    });

    it("returns only the cover and omits refs with no image", async () => {
      const withImage = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Covered" }),
        ctx.actor,
      );
      const cover = await makeImage();
      const second = await makeImage();
      await insertEntityAttachments(ctx.db, [
        {
          entityId: withImage.entityId,
          imageId: cover.id,
          sortOrder: 0,
        },
        {
          entityId: withImage.entityId,
          imageId: second.id,
          sortOrder: 1,
        },
      ]);
      const withoutImage = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Coverless" }),
        ctx.actor,
      );

      const result = await resolveEntityDisplayImages(ctx.db, [
        { entityKind: "product", entityId: withImage.entityId },
        { entityKind: "product", entityId: withoutImage.entityId },
      ]);

      expect(result.get(entityRefKey("product", withImage.entityId))).toEqual(
        expectedImageUrl(cover),
      );
      expect(result.has(entityRefKey("product", withoutImage.entityId))).toBe(
        false,
      );
    });

    it("silently omits an unsupported entity type", async () => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Real Entity" }),
        ctx.actor,
      );
      const img = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: product.entityId,
        imageId: img.id,
        sortOrder: 0,
      });
      const financialAccountId = crypto.randomUUID();

      const result = await resolveEntityDisplayImages(ctx.db, [
        { entityKind: "product", entityId: product.entityId },
        { entityKind: "financialAccount", entityId: financialAccountId },
      ]);

      expect(result.get(entityRefKey("product", product.entityId))).toEqual(
        expectedImageUrl(img),
      );
      expect(
        result.has(entityRefKey("financialAccount", financialAccountId)),
      ).toBe(false);
    });

    it("resolves a mixed batch of several entity types independently", async () => {
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Product" }),
        ctx.actor,
      );
      const productImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: product.entityId,
        imageId: productImg.id,
        sortOrder: 0,
      });

      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Mixed Location" }),
        ctx.actor,
      );
      const locationImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: location.entityId,
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
      const ingredientProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Mixed Ingredient Product",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const ingredientImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: ingredientProduct.entityId,
        imageId: ingredientImg.id,
        sortOrder: 0,
      });

      const wishProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Mixed Wish Product",
          categoryId: taxonomyShortcode("tools"),
        }),
        ctx.actor,
      );
      const wishImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: wishProduct.entityId,
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

      const invProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Inventory Product" }),
        ctx.actor,
      );
      const invImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: invProduct.entityId,
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

      const expProduct = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Mixed Expense Product" }),
        ctx.actor,
      );
      const expImg = await makeImage();
      await insertEntityAttachments(ctx.db, {
        entityId: expProduct.entityId,
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
      await insertEntityAttachments(ctx.db, {
        entityId: gardenEntryRow.id,
        imageId: gardenImg.id,
        sortOrder: 0,
      });

      const result = await resolveEntityDisplayImages(ctx.db, [
        { entityKind: "product", entityId: product.entityId },
        { entityKind: "location", entityId: location.entityId },
        { entityKind: "cookbook", entityId: cookbook.entityId },
        { entityKind: "ingredient", entityId: ingredient.entityId },
        { entityKind: "wish", entityId: wish.entityId },
        { entityKind: "inventory", entityId: inventoryEntry.entityId },
        { entityKind: "expense", entityId: expense.entityId },
        { entityKind: "gardenEntry", entityId: gardenEntryRow.id },
      ]);

      expect(result.get(entityRefKey("product", product.entityId))).toEqual(
        expectedImageUrl(productImg),
      );
      expect(result.get(entityRefKey("location", location.entityId))).toEqual(
        expectedImageUrl(locationImg),
      );
      expect(result.get(entityRefKey("cookbook", cookbook.entityId))).toEqual(
        expectedImageUrl(cover),
      );
      expect(
        result.get(entityRefKey("ingredient", ingredient.entityId)),
      ).toEqual(expectedImageUrl(ingredientImg));
      expect(result.get(entityRefKey("wish", wish.entityId))).toEqual(
        expectedImageUrl(wishImg),
      );
      expect(
        result.get(entityRefKey("inventory", inventoryEntry.entityId)),
      ).toEqual(expectedImageUrl(invImg));
      expect(result.get(entityRefKey("expense", expense.entityId))).toEqual(
        expectedImageUrl(expImg),
      );
      expect(
        result.get(entityRefKey("gardenEntry", gardenEntryRow.id)),
      ).toEqual(expectedImageUrl(gardenImg));
    });
  });
});
