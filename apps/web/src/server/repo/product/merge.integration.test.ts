import { GTIN_SOURCE } from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, asc, eq } from "drizzle-orm";
import { taxonomyId } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityAttachment,
  inventoryEntry,
  planting,
  product,
  productExternalId,
  productUnitMappings,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createPlanting } from "~/server/repo/garden";
import { createUploadedImageRecord } from "~/server/repo/image";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import {
  createProduct,
  mergeProducts,
  previewMergeProducts,
  previewProductMergeDecisions,
} from "~/server/repo/product";
import {
  attachProductComponents,
  listProductComponents,
} from "~/server/repo/product-components";
import {
  dismissProductMatch,
  listProductMatchRows,
  productPairKey,
  upsertAgentProductMatch,
} from "~/server/repo/product-match-candidate";
import {
  createPlantFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

import type { ProductRepoCreateInput } from "./crud";

/**
 * `mergeProducts` exists to resolve two structural collisions that a blind FK
 * re-point cannot survive — the per-product `(source, kind)` identifier slot and
 * the `(productId, locationId)` stock slot. Both are partial unique indexes, so
 * getting either wrong doesn't produce a subtly wrong number, it aborts the
 * whole transaction. These tests exercise each one directly rather than through
 * the happy path.
 */
describe("mergeProducts", () => {
  const ctx = withTestDb();

  const resolveId = async (
    shortcode: string,
    entity: "product" | "location",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };

  const seedProduct = async (
    name: string,
    overrides: Omit<
      Partial<ProductRepoCreateInput>,
      "ingredientId" | "growsPlantId" | "categoryId"
    > & { categoryId?: ProductRepoCreateInput["categoryId"] } = {},
  ) => {
    const { categoryId = null, ...productOverrides } = overrides;
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name, ...productOverrides, categoryId }),
      TEST_ACTOR,
    );
    return {
      shortcode: created.id,
      id: parseEntityId("product", await resolveId(created.id, "product")),
    };
  };

  const seedLocation = async (name: string) => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return parseEntityId("location", await resolveId(created.id, "location"));
  };

  it("previews kept names, filled attributes, and combined images before merge", async () => {
    const keeper = await seedProduct("ForgeWear pocket tee black small", {
      manufacturer: "ForgeWear",
      model: null,
    });
    const incoming = await seedProduct("Dark pocket shirt from photo", {
      model: "Loose Fit",
    });
    for (const [index, item] of [keeper, incoming].entries()) {
      const photo = await createUploadedImageRecord(ctx.db, {
        key: `images/${crypto.randomUUID()}-${index}.jpg`,
        filename: `${index}.jpg`,
        contentType: "image/jpeg",
        size: 100,
      });
      await getDb(ctx.db).insert(entityAttachment).values({
        subjectEntityId: item.id,
        imageId: photo.id,
      });
    }

    const preview = await previewProductMergeDecisions(ctx.db, {
      keepId: keeper.id,
      mergeId: incoming.id,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "Name",
          keeper: "ForgeWear pocket tee black small",
          incoming: "Dark pocket shirt from photo",
          result: "ForgeWear pocket tee black small",
          action: "keep",
        }),
        expect.objectContaining({
          field: "Model",
          keeper: "—",
          incoming: "Loose Fit",
          result: "Loose Fit",
          action: "fill",
        }),
        expect.objectContaining({
          field: "Images",
          keeper: "1 image",
          incoming: "1 image",
          result: "2 images",
          action: "combine",
        }),
      ]),
    );
  });

  const liveExternalIds = (productId: ProductId) =>
    getDb(ctx.db).query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, productId),
        notDeleted(productExternalId),
      ),
      columns: {
        source: true,
        kind: true,
        externalId: true,
        url: true,
        isPrimary: true,
      },
    });

  const liveEntries = (productId: ProductId) =>
    getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.productId, productId),
        notDeleted(inventoryEntry),
      ),
      columns: { id: true, locationId: true, amount: true },
    });

  it("refuses to merge different ISBN editions", async () => {
    const keeper = await seedProduct("Edition One", {
      isbn: "978-0-306-40615-7",
    });
    const loser = await seedProduct("Edition Two", {
      isbn: "978-0-13-110362-7",
    });

    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "block-distinct-isbn-editions" }),
      ]),
    );

    await expect(
      mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/different ISBN editions/);
  });

  it("surfaces plantings that retain a merged source-product tombstone", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "Preview crop" },
      TEST_ACTOR,
    );
    const keeper = await seedProduct("Keeper seed packet");
    const loser = await seedProduct("Original seed packet");
    const planted = await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        sourceProductId: loser.shortcode,
        status: "planned",
      },
      TEST_ACTOR,
    );

    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    expect(preview.sideEffects).toContainEqual(
      expect.objectContaining({
        code: "preserve-planting-source-product",
        total: 1,
        byTargetId: { [loser.id]: 1 },
      }),
    );

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );
    expect(
      await getDb(ctx.db).query.planting.findFirst({
        where: eq(planting.shortcode, planted.id),
        columns: { sourceProductId: true },
      }),
    ).toEqual({ sourceProductId: loser.id });
  });

  it("rejects a carried Food classification when the survivor is a planting source", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "Merge category crop" },
      TEST_ACTOR,
    );
    const keeper = await seedProduct("Garden source", {
      categoryId: taxonomyId("tools"),
    });
    const loser = await seedProduct("Food evidence donor");
    await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        sourceProductId: keeper.shortcode,
        status: "planned",
      },
      TEST_ACTOR,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ fdc_id: 12345 })
      .where(eq(product.id, loser.id));

    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "block-garden-source-food-category" }),
      ]),
    );
    await expect(
      mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/planting source Product must be a garden product/);
    expect(
      await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, keeper.id),
        columns: { categoryId: true },
      }),
    ).toEqual({ categoryId: taxonomyId("tools") });
  });

  const liveUnitMappings = (productId: ProductId) =>
    getDb(ctx.db).query.productUnitMappings.findMany({
      where: and(
        eq(productUnitMappings.productId, productId),
        notDeleted(productUnitMappings),
      ),
      columns: { a: true, b: true, source: true },
      orderBy: [asc(productUnitMappings.createdAt)],
    });

  it("fills a purchase-created survivor's empty manufacturer from the photo-created loser", async () => {
    // Purchase import creates Products with manufacturer "", which is not null,
    // so a null-only carry would drop the brand read off the photographed tag.
    const keeper = await seedProduct("Everyday Crew Tee Heather Gray", {
      manufacturer: "",
    });
    const loser = await seedProduct("Example Brand Crew tee — Gray, M", {
      manufacturer: "Example Brand",
    });

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.carriedFields).toContain("manufacturer");
    const survivor = await getDb(ctx.db).query.product.findFirst({
      where: eq(product.id, keeper.id),
      columns: { manufacturer: true },
    });
    expect(survivor?.manufacturer).toBe("Example Brand");
  });

  it("soft-deletes the losers and folds their identity into the survivor", async () => {
    const keeper = await seedProduct("Cordless Drill", {
      model: "DCD791D2",
      aliases: ["Drill"],
    });
    const loser = await seedProduct("20V MAX Drill Kit", {
      model: "DCD791D2",
      // The keeper has none of these, so each is a gap the merge fills.
      upc: "012345678905",
      price: 199,
      notes: "From the retailer import",
    });

    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    const planned = new Map(
      preview.changes.map((change) => [change.code, change.total]),
    );

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.deletedIds).toEqual([loser.shortcode]);
    // Presentation and execution are two views of the same ProductMergePlan:
    // preview presents it, while mutation rebuilds it under lock and executes
    // its exact carry/fold decisions.
    expect(planned.get("soft-delete-merged-product")).toBe(
      summary.deletedIds.length,
    );
    expect(planned.get("carry-product-aliases")).toBe(
      summary.aliasesAdded.length,
    );
    expect(planned.get("carry-product-fields")).toBe(
      summary.carriedFields.length,
    );
    const rows = await getDb(ctx.db).query.product.findMany({
      where: eq(product.model, "DCD791D2"),
      columns: {
        id: true,
        aliases: true,
        price: true,
        notes: true,
        deletedAt: true,
      },
    });
    const survivor = rows.find((row) => row.id === keeper.id);
    const dead = rows.find((row) => row.id === loser.id);
    expect(dead?.deletedAt).not.toBeNull();
    expect(survivor?.aliases).toContain("20V MAX Drill Kit");
    expect(survivor?.price).toBe(199);
    expect(survivor?.notes).toBe("From the retailer import");
    expect(summary.carriedFields).not.toContain("upc");
    const survivorGtins = await getDb(ctx.db).query.productExternalId.findMany({
      where: and(
        eq(productExternalId.productId, keeper.id),
        eq(productExternalId.source, GTIN_SOURCE),
        notDeleted(productExternalId),
      ),
      columns: { externalId: true, isPrimary: true },
    });
    expect(survivorGtins).toEqual([
      { externalId: "00012345678905", isPrimary: true },
    ]);
  });

  // Regression: merging used to hard-delete every match review naming a loser,
  // so an agent's evidence against a third product vanished with the merge.
  it("keeps match reviews against third products, folding and dropping self-pairs", async () => {
    const keeper = await seedProduct("Match Keeper");
    const loser = await seedProduct("Match Loser");
    const third = await seedProduct("Match Third");
    const fourth = await seedProduct("Match Fourth");
    await upsertAgentProductMatch(ctx.db, {
      productIds: [keeper.id, loser.id],
      evidence: "same item",
      sourceUrls: [],
    });
    await upsertAgentProductMatch(ctx.db, {
      productIds: [loser.id, third.id],
      evidence: "loser matches third",
      sourceUrls: ["https://example.com/a"],
    });
    await dismissProductMatch(ctx.db, [keeper.id, fourth.id]);
    await upsertAgentProductMatch(ctx.db, {
      productIds: [loser.id, fourth.id],
      evidence: "loser matches fourth",
      sourceUrls: ["https://example.com/b"],
    });

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    const rows = await listProductMatchRows(ctx.db);
    const byPair = new Map(
      rows.map((row) => [productPairKey(row.productAId, row.productBId), row]),
    );
    expect(rows).toHaveLength(2);
    expect(byPair.get(productPairKey(keeper.id, third.id))).toMatchObject({
      source: "agent",
      state: "open",
      evidence: "loser matches third",
      sourceUrls: ["https://example.com/a"],
    });
    // The person's dismissal stands; the loser's agent evidence rides along.
    expect(byPair.get(productPairKey(keeper.id, fourth.id))).toMatchObject({
      source: "agent",
      state: "dismissed",
      evidence: "loser matches fourth",
      sourceUrls: ["https://example.com/b"],
    });
  });

  it("dedupes separately stored product images with the same verified hash", async () => {
    const keeper = await seedProduct("Image keeper");
    const loser = await seedProduct("Image duplicate");
    const sha256 = "a".repeat(64);
    const keeperImage = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}-keeper.jpg`,
      filename: "keeper.jpg",
      contentType: "image/jpeg",
      size: 100,
      sha256,
    });
    const loserImage = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}-loser.jpg`,
      filename: "loser.jpg",
      contentType: "image/jpeg",
      size: 100,
      sha256,
    });
    await getDb(ctx.db)
      .insert(entityAttachment)
      .values([
        { subjectEntityId: keeper.id, imageId: keeperImage.id },
        { subjectEntityId: loser.id, imageId: loserImage.id },
      ]);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    const liveImages = await getDb(ctx.db).query.entityAttachment.findMany({
      where: and(
        eq(entityAttachment.subjectEntityId, keeper.id),
        notDeleted(entityAttachment),
      ),
      columns: { imageId: true },
    });
    expect(liveImages).toEqual([{ imageId: keeperImage.id }]);
  });

  it("adopts an explicit duplicate image role only when the keeper is legacy-null", async () => {
    const keeper = await seedProduct("Legacy image role keeper");
    const loser = await seedProduct("Label image role loser");
    const image = await createUploadedImageRecord(ctx.db, {
      key: `images/${crypto.randomUUID()}-shared.jpg`,
      filename: "shared.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    await getDb(ctx.db)
      .insert(entityAttachment)
      .values([
        { subjectEntityId: keeper.id, imageId: image.id, purpose: null },
        { subjectEntityId: loser.id, imageId: image.id, purpose: "label" },
      ]);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    const [surviving] = await getDb(ctx.db).query.entityAttachment.findMany({
      where: and(
        eq(entityAttachment.subjectEntityId, keeper.id),
        eq(entityAttachment.imageId, image.id),
        notDeleted(entityAttachment),
      ),
      columns: { purpose: true },
    });
    expect(surviving?.purpose).toBe("label");
  });

  it("demotes rather than destroys a colliding external-id slot", async () => {
    const keeper = await seedProduct("Keeper Grinder", {
      model: "GRINDER-1",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-KEEPER",
          url: null,
        },
      ],
    });
    const loser = await seedProduct("Loser Grinder", {
      model: "GRINDER-1",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-LOSER",
          url: "https://example.test/loser",
        },
        {
          source: "amazon",
          kind: "asin",
          externalId: "B00LOSER01",
          url: null,
        },
      ],
    });

    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    const planned = new Map(
      preview.changes.map((change) => [change.code, change.total]),
    );

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.externalIdsMoved).toBe(1);
    expect(planned.get("repoint-or-discard-conflicting-slot")).toBe(
      summary.externalIdsMoved,
    );
    expect(planned.get("demote-conflicting-external-id")).toBe(
      summary.externalIdsDemoted.length,
    );
    // Kept, not discarded. Each identifier is a live retailer listing, so
    // destroying one meant the next order line quoting it re-minted the
    // duplicate the merge had just removed.
    expect(summary.externalIdsDemoted).toEqual([
      {
        source: "homedepot",
        kind: "retailer_sku",
        externalId: "HD-LOSER",
      },
    ]);
    // No same-value case exists to count: the global unique on
    // (source, kind, externalId) forbids two live rows sharing an identifier,
    // so a slot collision is always two DIFFERENT values.

    const survivorIds = await liveExternalIds(keeper.id);
    const bySlot = new Map(
      survivorIds
        .filter((row) => row.isPrimary)
        .map((row) => [`${row.source}/${row.kind}`, row]),
    );
    expect(bySlot.get("homedepot/retailer_sku")?.externalId).toBe("HD-KEEPER");
    // ...but the url the keeper's row lacked is carried over
    // (fill-never-overwrite).
    expect(bySlot.get("homedepot/retailer_sku")?.url).toBe(
      "https://example.test/loser",
    );
    expect(bySlot.get("amazon/asin")?.externalId).toBe("B00LOSER01");
    expect(
      survivorIds.filter((row) => !row.isPrimary).map((row) => row.externalId),
    ).toEqual(["HD-LOSER"]);
    // Nothing is left pointing at the merged-away product.
    expect(await liveExternalIds(loser.id)).toHaveLength(0);
  });

  it("sums stock in a shared location instead of losing a row", async () => {
    const shelf = await seedLocation("Merge Shelf");
    const otherShelf = await seedLocation("Merge Other Shelf");
    const keeper = await seedProduct("Keeper Bit Set", { model: "BITS-1" });
    const loser = await seedProduct("Loser Bit Set", { model: "BITS-1" });

    await createInventoryEntry(
      ctx.db,
      {
        productId: keeper.id,
        locationId: shelf,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: loser.id,
        locationId: shelf,
        amount: { value: 3, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: loser.id,
        locationId: otherShelf,
        amount: { value: 5, unit: "each" },
      },
      TEST_ACTOR,
    );

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(summary.inventoryMerged).toBe(1);
    expect(summary.inventoryMoved).toBe(1);

    const entries = await liveEntries(keeper.id);
    expect(entries).toHaveLength(2);
    // The colliding entry ADDS rather than one row winning or the insert
    // erroring — the whole point of the fold.
    expect(entries.find((e) => e.locationId === shelf)?.amount.value).toBe(5);
    expect(entries.find((e) => e.locationId === otherShelf)?.amount.value).toBe(
      5,
    );
    expect(await liveEntries(loser.id)).toHaveLength(0);
  });

  // Two losers on ONE shelf. Folding per-row reads the unmutated target each
  // pass, so the second write overwrites the first: 2 + 3 + 4 persists as 6 and
  // a quantity vanishes inside a destructive operation. `planSlotCollisions`
  // groups by target so the sum happens once.

  it("refuses — and previews a blocker — when shared-location units disagree", async () => {
    const shelf = await seedLocation("Mismatch Shelf");
    const keeper = await seedProduct("Keeper Screws", { model: "SCREW-1" });
    const loser = await seedProduct("Loser Screws", { model: "SCREW-1" });

    await createInventoryEntry(
      ctx.db,
      {
        productId: keeper.id,
        locationId: shelf,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: loser.id,
        locationId: shelf,
        amount: { value: 1, unit: "box" },
      },
      TEST_ACTOR,
    );

    // The preview surfaces it BEFORE the destructive action, which is the only
    // thing a preview is allowed to gate confirmation on.
    const preview = await previewMergeProducts(ctx.db, {
      keepId: keeper.id,
      mergeIds: [loser.id],
    });
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]?.code).toBe("block-inventory-unit-mismatch");

    await expect(
      mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/different units/);

    // Nothing was written — the whole merge rolls back.
    const survivor = await getDb(ctx.db).query.product.findFirst({
      where: eq(product.id, loser.id),
      columns: { deletedAt: true },
    });
    expect(survivor?.deletedAt).toBeNull();
  });

  /**
   * `ProductComponent` is the one incoming edge that points Product at Product,
   * so a merge does not merely move rows between disjoint sets — it identifies
   * two nodes of a DAG. That makes two things possible here and nowhere else in
   * this file: the merge can create a cycle, and the SAME partial-unique slot
   * wants opposite fold rules depending on which end of the edge is merging.
   */
  describe("kit composition", () => {
    const componentCodes = async (parentId: ProductId) =>
      (await listProductComponents(ctx.db, parentId)).map((c) => c.productId);

    const componentQuantity = async (parentId: ProductId, code: string) =>
      (await listProductComponents(ctx.db, parentId)).find(
        (c) => c.productId === code,
      )?.quantity;

    it("refuses to merge a kit into a part it contains, several hops down", async () => {
      const kit = await seedProduct("Combo Kit", { model: "KIT-1" });
      const mid = await seedProduct("Sub Assembly", { model: "KIT-2" });
      const leaf = await seedProduct("Deep Part", { model: "KIT-3" });
      await attachProductComponents(
        ctx.db,
        kit.id,
        [{ productId: mid.id, quantity: 1 }],
        TEST_ACTOR,
      );
      await attachProductComponents(
        ctx.db,
        mid.id,
        [{ productId: leaf.id, quantity: 1 }],
        TEST_ACTOR,
      );

      const preview = await previewMergeProducts(ctx.db, {
        keepId: kit.id,
        mergeIds: [leaf.id],
      });
      expect(preview.blockers.map((b) => b.code)).toContain(
        "block-component-cycle",
      );

      await expect(
        mergeProducts(
          ctx.db,
          { keepId: kit.shortcode, mergeIds: [leaf.shortcode] },
          TEST_ACTOR,
        ),
      ).rejects.toThrow(/contain itself/);

      const dead = await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, leaf.id),
        columns: { deletedAt: true },
      });
      expect(dead?.deletedAt).toBeNull();
    });

    it("dedupes a component two merging kits list at the same quantity", async () => {
      const keeper = await seedProduct("Keeper Kit", { model: "DUP-1" });
      const loser = await seedProduct("Loser Kit", { model: "DUP-2" });
      const shared = await seedProduct("Shared Bit", { model: "DUP-3" });
      const only = await seedProduct("Loser-only Bit", { model: "DUP-4" });
      await attachProductComponents(
        ctx.db,
        keeper.id,
        [{ productId: shared.id, quantity: 4 }],
        TEST_ACTOR,
      );
      await attachProductComponents(
        ctx.db,
        loser.id,
        [
          { productId: shared.id, quantity: 4 },
          { productId: only.id, quantity: 1 },
        ],
        TEST_ACTOR,
      );

      const preview = await previewMergeProducts(ctx.db, {
        keepId: keeper.id,
        mergeIds: [loser.id],
      });
      expect(preview.blockers).toEqual([]);
      const previewed = new Map(preview.changes.map((c) => [c.code, c.total]));
      expect(previewed.get("repoint-or-dedupe-identical-component")).toBe(1);
      expect(previewed.get("dedupe-identical-component")).toBe(1);

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      );

      expect(summary.componentsMoved).toBe(1);
      expect(summary.componentsDeduped).toBe(1);
      expect((await componentCodes(keeper.id)).sort()).toEqual(
        [shared.shortcode, only.shortcode].sort(),
      );
      // Deduping must not double the quantity — the two rows said the same thing.
      expect(await componentQuantity(keeper.id, shared.shortcode)).toBe(4);
    });

    it("refuses when the two kits disagree on how many of the shared part", async () => {
      const keeper = await seedProduct("Keeper Set", { model: "CONF-1" });
      const loser = await seedProduct("Loser Set", { model: "CONF-2" });
      const shared = await seedProduct("Contested Bit", { model: "CONF-3" });
      await attachProductComponents(
        ctx.db,
        keeper.id,
        [{ productId: shared.id, quantity: 4 }],
        TEST_ACTOR,
      );
      await attachProductComponents(
        ctx.db,
        loser.id,
        [{ productId: shared.id, quantity: 3 }],
        TEST_ACTOR,
      );

      const preview = await previewMergeProducts(ctx.db, {
        keepId: keeper.id,
        mergeIds: [loser.id],
      });
      expect(preview.blockers.map((b) => b.code)).toContain(
        "block-component-quantity-mismatch",
      );

      await expect(
        mergeProducts(
          ctx.db,
          { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
          TEST_ACTOR,
        ),
      ).rejects.toThrow(/different quantities/);

      // Whole merge rolled back — neither list was silently rewritten.
      expect(await componentQuantity(keeper.id, shared.shortcode)).toBe(4);
      expect(await componentQuantity(loser.id, shared.shortcode)).toBe(3);
    });

    it("carries a deliberate stockTracked: false onto a survivor that has none", async () => {
      const keeper = await seedProduct("Undecided Kit", { model: "TRACK-1" });
      const loser = await seedProduct("Reviewed Kit", {
        model: "TRACK-2",
        stockTracked: false,
      });

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      );

      // `false` is a decision ("reviewed, no shelf claim"), not an absent value:
      // the fill-never-overwrite carry has to treat it as a donor.
      expect(summary.carriedFields).toContain("stockTracked");
      const survivor = await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, keeper.id),
        columns: { stockTracked: true },
      });
      expect(survivor?.stockTracked).toBe(false);
    });
  });

  /**
   * `ProductUnitMappings` has no unique index, so nothing in the database would
   * have refused these — the write path is the only place the duplicate can be
   * stopped, which is exactly why these are integration rather than unit tests.
   */
  describe("conversion edges", () => {
    it("moves an edge the survivor does not state", async () => {
      const keeper = await seedProduct("Bagged Onions, organic", {
        model: "ON-KEEP",
        unitMappings: [
          {
            a: { value: 1, unit: "ml" },
            b: { value: 0.92, unit: "g" },
            source: null,
          },
        ],
      });
      const loser = await seedProduct("Bagged Onions, 32 oz", {
        model: "ON-LOSE",
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 32, unit: "oz" },
            source: null,
          },
        ],
      });

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      );

      expect(summary.unitMappingsMoved).toBe(1);
      expect(summary.unitMappingsDiscarded).toEqual([]);
      expect(await liveUnitMappings(keeper.id)).toHaveLength(2);
    });
  });
});
