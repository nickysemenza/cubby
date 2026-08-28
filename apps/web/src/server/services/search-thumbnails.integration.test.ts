import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { updateLocation } from "~/server/repo/location";
import { updateProduct } from "~/server/repo/product";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocument } from "~/server/repo/search-document";

import { findSearchHits } from "./search.service";

/**
 * Search thumbnails are hydrated by `hydrateThumbnails`'s one UNION-per-source
 * query, which is the only image path in the app not sharing a mapper with the
 * others — so it is the one that can silently disagree with every UI surface.
 */
describe("search hit thumbnails", () => {
  const ctx = withTestDb();

  const pendingImage = (name: string, overrides = {}) =>
    createImageFixture(ctx.db, name, overrides);

  const locationHit = async (query: string, shortcode: string) => {
    const hits = await findSearchHits(ctx.db, {
      query,
      entityTypes: ["location"],
      limit: 10,
    });
    return hits.find((hit) => hit.id === shortcode);
  };

  it("falls back to the cover of the SKU a bin IS when the bin has no photo", async () => {
    const skuPhoto = await pendingImage("sku-cover");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Tough Storage Tote" }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { pendingImageIds: [parseShortcodeFor("image", skuPhoto.shortcode)] },
      ctx.actor,
    );

    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Zephyrine tote bin",
        type: null,
        productId: product.id,
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", location.entityId);

    expect((await locationHit("Zephyrine", location.id))?.imageUrl).toBe(
      skuPhoto.url,
    );
  });

  it("prefers the bin's own photo over its SKU's catalog shot", async () => {
    const skuPhoto = await pendingImage("sku-loses");
    const ownPhoto = await pendingImage("bin-wins");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Photographed Tote" }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { pendingImageIds: [parseShortcodeFor("image", skuPhoto.shortcode)] },
      ctx.actor,
    );

    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Blorenge tote bin",
        type: null,
        productId: product.id,
      }),
      ctx.actor,
    );
    await updateLocation(
      ctx.db,
      location.entityId,
      { pendingImageIds: [parseShortcodeFor("image", ownPhoto.shortcode)] },
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", location.entityId);

    expect((await locationHit("Blorenge", location.id))?.imageUrl).toBe(
      ownPhoto.url,
    );
  });

  it("skips an own photo that is undisplayable rather than serving a broken url", async () => {
    // The old predicate filtered PDFs only, so a failed render or an object
    // missing from R2 surfaced here while every other surface suppressed it.
    const broken = await pendingImage("failed-render", {
      renderStatus: "failed",
    });
    const manual = await pendingImage("manual", {
      contentType: PDF_CONTENT_TYPE,
    });
    const skuPhoto = await pendingImage("sku-rescue");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Rescue Tote" }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { pendingImageIds: [parseShortcodeFor("image", skuPhoto.shortcode)] },
      ctx.actor,
    );

    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Quillonfast tote bin",
        type: null,
        productId: product.id,
      }),
      ctx.actor,
    );
    await updateLocation(
      ctx.db,
      location.entityId,
      {
        pendingImageIds: [
          parseShortcodeFor("image", broken.shortcode),
          parseShortcodeFor("image", manual.shortcode),
        ],
      },
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", location.entityId);

    expect((await locationHit("Quillonfast", location.id))?.imageUrl).toBe(
      skuPhoto.url,
    );
  });
});
