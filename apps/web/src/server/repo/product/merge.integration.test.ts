import { GTIN_SOURCE } from "@cubby/schemas/external-id";
import {
  type ProductId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { ProductCreateInput } from "@cubby/schemas/product";
import { and, asc, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  inventoryEntry,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
} from "~/server/repo/database-helpers";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import {
  createProduct,
  mergeProducts,
  previewMergeProducts,
} from "~/server/repo/product";
import {
  attachProductComponents,
  listProductComponents,
} from "~/server/repo/product-components";
import {
  createImageFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

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
    overrides: Omit<Partial<ProductCreateInput>, "ingredientId"> = {},
  ) => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name, ...overrides }),
      TEST_ACTOR,
    );
    return {
      shortcode: created.id,
      id: unsafeProductId(await resolveId(created.id, "product")),
    };
  };

  const seedLocation = async (name: string) => {
    const created = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return unsafeLocationId(await resolveId(created.id, "location"));
  };

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

  const liveUnitMappings = (productId: ProductId) =>
    getDb(ctx.db).query.productUnitMappings.findMany({
      where: and(
        eq(productUnitMappings.productId, productId),
        notDeleted(productUnitMappings),
      ),
      columns: { a: true, b: true, source: true },
      orderBy: [asc(productUnitMappings.createdAt)],
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
    // The loser's own name becomes a survivor alias, so a search for the old
    // spelling still lands somewhere.
    expect(survivor?.aliases).toContain("20V MAX Drill Kit");
    expect(survivor?.price).toBe(199);
    expect(survivor?.notes).toBe("From the retailer import");
    // The barcode is no longer a carried COLUMN — it rides the external-id
    // fold, so it lands on the survivor as a `gtin` row instead of overwriting
    // a scalar. Same guarantee the old `carriedFields` assertion gave (the
    // loser's identifier is not lost), on the model that can hold two.
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
        // Same slot, different value — the conflict that makes a blind
        // re-point violate `(productId, source, kind)`.
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-LOSER",
          url: "https://example.test/loser",
        },
        // A slot the keeper does NOT fill — this one simply moves.
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
    // The keeper's SKU stays PRIMARY — the survivor's value still wins the slot.
    expect(bySlot.get("homedepot/retailer_sku")?.externalId).toBe("HD-KEEPER");
    // ...but the url the keeper's row lacked is carried over
    // (fill-never-overwrite).
    expect(bySlot.get("homedepot/retailer_sku")?.url).toBe(
      "https://example.test/loser",
    );
    expect(bySlot.get("amazon/asin")?.externalId).toBe("B00LOSER01");
    // The loser's SKU is on the survivor as a SECONDARY, still resolvable.
    expect(
      survivorIds.filter((row) => !row.isPrimary).map((row) => row.externalId),
    ).toEqual(["HD-LOSER"]);
    // Nothing is left pointing at the merged-away product.
    expect(await liveExternalIds(loser.id)).toHaveLength(0);
  });

  it("leaves a primary in a slot the loser held twice", async () => {
    // Exactly the shape the `contract` migration created on five real products:
    // one amazon/asin slot holding a primary AND a secondary. `planSlotCollisions`
    // takes the first row it sees as the slot's occupant and is isPrimary-unaware,
    // so without a deterministic order the secondary could win — re-pointing
    // as-is while the real primary is demoted, leaving the slot with rows but no
    // primary. The partial unique forbids two, never zero, so nothing complains;
    // the slot just stops answering the next primary upsert's arbiter.
    const keeper = await seedProduct("Keeper Two Asins", {
      model: "TWOASIN-1",
    });
    const loser = await seedProduct("Loser Two Asins", { model: "TWOASIN-1" });
    // SECONDARY inserted first, on purpose. Without an explicit order the
    // planner hands back heap order, so seeding the primary first would let the
    // bug pass by luck — which it did until this was flipped.
    await getDb(ctx.db).insert(productExternalId).values({
      productId: loser.id,
      source: "amazon",
      kind: "asin",
      externalId: "B0SECOND99",
      isPrimary: false,
    });
    await getDb(ctx.db).insert(productExternalId).values({
      productId: loser.id,
      source: "amazon",
      kind: "asin",
      externalId: "B0PRIMARY9",
      isPrimary: true,
    });

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    const survivor = (await liveExternalIds(keeper.id))
      .filter((row) => row.kind === "asin")
      .map((row) => [row.externalId, row.isPrimary] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    // Both identifiers survive, and the one that was primary still is.
    expect(survivor).toEqual([
      ["B0PRIMARY9", true],
      ["B0SECOND99", false],
    ]);
  });

  it("keeps the survivor's cover when a merged-in image is older", async () => {
    // `foldAssociation` re-points without touching `sortOrder`, which defaults
    // to 0 on every row, and the cover is whichever row sorts first under
    // `asc(sortOrder), asc(createdAt)`. So a merged-in image created earlier
    // silently became the survivor's cover — a barcode scan hijacked a
    // product's cover exactly this way.
    const keeper = await seedProduct("Keeper Cover", { model: "COVER-1" });
    const loser = await seedProduct("Loser Cover", { model: "COVER-1" });
    const loserImage = await createImageFixture(ctx.db, "loser-barcode-scan");
    const keeperImage = await createImageFixture(ctx.db, "keeper-real-photo");
    // The loser's row is OLDER, which is what made it win the tie-break.
    await insertAndReturn(ctx.db, productImage, {
      productId: loser.id,
      imageId: loserImage.id,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: keeper.id,
      imageId: keeperImage.id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    const ordered = await getDb(ctx.db).query.productImage.findMany({
      where: and(
        eq(productImage.productId, keeper.id),
        notDeleted(productImage),
      ),
      columns: { imageId: true },
      orderBy: [asc(productImage.sortOrder), asc(productImage.createdAt)],
    });
    // The survivor's own image is still first, so its cover is unchanged; the
    // merged-in one follows rather than being lost.
    expect(ordered.map((row) => row.imageId)).toEqual([
      keeperImage.id,
      loserImage.id,
    ]);
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
  it("sums every absorbed entry when two losers share the keeper's location", async () => {
    const shelf = await seedLocation("Triple Shelf");
    const keeper = await seedProduct("Keeper Clamp", { model: "CLAMP-1" });
    const loserA = await seedProduct("Loser Clamp A", { model: "CLAMP-1" });
    const loserB = await seedProduct("Loser Clamp B", { model: "CLAMP-1" });

    for (const [product, value] of [
      [keeper, 2],
      [loserA, 3],
      [loserB, 4],
    ] as const) {
      await createInventoryEntry(
        ctx.db,
        {
          productId: product.id,
          locationId: shelf,
          amount: { value, unit: "each" },
        },
        TEST_ACTOR,
      );
    }

    const summary = await mergeProducts(
      ctx.db,
      {
        keepId: keeper.shortcode,
        mergeIds: [loserA.shortcode, loserB.shortcode],
      },
      TEST_ACTOR,
    );

    expect(summary.inventoryMerged).toBe(2);
    const entries = await liveEntries(keeper.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount.value).toBe(9);
    expect(await liveEntries(loserA.id)).toHaveLength(0);
    expect(await liveEntries(loserB.id)).toHaveLength(0);
  });

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

    it("refuses the same merge run the other way round", async () => {
      const kit = await seedProduct("Reverse Kit", { model: "REV-1" });
      const part = await seedProduct("Reverse Part", { model: "REV-2" });
      await attachProductComponents(
        ctx.db,
        kit.id,
        [{ productId: part.id, quantity: 2 }],
        TEST_ACTOR,
      );

      // Merging the descendant into its own kit closes the same loop; the
      // guard is a property of the graph, not of which id the operator kept.
      await expect(
        mergeProducts(
          ctx.db,
          { keepId: part.shortcode, mergeIds: [kit.shortcode] },
          TEST_ACTOR,
        ),
      ).rejects.toThrow(/contain itself/);
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

      // The preview predicted exactly what the mutation did.
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

    it("sums the quantities when one kit listed both merging parts", async () => {
      const kit = await seedProduct("Host Kit", { model: "SUM-1" });
      const keeper = await seedProduct("Keeper Screw", { model: "SUM-2" });
      const loserA = await seedProduct("Loser Screw A", { model: "SUM-3" });
      const loserB = await seedProduct("Loser Screw B", { model: "SUM-4" });
      const otherKit = await seedProduct("Other Kit", { model: "SUM-5" });
      await attachProductComponents(
        ctx.db,
        kit.id,
        [
          { productId: keeper.id, quantity: 2 },
          { productId: loserA.id, quantity: 3 },
          { productId: loserB.id, quantity: 4 },
        ],
        TEST_ACTOR,
      );
      // A kit that lists only a loser — nothing to fold into, so it re-points.
      await attachProductComponents(
        ctx.db,
        otherKit.id,
        [{ productId: loserA.id, quantity: 7 }],
        TEST_ACTOR,
      );

      const preview = await previewMergeProducts(ctx.db, {
        keepId: keeper.id,
        mergeIds: [loserA.id, loserB.id],
      });
      const previewed = new Map(preview.changes.map((c) => [c.code, c.total]));
      expect(previewed.get("repoint-or-sum-same-kit")).toBe(1);
      expect(previewed.get("sum-same-kit-quantity")).toBe(2);

      const summary = await mergeProducts(
        ctx.db,
        {
          keepId: keeper.shortcode,
          mergeIds: [loserA.shortcode, loserB.shortcode],
        },
        TEST_ACTOR,
      );

      expect(summary.kitLinksMoved).toBe(1);
      expect(summary.kitLinksSummed).toBe(2);
      // 2 + 3 + 4 in ONE write. Folding per row would read the unmutated target
      // each pass and persist 6, losing a part inside a destructive operation.
      expect(await componentQuantity(kit.id, keeper.shortcode)).toBe(9);
      expect(await componentCodes(kit.id)).toEqual([keeper.shortcode]);
      expect(await componentQuantity(otherKit.id, keeper.shortcode)).toBe(7);
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

    it("keeps the survivor's own stockTracked rather than overwriting it", async () => {
      const keeper = await seedProduct("Tracked Kit", {
        model: "TRACK-3",
        stockTracked: false,
      });
      const loser = await seedProduct("Donor Kit", {
        model: "TRACK-4",
        stockTracked: true,
      });

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      );

      expect(summary.carriedFields).not.toContain("stockTracked");
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
    it("discards a conflicting density and leaves the survivor one answer", async () => {
      // The two olive oils: same pair, different ratio.
      const keeper = await seedProduct("Olive Oil, CA", {
        model: "OO-KEEP",
        unitMappings: [
          {
            a: { value: 1, unit: "ml" },
            b: { value: 0.92, unit: "g" },
            source: null,
          },
        ],
      });
      const loser = await seedProduct("olive oil", {
        model: "OO-LOSE",
        unitMappings: [
          {
            a: { value: 1, unit: "ml" },
            b: { value: 0.9, unit: "g" },
            source: "unk",
          },
        ],
      });

      const preview = await previewMergeProducts(ctx.db, {
        keepId: keeper.id,
        mergeIds: [loser.id],
      });
      // The point of the preview change: the conflict is visible BEFORE
      // confirming, not only in the audit trail afterwards.
      expect(
        preview.changes.find(
          (change) => change.code === "discard-conflicting-conversion",
        )?.total,
      ).toBe(1);

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      );

      expect(summary.unitMappingsDeduped).toBe(0);
      expect(summary.unitMappingsDiscarded).toHaveLength(1);
      expect(summary.unitMappingsDiscarded[0]).toMatchObject({
        from: "ml",
        to: "g",
        keptRatio: 0.92,
        discardedRatio: 0.9,
        source: "unk",
      });

      // The survivor holds ONE density. Holding both is the defect.
      const survivorMappings = await liveUnitMappings(keeper.id);
      expect(survivorMappings).toHaveLength(1);
      expect(survivorMappings[0]?.b.value).toBe(0.92);
    });

    it("dedupes an identical edge silently, not as a discard", async () => {
      const keeper = await seedProduct("Canola Oil A", {
        model: "CO-KEEP",
        unitMappings: [
          {
            a: { value: 1, unit: "ml" },
            b: { value: 0.92, unit: "g" },
            source: null,
          },
        ],
      });
      const loser = await seedProduct("Canola Oil B", {
        model: "CO-LOSE",
        unitMappings: [
          {
            a: { value: 1, unit: "ml" },
            b: { value: 0.92, unit: "g" },
            source: null,
          },
        ],
      });

      const summary = await mergeProducts(
        ctx.db,
        { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
        TEST_ACTOR,
      );

      expect(summary.unitMappingsDeduped).toBe(1);
      expect(summary.unitMappingsDiscarded).toEqual([]);
      expect(await liveUnitMappings(keeper.id)).toHaveLength(1);
    });

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
