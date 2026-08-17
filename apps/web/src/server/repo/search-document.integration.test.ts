import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  image,
  location,
  locationImage,
  product,
  productImage,
} from "~/server/db/schema";
import { getDb, insertAndReturn } from "~/server/repo/database-helpers";
import { deleteProducts } from "~/server/repo/product";
import {
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  getSearchDocumentDiagnostics,
  refreshSearchDocument,
} from "~/server/repo/search-document";
import {
  findSearchHits,
  inspectSearchDocumentHealth,
  repairSearchDocuments,
} from "~/server/services/search.service";

describe("SearchDocument indexed retrieval", () => {
  const ctx = withTestDb();

  it("ranks exact, prefix, text, and fuzzy hits while respecting scopes", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Brass Compression Elbow",
        aliases: ["plumber elbow"],
        manufacturer: "Acme Hydraulics",
        notes: "for the basement radiant manifold",
      }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Brass workshop shelf" }),
      ctx.actor,
    );
    await Promise.all([
      refreshSearchDocument(ctx.db, "product", product.entityId),
      refreshSearchDocument(ctx.db, "location", location.entityId),
    ]);

    const exact = await findSearchHits(ctx.db, {
      query: product.id,
      limit: 5,
    });
    expect(exact[0]).toMatchObject({
      id: product.id,
      entityType: "product",
      matchKind: "exact",
      matchField: "shortcode",
    });

    const alias = await findSearchHits(ctx.db, {
      query: "plumber elbow",
      limit: 5,
    });
    expect(alias[0]).toMatchObject({
      id: product.id,
      matchKind: "exact",
      matchField: "alias",
      matchReason: "Exact alias match",
    });

    const prefix = await findSearchHits(ctx.db, {
      query: "brass comp",
      limit: 5,
    });
    expect(prefix[0]).toMatchObject({ id: product.id, matchKind: "prefix" });

    const text = await findSearchHits(ctx.db, {
      query: "radiant manifold",
      entityTypes: ["product"],
      limit: 5,
    });
    expect(text[0]).toMatchObject({
      id: product.id,
      matchKind: "text",
      matchField: "body",
    });

    const fuzzy = await findSearchHits(ctx.db, {
      query: "comression elbow",
      entityTypes: ["product"],
      limit: 5,
    });
    expect(fuzzy[0]).toMatchObject({ id: product.id, matchKind: "fuzzy" });

    const scoped = await findSearchHits(ctx.db, {
      query: "brass",
      entityTypes: ["location"],
      limit: 5,
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      id: location.id,
      entityType: "location",
    });
  });

  it("retires a document in the source entity's removal transaction", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Retired Search Document Product" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    await deleteProducts(ctx.db, [product.entityId], ctx.actor);

    expect(
      await findSearchHits(ctx.db, {
        query: "Retired Search Document Product",
        limit: 5,
      }),
    ).not.toContainEqual(expect.objectContaining({ id: product.id }));
  });

  it("hydrates the first displayable product thumbnail and excludes PDFs", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Thumbnail Search Product" }),
      ctx.actor,
    );
    const pdf = await insertAndReturn(ctx.db, image, {
      key: `test/${crypto.randomUUID()}.pdf`,
      url: "https://example.com/ignored.pdf",
      filename: "ignored.pdf",
      contentType: "application/pdf",
      size: 123,
    });
    const cover = await insertAndReturn(ctx.db, image, {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: "https://example.com/cover.jpg",
      filename: "cover.jpg",
      contentType: "image/jpeg",
      size: 456,
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: product.entityId,
      imageId: pdf.id,
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: product.entityId,
      imageId: cover.id,
    });
    await refreshSearchDocument(ctx.db, "product", product.entityId);

    const [hit] = await findSearchHits(ctx.db, {
      query: "Thumbnail Search Product",
      entityTypes: ["product"],
      limit: 1,
    });
    expect(hit).toMatchObject({ id: product.id, imageUrl: cover.url });
  });

  it("hydrates a location thumbnail from its identity product, after any own photo", async () => {
    const vessel = await createProduct(
      ctx.db,
      makeProductInput({ name: "Search thumbnail vessel" }),
      ctx.actor,
    );
    const productCover = await insertAndReturn(ctx.db, image, {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: "https://example.com/location-product-cover.jpg",
      filename: "location-product-cover.jpg",
      contentType: "image/jpeg",
      size: 456,
    });
    await insertAndReturn(ctx.db, productImage, {
      productId: vessel.entityId,
      imageId: productCover.id,
    });
    const vesselLocation = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Search location identity thumbnail",
        productId: vessel.id,
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", vesselLocation.entityId);

    const search = () =>
      findSearchHits(ctx.db, {
        query: vesselLocation.id,
        entityTypes: ["location"],
        limit: 1,
      });
    expect((await search())[0]).toMatchObject({ imageUrl: productCover.url });

    const ownPhoto = await insertAndReturn(ctx.db, image, {
      key: `test/${crypto.randomUUID()}.jpg`,
      url: "https://example.com/location-own-cover.jpg",
      filename: "location-own-cover.jpg",
      contentType: "image/jpeg",
      size: 456,
    });
    await insertAndReturn(ctx.db, locationImage, {
      locationId: vesselLocation.entityId,
      imageId: ownPhoto.id,
    });

    expect((await search())[0]).toMatchObject({ imageUrl: ownPhoto.url });
  });

  it("diagnoses missing, stale, and orphaned documents", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name: "Search diagnostics fixture" }),
      ctx.actor,
    );

    expect(
      (await getSearchDocumentDiagnostics(ctx.db, ["product"])).missing,
    ).toContainEqual({ entityType: "product", entityId: created.entityId });

    await refreshSearchDocument(ctx.db, "product", created.entityId);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Changed outside the refresh path" })
      .where(eq(product.id, created.entityId));
    expect(
      (await getSearchDocumentDiagnostics(ctx.db, ["product"])).stale,
    ).toContainEqual({ entityType: "product", entityId: created.entityId });

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, created.entityId));
    expect(
      (await getSearchDocumentDiagnostics(ctx.db, ["product"])).orphaned,
    ).toContainEqual({ entityType: "product", entityId: created.entityId });
  });

  it("reports a projected column the embedding text never echoes as stale", async () => {
    // The gap that let 100 location documents keep a `typeHint` their
    // `Location.type` had already lost: staleness used to compare only the
    // semantic body, so a projected column was covered exactly as far as that
    // body happened to repeat it. A location's ancestor path is the case with
    // no overlap at all — it is the document's `subtitle`, and
    // `buildLocationEmbeddingText` never receives it — so renaming the parent
    // leaves the child's body byte-identical and only the projection wrong.
    const parent = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Original parent name" }),
      ctx.actor,
    );
    const child = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Child of renamed parent",
        parentId: parent.id,
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", child.entityId);

    const [before] = await getDb(ctx.db)
      .execute<{ semanticText: string }>(
        sql`SELECT "semanticText" FROM "SearchDocument"
          WHERE "entityType" = 'location' AND "entityId" = ${child.entityId}::uuid`,
      )
      .then((result) => result.rows);

    await getDb(ctx.db)
      .update(location)
      .set({ name: "Renamed outside the refresh path" })
      .where(eq(location.id, parent.entityId));

    const diagnostics = await getSearchDocumentDiagnostics(ctx.db, [
      "location",
    ]);
    expect(diagnostics.stale).toContainEqual({
      entityType: "location",
      entityId: child.entityId,
    });

    // Pins that the child's body is untouched — without it this test would
    // still pass against the old body-only predicate and pin nothing.
    const [after] = await getDb(ctx.db)
      .execute<{ semanticText: string }>(
        sql`SELECT "semanticText" FROM "SearchDocument"
          WHERE "entityType" = 'location' AND "entityId" = ${child.entityId}::uuid`,
      )
      .then((result) => result.rows);
    expect(after?.semanticText).toBe(before?.semanticText);

    await refreshSearchDocument(ctx.db, "location", child.entityId);
    expect(
      (await getSearchDocumentDiagnostics(ctx.db, ["location"])).stale,
    ).not.toContainEqual({
      entityType: "location",
      entityId: child.entityId,
    });
  });

  it("repairs missing and stale documents and retires orphans", async () => {
    const missing = await createProduct(
      ctx.db,
      makeProductInput({ name: "Missing search document fixture" }),
      ctx.actor,
    );
    const stale = await createProduct(
      ctx.db,
      makeProductInput({ name: "Stale search document fixture" }),
      ctx.actor,
    );
    const orphaned = await createProduct(
      ctx.db,
      makeProductInput({ name: "Orphaned search document fixture" }),
      ctx.actor,
    );
    await Promise.all([
      refreshSearchDocument(ctx.db, "product", stale.entityId),
      refreshSearchDocument(ctx.db, "product", orphaned.entityId),
    ]);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Stale source changed outside refresh" })
      .where(eq(product.id, stale.entityId));
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, orphaned.entityId));

    const result = await repairSearchDocuments(ctx.db);
    expect(result).toMatchObject({
      // Home is a normal searchable Location and starts without a document.
      before: { missing: 2, stale: 1, orphaned: 1, total: 4 },
      queued: 3,
      retired: 1,
    });
    expect(result.batchId).not.toBeNull();
    expect(await inspectSearchDocumentHealth(ctx.db)).toEqual({
      missing: 0,
      stale: 0,
      orphaned: 0,
      total: 0,
    });

    expect(
      await findSearchHits(ctx.db, {
        query: "Missing search document fixture",
        entityTypes: ["product"],
      }),
    ).toContainEqual(expect.objectContaining({ id: missing.id }));
  });

  it("keeps the live-entity unique index aligned with the upsert arbiter", async () => {
    const result = await getDb(ctx.db).execute<{
      unique: boolean;
      predicate: string | null;
      definition: string;
    }>(sql`
      SELECT i.indisunique AS unique,
        pg_get_expr(i.indpred, i.indrelid) AS predicate,
        pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      WHERE idx.relname = 'SearchDocument_live_entity_key'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ unique: true });
    expect(result.rows[0]?.definition).toContain('("entityType", "entityId")');
    expect(result.rows[0]?.predicate).toMatch(/"deletedAt" IS NULL/);
  });
});
