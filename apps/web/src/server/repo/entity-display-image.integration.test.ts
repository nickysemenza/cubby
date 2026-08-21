import { entityRefKey } from "@cubby/schemas/entity";
import { projectCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { projectImage, vendor as vendorTable } from "~/server/db/schema";
import { upsertCookbook } from "./cookbook";
import { getDb, insertAndReturn } from "./database-helpers";
import { resolveEntityDisplayImages } from "./entity-display-image";
import { updateProduct } from "./product";
import { createProject } from "./project";
import { createPurchase } from "./purchase";
import { getRecipesByIDs, updateRecipe } from "./recipe";
import { loadRelatedBranch, loadRelatedPreviews } from "./related-view";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createRecipeFixture,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createVendor } from "./vendor";

describe("resolveEntityDisplayImages", () => {
  const ctx = withTestDb();

  it("resolves every canonical entity arm in one mixed batch", async () => {
    const catalogImage = await createImageFixture(ctx.db, "display-product");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Display product" }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { pendingImageIds: [catalogImage.id] },
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Display bin",
        type: null,
        productId: product.id,
      }),
      ctx.actor,
    );
    const inventory = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const recipeImage = await createImageFixture(ctx.db, "display-recipe");
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Display recipe" }),
      ctx.actor,
    );
    await updateRecipe(
      ctx.db,
      recipe.entityId,
      { pendingImageIds: [recipeImage.id] },
      ctx.actor,
    );

    const cookbookImage = await createImageFixture(ctx.db, "display-cookbook");
    const cookbook = await upsertCookbook(
      ctx.db,
      {
        name: "Display cookbook",
        rawJson: [],
        sourceLabel: "display-test",
        coverImageId: cookbookImage.id,
      },
      ctx.actor,
    );

    const projectCover = await createImageFixture(ctx.db, "display-project");
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Display project" }),
      ctx.actor,
    );
    await insertAndReturn(ctx.db, projectImage, {
      projectId: project.entityId,
      imageId: projectCover.id,
    });

    const vendorLogo = await createImageFixture(ctx.db, "display-vendor");
    const vendor = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "Display vendor" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ logoImageId: vendorLogo.id })
      .where(eq(vendorTable.id, vendor.entityId));

    const purchaseCover = await createImageFixture(ctx.db, "display-purchase");
    const purchase = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "DISPLAY-1",
        date: "2026-08-21",
        pendingImageIds: [purchaseCover.id],
      }),
      ctx.actor,
    );

    const refs = [
      { entityType: "product" as const, entityId: product.entityId },
      { entityType: "inventory" as const, entityId: inventory.entityId },
      { entityType: "location" as const, entityId: location.entityId },
      { entityType: "recipe" as const, entityId: recipe.entityId },
      { entityType: "cookbook" as const, entityId: cookbook.entityId },
      { entityType: "project" as const, entityId: project.entityId },
      { entityType: "purchase" as const, entityId: purchase.entityId },
      { entityType: "vendor" as const, entityId: vendor.entityId },
    ];
    const images = await resolveEntityDisplayImages(ctx.db, refs);

    expect(images.get(entityRefKey("product", product.entityId))?.url).toBe(
      catalogImage.url,
    );
    expect(images.get(entityRefKey("inventory", inventory.entityId))?.url).toBe(
      catalogImage.url,
    );
    expect(images.get(entityRefKey("location", location.entityId))?.url).toBe(
      catalogImage.url,
    );
    expect(images.get(entityRefKey("recipe", recipe.entityId))?.url).toBe(
      recipeImage.url,
    );
    const nestedRecipeRead = await getRecipesByIDs(ctx.db, [recipe.entityId]);
    expect(nestedRecipeRead[0]?.displayImage).toEqual({ url: recipeImage.url });
    expect(images.get(entityRefKey("cookbook", cookbook.entityId))?.url).toBe(
      cookbookImage.url,
    );
    expect(images.get(entityRefKey("project", project.entityId))?.url).toBe(
      projectCover.url,
    );
    expect(images.get(entityRefKey("purchase", purchase.entityId))?.url).toBe(
      purchaseCover.url,
    );
    expect(images.get(entityRefKey("vendor", vendor.entityId))?.url).toBe(
      vendorLogo.url,
    );

    const previews = await loadRelatedPreviews(ctx.db, {
      source: "product",
      sourceIds: [product.id],
      relationKeys: ["product.inventory"],
    });
    expect(previews[0]?.items[0]).toMatchObject({
      entity: "inventory",
      id: inventory.id,
      displayImage: { url: catalogImage.url },
    });

    const branch = await loadRelatedBranch(ctx.db, {
      sourceId: product.id,
      relationKey: "product.inventory",
      offset: 0,
      limit: 20,
    });
    expect(branch.items[0]?.displayImage).toEqual({ url: catalogImage.url });
    expect(JSON.stringify({ previews, branch })).not.toContain(
      inventory.entityId,
    );
  });

  it("prefers a location photo and rejects undisplayable images", async () => {
    const productCover = await createImageFixture(ctx.db, "display-fallback");
    const brokenLocationCover = await createImageFixture(
      ctx.db,
      "display-broken-location",
      { renderStatus: "failed" },
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Fallback product" }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      { pendingImageIds: [productCover.id] },
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Fallback location",
        type: null,
        productId: product.id,
        pendingImageIds: [brokenLocationCover.id],
      }),
      ctx.actor,
    );

    const fallback = await resolveEntityDisplayImages(ctx.db, [
      { entityType: "location", entityId: location.entityId },
    ]);
    expect(fallback.get(entityRefKey("location", location.entityId))?.url).toBe(
      productCover.url,
    );

    const ownCover = await createImageFixture(ctx.db, "display-own-location");
    const photographed = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Photographed location",
        type: null,
        productId: product.id,
        pendingImageIds: [ownCover.id],
      }),
      ctx.actor,
    );
    const preferred = await resolveEntityDisplayImages(ctx.db, [
      { entityType: "location", entityId: photographed.entityId },
    ]);
    expect(
      preferred.get(entityRefKey("location", photographed.entityId))?.url,
    ).toBe(ownCover.url);
  });
});
