import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  gardenEntry,
  inventoryEntry,
  planting,
  plantingLocationPeriod,
  product,
} from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  createPlanting,
  correctLocationDates,
  finishPlanting,
  gardenEntries,
  gardenJournal,
  gardenLocationHistory,
  movePlanting,
  recordGardenEntry,
  splitPlanting,
  startPlanting,
  updateGardenEntryDetails,
} from "~/server/repo/garden";
import { plantingEntityAdapter } from "~/server/repo/garden/entity-adapters";
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

  const plantingDeleteContext = (db: Database): EntityKernelContext => ({
    db,
    readDb: db,
    actorContext: TEST_ACTOR,
    // SAFETY: planting deletion never reads enrichment clients.
    usdaClient: undefined as never,
    // SAFETY: planting deletion never reads enrichment clients.
    upcLookupClient: undefined as never,
    services: {
      // SAFETY: planting deletion never invokes recipe side effects.
      recipeCosting: undefined as never,
      // SAFETY: planting deletion never invokes location valuation.
      locationValuation: undefined as never,
    },
  });

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
    expect(
      (await gardenLocationHistory(ctx.db, { plantingId: tree.id })).periods[0],
    ).toMatchObject({
      locationId: tree.locationId,
      startKind: "recorded",
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
    expect(
      await gardenLocationHistory(ctx.db, { plantingId: planned.id }),
    ).toMatchObject({
      periods: [
        {
          sequence: 0,
          locationId: tray.id,
          inLocationSince: "2026-09-12",
          endedOn: "2026-09-20",
          startKind: "actual",
        },
        {
          sequence: 1,
          locationId: bed.id,
          inLocationSince: "2026-09-20",
          endedOn: null,
          startKind: "actual",
        },
      ],
    });
    const bedOverview = await recordGardenEntry(ctx.db, {
      locationId: bed.id,
      kind: "observation",
      observedOn: "2026-10-06",
      note: "Whole-bed overview",
      pendingImageIds: [],
    });
    const otherPlanting = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: bed.id, status: "growing" },
      TEST_ACTOR,
    );
    const otherPlantingEntry = await recordGardenEntry(ctx.db, {
      locationId: bed.id,
      plantingId: otherPlanting.id,
      kind: "observation",
      observedOn: "2026-10-06",
      note: "Another tomato",
      pendingImageIds: [],
    });
    expect(
      (
        await gardenJournal(ctx.db, {
          plantingId: planned.id,
          includeBedContext: false,
          page: 1,
        })
      ).items.find((entry) => entry.id === bedOverview.id),
    ).toBeUndefined();
    expect(
      (
        await gardenJournal(ctx.db, {
          plantingId: planned.id,
          includeBedContext: true,
          page: 1,
        })
      ).items.find((entry) => entry.id === bedOverview.id),
    ).toMatchObject({ context: "bed", locationName: bed.name });
    expect(
      (
        await gardenJournal(ctx.db, {
          plantingId: planned.id,
          includeBedContext: true,
          page: 1,
        })
      ).items.find((entry) => entry.id === otherPlantingEntry.id),
    ).toBeUndefined();
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
    const moveEntry = (
      await gardenEntries(ctx.db, { plantingId: planned.id, page: 1 })
    ).items.find((entry) => entry.kind === "move");
    expect(moveEntry).toBeDefined();
    const moveEntryId = await resolveLiveShortcode(
      ctx.db,
      moveEntry!.id,
      "gardenEntry",
    );
    expect(moveEntryId).not.toBeNull();
    await expect(
      updateGardenEntryDetails(
        ctx.db,
        parseEntityId("gardenEntry", moveEntryId!),
        { observedOn: "2026-09-19" },
      ),
    ).rejects.toBeDefined();
    const bedOverviewId = await resolveLiveShortcode(
      ctx.db,
      bedOverview.id,
      "gardenEntry",
    );
    expect(bedOverviewId).not.toBeNull();
    expect(
      await updateGardenEntryDetails(
        ctx.db,
        parseEntityId("gardenEntry", bedOverviewId!),
        {
          locationId: tray.id,
          plantingId: child.id,
          observedOn: "2026-10-07",
        },
      ),
    ).toMatchObject({ locationId: tray.id, plantingId: child.id });
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
    const correctedHistory = await correctLocationDates(ctx.db, {
      plantingId: planned.id,
      periods: [
        {
          sequence: 0,
          inLocationSince: "2026-09-12",
          endedOn: "2026-09-19",
        },
        {
          sequence: 1,
          inLocationSince: "2026-09-19",
          endedOn: null,
        },
      ],
    });
    expect(correctedHistory.periods[1]).toMatchObject({
      inLocationSince: "2026-09-19",
      startKind: "actual",
    });
    await expect(
      correctLocationDates(ctx.db, {
        plantingId: planned.id,
        periods: [
          {
            sequence: 0,
            inLocationSince: "2026-09-12",
            endedOn: "2026-09-18",
          },
          {
            sequence: 1,
            inLocationSince: "2026-09-19",
            endedOn: null,
          },
        ],
      }),
    ).rejects.toBeDefined();
    expect(
      (
        await gardenEntries(ctx.db, { plantingId: planned.id, page: 1 })
      ).items.find((entry) => entry.kind === "move"),
    ).toMatchObject({ observedOn: "2026-09-19" });
    const parentId = await resolveLiveShortcode(ctx.db, planned.id, "planting");
    expect(parentId).not.toBeNull();
    const finished = await finishPlanting(ctx.db, {
      plantingId: planned.id,
      finishedOn: "2026-11-01",
    });
    expect(finished.status).toBe("finished");
    const correctedFinishedHistory = await correctLocationDates(ctx.db, {
      plantingId: planned.id,
      periods: [
        {
          sequence: 0,
          inLocationSince: "2026-09-12",
          endedOn: "2026-09-19",
        },
        {
          sequence: 1,
          inLocationSince: "2026-09-19",
          endedOn: "2026-11-02",
        },
      ],
    });
    expect(correctedFinishedHistory.periods[1]).toMatchObject({
      endedOn: "2026-11-02",
    });
    const correctedFinishedPlanting = await getDb(
      ctx.db,
    ).query.planting.findFirst({
      where: eq(planting.id, parseEntityId("planting", parentId!)),
      columns: { finishedOn: true },
    });
    expect(correctedFinishedPlanting?.finishedOn).toBe("2026-11-02");
    expect(
      (await gardenEntries(ctx.db, { plantingId: child.id, page: 1 })).items,
    ).not.toHaveLength(0);
    const childId = await resolveLiveShortcode(ctx.db, child.id, "planting");
    const trayId = await resolveLiveShortcode(ctx.db, tray.id, "location");
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

  it("rejects inverted location transitions", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Garden backfill crop" },
      TEST_ACTOR,
    );
    const tray = await location("Garden backfill tray", "tray");
    const guarded = await createPlanting(
      ctx.db,
      {
        ingredientId: crop.id,
        locationId: tray.id,
        status: "growing",
        inLocationSince: "2026-09-20",
      },
      TEST_ACTOR,
    );
    await expect(
      movePlanting(ctx.db, {
        plantingId: guarded.id,
        locationId: tray.id,
        movedOn: "2026-09-19",
      }),
    ).rejects.toBeDefined();
    await expect(
      finishPlanting(ctx.db, {
        plantingId: guarded.id,
        finishedOn: "2026-09-19",
      }),
    ).rejects.toBeDefined();
  });

  it("lets a person confirm an existing planting location without a backfill", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Garden manually confirmed crop" },
      TEST_ACTOR,
    );
    const bed = await location("Garden manually confirmed bed", "bed");
    const existing = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: bed.id, status: "growing" },
      TEST_ACTOR,
    );
    const existingId = await resolveLiveShortcode(
      ctx.db,
      existing.id,
      "planting",
    );
    expect(existingId).not.toBeNull();
    await getDb(ctx.db)
      .delete(plantingLocationPeriod)
      .where(eq(plantingLocationPeriod.plantingId, existingId!));
    const bedPhoto = await recordGardenEntry(ctx.db, {
      locationId: bed.id,
      kind: "observation",
      observedOn: "2026-09-15",
      note: "Existing bed overview",
      pendingImageIds: [],
    });
    await correctLocationDates(ctx.db, {
      plantingId: existing.id,
      periods: [{ sequence: 0, inLocationSince: "2026-09-01", endedOn: null }],
    });
    expect(
      await gardenLocationHistory(ctx.db, { plantingId: existing.id }),
    ).toMatchObject({
      periods: [
        {
          sequence: 0,
          locationId: bed.id,
          inLocationSince: "2026-09-01",
          endedOn: null,
          startKind: "actual",
        },
      ],
    });
    expect(
      (
        await gardenJournal(ctx.db, {
          plantingId: existing.id,
          includeBedContext: true,
          page: 1,
        })
      ).items.find((entry) => entry.id === bedPhoto.id),
    ).toMatchObject({ context: "bed" });
    const planned = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, status: "planned" },
      TEST_ACTOR,
    );
    await expect(
      correctLocationDates(ctx.db, {
        plantingId: planned.id,
        periods: [
          { sequence: 0, inLocationSince: "2026-09-01", endedOn: null },
        ],
      }),
    ).rejects.toBeDefined();
    const moved = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, status: "planned" },
      TEST_ACTOR,
    );
    await startPlanting(ctx.db, {
      plantingId: moved.id,
      locationId: bed.id,
      startedOn: "2026-09-10",
      startMethod: "sow",
    });
    await movePlanting(ctx.db, {
      plantingId: moved.id,
      locationId: bed.id,
      movedOn: "2026-09-20",
    });
    const movedId = await resolveLiveShortcode(ctx.db, moved.id, "planting");
    expect(movedId).not.toBeNull();
    await getDb(ctx.db)
      .delete(plantingLocationPeriod)
      .where(eq(plantingLocationPeriod.plantingId, movedId!));
    await expect(
      correctLocationDates(ctx.db, {
        plantingId: moved.id,
        periods: [
          { sequence: 0, inLocationSince: "2026-09-19", endedOn: null },
        ],
      }),
    ).rejects.toBeDefined();
    const finished = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: bed.id, status: "growing" },
      TEST_ACTOR,
    );
    const finishedId = await resolveLiveShortcode(
      ctx.db,
      finished.id,
      "planting",
    );
    expect(finishedId).not.toBeNull();
    await getDb(ctx.db)
      .delete(plantingLocationPeriod)
      .where(eq(plantingLocationPeriod.plantingId, finishedId!));
    await finishPlanting(ctx.db, {
      plantingId: finished.id,
      finishedOn: "2026-10-01",
    });
    await expect(
      correctLocationDates(ctx.db, {
        plantingId: finished.id,
        periods: [
          { sequence: 0, inLocationSince: "2026-09-01", endedOn: null },
        ],
      }),
    ).rejects.toBeDefined();
  });

  it("removes internal periods only when planting deletion can complete", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Garden deletion crop" },
      TEST_ACTOR,
    );
    const bed = await location("Garden deletion bed", "bed");
    const deletable = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: bed.id, status: "growing" },
      TEST_ACTOR,
    );
    const deletableId = await resolveLiveShortcode(
      ctx.db,
      deletable.id,
      "planting",
    );
    expect(deletableId).not.toBeNull();
    await plantingEntityAdapter.repository.delete(
      plantingDeleteContext(ctx.db),
      [deletable.id],
    );
    expect(
      await getDb(ctx.db).query.plantingLocationPeriod.findMany({
        where: eq(
          plantingLocationPeriod.plantingId,
          parseEntityId("planting", deletableId!),
        ),
      }),
    ).toHaveLength(0);
    const blocked = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: bed.id, status: "growing" },
      TEST_ACTOR,
    );
    const blockedId = await resolveLiveShortcode(
      ctx.db,
      blocked.id,
      "planting",
    );
    expect(blockedId).not.toBeNull();
    await recordGardenEntry(ctx.db, {
      locationId: bed.id,
      plantingId: blocked.id,
      kind: "observation",
      observedOn: "2026-09-12",
      note: "Retained garden history",
      pendingImageIds: [],
    });
    await expect(
      plantingEntityAdapter.repository.delete(plantingDeleteContext(ctx.db), [
        blocked.id,
      ]),
    ).rejects.toBeDefined();
    expect(
      await getDb(ctx.db).query.plantingLocationPeriod.findMany({
        where: eq(
          plantingLocationPeriod.plantingId,
          parseEntityId("planting", blockedId!),
        ),
      }),
    ).toHaveLength(1);
  });
});
