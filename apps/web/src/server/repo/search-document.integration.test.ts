import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { image, product, productImage } from "~/server/db/schema";
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
import { findSearchHits } from "~/server/services/search.service";

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
});
