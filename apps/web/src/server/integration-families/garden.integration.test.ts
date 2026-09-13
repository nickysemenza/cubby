import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  gardenEntry,
  inventoryEntry,
  planting,
  product,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  createPlanting,
  finishPlanting,
  gardenEntries,
  movePlanting,
  recordGardenEntry,
  splitPlanting,
  startPlanting,
  updateGardenEntryDetails,
} from "~/server/repo/garden";
import { createPendingImageRecord } from "~/server/repo/image";
import { createIngredient } from "~/server/repo/ingredient";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

describe("garden workflows", () => {
  const ctx = withTestDb();

  const location = (name: string, gardenKind: "bed" | "tray") =>
    createLocation(
      ctx.db,
      makeLocationInput({
        name,
        type: null,
        gardenKind,
        gardenConditions: null,
      }),
      TEST_ACTOR,
    );

  it("keeps source and sowing history while moving, splitting, harvesting, and finishing", async () => {
    const inventoryBefore =
      (
        await getDb(ctx.db)
          .select({ count: sql<number>`count(*)` })
          .from(inventoryEntry)
          .where(notDeleted(inventoryEntry))
      )[0]?.count ?? 0;
    const treeCrop = await createIngredient(
      ctx.db,
      { name: "Garden test lemon" },
      TEST_ACTOR,
    );
    const tree = await createPlanting(
      ctx.db,
      {
        ingredientId: treeCrop.id,
        status: "growing",
        locationId: (await location("Garden test tree area", "bed")).id,
      },
      TEST_ACTOR,
    );
    expect(tree).toMatchObject({
      status: "growing",
      sourceProductId: null,
      sowedOn: null,
      transplantedOn: null,
    });
    const crop = await createIngredient(
      ctx.db,
      { name: "Garden test tomato" },
      TEST_ACTOR,
    );
    const cropId = await resolveLiveShortcode(ctx.db, crop.id, "ingredient");
    expect(cropId).not.toBeNull();
    const source = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Garden test tomato seeds",
        growsIngredientId: parseEntityId("ingredient", cropId!),
      }),
      TEST_ACTOR,
    );
    expect(source.growsIngredientId).toBe(crop.id);
    const sourceId = await resolveLiveShortcode(ctx.db, source.id, "product");
    expect(sourceId).not.toBeNull();
    const sourceRow = await getDb(ctx.db).query.product.findFirst({
      where: eq(product.id, parseEntityId("product", sourceId!)),
      columns: { ingredientId: true, growsIngredientId: true },
    });
    expect(sourceRow).toMatchObject({
      ingredientId: null,
      growsIngredientId: parseEntityId("ingredient", cropId!),
    });
    const tray = await location("Garden test tray", "tray");
    const bed = await location("Garden test bed", "bed");
    const planned = await createPlanting(
      ctx.db,
      {
        ingredientId: crop.id,
        sourceProductId: source.id,
        intendedLocationId: bed.id,
        status: "planned",
      },
      TEST_ACTOR,
    );
    const started = await startPlanting(ctx.db, {
      plantingId: planned.id,
      locationId: tray.id,
      startedOn: "2026-09-12",
      startMethod: "sow",
    });
    expect(started).toMatchObject({
      status: "growing",
      locationId: tray.id,
      sowedOn: "2026-09-12",
    });
    const moved = await movePlanting(ctx.db, {
      plantingId: planned.id,
      locationId: bed.id,
      movedOn: "2026-09-20",
    });
    expect(moved.transplantedOn).toBe("2026-09-20");
    const child = await splitPlanting(ctx.db, {
      plantingId: planned.id,
      locationId: tray.id,
      movedOn: "2026-09-21",
      quantity: "4 seedlings",
    });
    expect(child).toMatchObject({
      parentPlantingId: planned.id,
      sourceProductId: source.id,
      sowedOn: "2026-09-12",
      locationId: tray.id,
    });
    for (const { observedOn, harvestAmount } of [
      { observedOn: "2026-10-05", harvestAmount: "6 tomatoes" },
      { observedOn: "2026-10-12", harvestAmount: "handful" },
    ]) {
      await recordGardenEntry(ctx.db, {
        locationId: bed.id,
        plantingId: planned.id,
        kind: "harvest",
        observedOn,
        harvestAmount,
        pendingImageIds: [],
      });
    }
    const firstPhoto = await createPendingImageRecord(ctx.db, {
      key: "test/garden-first.jpg",
      filename: "garden-first.jpg",
      contentType: "image/jpeg",
      size: 10,
    });
    const secondPhoto = await createPendingImageRecord(ctx.db, {
      key: "test/garden-second.jpg",
      filename: "garden-second.jpg",
      contentType: "image/jpeg",
      size: 10,
    });
    const photoEntry = await recordGardenEntry(ctx.db, {
      locationId: bed.id,
      plantingId: planned.id,
      kind: "observation",
      observedOn: "2026-10-15",
      note: "Photo batch",
      pendingImageIds: [firstPhoto.shortcode, secondPhoto.shortcode],
    });
    expect(photoEntry.images).toHaveLength(2);
    const photoEntryId = await resolveLiveShortcode(
      ctx.db,
      photoEntry.id,
      "gardenEntry",
    );
    expect(photoEntryId).not.toBeNull();
    const correctedPhotoEntry = await updateGardenEntryDetails(
      ctx.db,
      parseEntityId("gardenEntry", photoEntryId!),
      {
        note: "Photo batch, corrected",
        removeImageIds: [secondPhoto.shortcode],
        imageOrder: [firstPhoto.shortcode],
      },
    );
    expect(correctedPhotoEntry).toMatchObject({
      note: "Photo batch, corrected",
    });
    expect(correctedPhotoEntry.images).toHaveLength(1);
    await expect(
      updateGardenEntryDetails(
        ctx.db,
        parseEntityId("gardenEntry", photoEntryId!),
        {
          note: "Should roll back attachment failure",
          pendingImageIds: ["IMG-not-a-real-image"],
        },
      ),
    ).rejects.toBeDefined();
    const unchangedPhotoEntry = await gardenEntries(ctx.db, {
      plantingId: planned.id,
      page: 1,
    });
    expect(
      unchangedPhotoEntry.items.find((entry) => entry.id === photoEntry.id),
    ).toMatchObject({ note: "Photo batch, corrected" });
    expect(
      unchangedPhotoEntry.items.find((entry) => entry.id === photoEntry.id)
        ?.images,
    ).toHaveLength(1);
    const history = await gardenEntries(ctx.db, {
      plantingId: planned.id,
      page: 1,
    });
    expect(
      history.items.filter((entry) => entry.kind === "harvest"),
    ).toHaveLength(2);
    expect(moved.status).toBe("growing");
    const finished = await finishPlanting(ctx.db, {
      plantingId: planned.id,
      finishedOn: "2026-11-01",
    });
    expect(finished.status).toBe("finished");
    expect(
      (await gardenEntries(ctx.db, { plantingId: child.id, page: 1 })).items,
    ).not.toHaveLength(0);
    const parentId = await resolveLiveShortcode(ctx.db, planned.id, "planting");
    const childId = await resolveLiveShortcode(ctx.db, child.id, "planting");
    const trayId = await resolveLiveShortcode(ctx.db, tray.id, "location");
    expect(parentId).not.toBeNull();
    expect(childId).not.toBeNull();
    const rows = await getDb(ctx.db)
      .select({ locationId: gardenEntry.locationId })
      .from(gardenEntry)
      .where(
        and(
          eq(gardenEntry.plantingId, parseEntityId("planting", parentId!)),
          notDeleted(gardenEntry),
        ),
      );
    expect(rows.some((row) => row.locationId === trayId)).toBe(true);
    const childRow = await getDb(ctx.db).query.planting.findFirst({
      where: eq(planting.id, parseEntityId("planting", childId!)),
    });
    expect(childRow?.status).toBe("growing");
    const inventoryAfter =
      (
        await getDb(ctx.db)
          .select({ count: sql<number>`count(*)` })
          .from(inventoryEntry)
          .where(notDeleted(inventoryEntry))
      )[0]?.count ?? 0;
    expect(inventoryAfter).toBe(inventoryBefore);
  });
});
