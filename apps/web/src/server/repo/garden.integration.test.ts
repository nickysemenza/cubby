import { taskCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { gardenEntry, planting } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { getAuditLog } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import {
  createGardenEntry,
  createPlanting,
  gardenEntryList,
  plantingList,
  updatePlanting,
} from "~/server/repo/garden";
import { plantingEntityAdapter } from "~/server/repo/garden/entity-adapters";
import { createIngredient } from "~/server/repo/ingredient";
import { createLocation } from "~/server/repo/location";
import { makeLocationInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTask } from "~/server/repo/task/crud";
import { taskEntityAdapter } from "~/server/repo/task/entity-adapter";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("garden workflows", () => {
  const ctx = withTestDb();

  // Adapter deletes run inside the kernel wrapper, which binds every service
  // to the write transaction — so the context must carry real services.
  const kernelContext = (db: Database) =>
    entityKernelContextSchema.parse(
      createTestRequestContext(db, { auth: { userId: ctx.actor.userId } }),
    );

  const bed = (name: string) =>
    createLocation(
      ctx.db,
      makeLocationInput({ name, type: "bed" }),
      TEST_ACTOR,
    );

  // Before the shared list-scaffold rewrite, both lists only ever read
  // `sorts[0]` — `plantingList` ignored a second sort column entirely, and
  // `gardenEntryList` additionally appended a hard-coded `createdAt desc`
  // that could reverse an explicit second-column request. Each case body is
  // its own top-level (non-conditional) function so every `expect` call
  // stays unconditional; `it.each` below still drives both from one table.
  const plantingSortCase = async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Garden sort crop" },
      TEST_ACTOR,
    );
    const location = await bed("Garden sort bed");
    const first = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );
    const second = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );
    const firstId = await resolveLiveShortcode(ctx.db, first.id, "planting");
    const secondId = await resolveLiveShortcode(ctx.db, second.id, "planting");
    // Force a tie on the primary sort column (createdAt) — `updatedAt`, the
    // second requested sort column, must be what decides order.
    const tiedCreatedAt = new Date("2026-01-01T00:00:00Z");
    await getDb(ctx.db)
      .update(planting)
      .set({
        createdAt: tiedCreatedAt,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .where(eq(planting.id, firstId!));
    await getDb(ctx.db)
      .update(planting)
      .set({
        createdAt: tiedCreatedAt,
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      })
      .where(eq(planting.id, secondId!));

    const { data } = await plantingList(
      ctx.db,
      {},
      { pageIndex: 0, pageSize: 200 },
      [
        { orderBy: "createdAt", direction: "asc" },
        { orderBy: "updatedAt", direction: "desc" },
      ],
    );
    const ids = data.map((row) => row.id);
    expect(ids.indexOf(first.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(second.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  };

  const gardenEntrySortCase = async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Garden entry sort crop" },
      TEST_ACTOR,
    );
    const location = await bed("Garden entry sort bed");
    const sowed = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );
    // Same `observedOn` for both — the primary sort column ties, so the
    // second requested column (`createdAt`) must decide order.
    const observedOn = "2026-06-01";
    const firstEntry = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: sowed.id,
        kind: "note",
        observedOn,
        note: "First same-day entry",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const secondEntry = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: sowed.id,
        kind: "note",
        observedOn,
        note: "Second same-day entry",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );

    const { data } = await gardenEntryList(
      ctx.db,
      {},
      { pageIndex: 0, pageSize: 200 },
      [
        { orderBy: "observedOn", direction: "asc" },
        { orderBy: "createdAt", direction: "asc" },
      ],
    );
    const ids = data.map((row) => row.id);
    expect(ids.indexOf(firstEntry.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(secondEntry.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(firstEntry.id)).toBeLessThan(
      ids.indexOf(secondEntry.id),
    );
  };

  it.each([
    { label: "planting", case: plantingSortCase },
    { label: "gardenEntry", case: gardenEntrySortCase },
  ])(
    "$label list honors a two-column sort, not just sorts[0]",
    async ({ case: run }) => {
      expect.hasAssertions();
      await run();
    },
  );

  it("journalPlantingId includes direct entries and in-window whole-area entries, excluding out-of-window and other-location entries", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Journal predicate crop" },
      TEST_ACTOR,
    );
    const location = await bed("Journal predicate bed");
    const otherLocation = await bed("Journal predicate other bed");
    const target = await createPlanting(
      ctx.db,
      {
        ingredientId: crop.id,
        locationId: location.id,
        status: "finished",
        sowedOn: "2026-04-01",
        finishedOn: "2026-06-01",
      },
      TEST_ACTOR,
    );

    const direct = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: target.id,
        kind: "note",
        observedOn: "2026-05-01",
        note: "Direct note",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const inWindowWholeArea = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: null,
        kind: "note",
        observedOn: "2026-05-15",
        note: "Whole-bed note in window",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const preStart = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: null,
        kind: "note",
        observedOn: "2026-03-01",
        note: "Whole-bed note before sowing",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const postFinish = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: null,
        kind: "note",
        observedOn: "2026-07-01",
        note: "Whole-bed note after finishing",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const otherBedEntry = await createGardenEntry(
      ctx.db,
      {
        locationId: otherLocation.id,
        plantingId: null,
        kind: "note",
        observedOn: "2026-05-15",
        note: "Other bed note",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );

    const { data } = await gardenEntryList(
      ctx.db,
      { journalPlantingId: target.id },
      { pageIndex: 0, pageSize: 50 },
      [],
    );
    const ids = new Set(data.map((row) => row.id));
    expect(ids.has(direct.id)).toBe(true);
    expect(ids.has(inWindowWholeArea.id)).toBe(true);
    expect(ids.has(preStart.id)).toBe(false);
    expect(ids.has(postFinish.id)).toBe(false);
    expect(ids.has(otherBedEntry.id)).toBe(false);
  });

  it("deleting a planting detaches its garden entries with an audit entry, rather than blocking", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Planting delete detach crop" },
      TEST_ACTOR,
    );
    const location = await bed("Planting delete detach bed");
    const target = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );
    const entry = await createGardenEntry(
      ctx.db,
      {
        locationId: location.id,
        plantingId: target.id,
        kind: "note",
        observedOn: "2026-05-01",
        note: "Kept on delete",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );

    const result = await plantingEntityAdapter.repository.delete(
      kernelContext(ctx.db),
      [target.id],
    );
    expect(result.affectedEdges).toContainEqual(
      expect.objectContaining({
        edge: "GardenEntry.plantingId",
        effect: "detach",
        changed: 1,
      }),
    );

    const entryId = await resolveLiveShortcode(ctx.db, entry.id, "gardenEntry");
    expect(entryId).not.toBeNull();
    const row = await getDb(ctx.db).query.gardenEntry.findFirst({
      where: eq(gardenEntry.id, entryId!),
      columns: { plantingId: true, deletedAt: true },
    });
    expect(row).toMatchObject({ plantingId: null, deletedAt: null });

    const audit = await getAuditLog(ctx.db, {
      entityType: "gardenEntry",
      entityIds: [entryId!],
      limit: 10,
    });
    expect(audit.entries[0]).toMatchObject({
      action: "update",
      changes: { plantingId: { to: null } },
    });
  });

  it("deleting a task detaches its plantings, reporting the Planting.taskId edge", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Task delete detach crop" },
      TEST_ACTOR,
    );
    const task = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "Task delete detach task",
      }),
      TEST_ACTOR,
    );
    const planted = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, status: "planned", taskId: task.output.id },
      TEST_ACTOR,
    );

    const result = await taskEntityAdapter.repository.delete(
      kernelContext(ctx.db),
      [task.output.id],
    );
    expect(result.affectedEdges).toContainEqual(
      expect.objectContaining({
        edge: "Planting.taskId",
        effect: "detach",
        changed: 1,
      }),
    );

    const plantedId = await resolveLiveShortcode(
      ctx.db,
      planted.id,
      "planting",
    );
    expect(plantedId).not.toBeNull();
    const row = await getDb(ctx.db).query.planting.findFirst({
      where: eq(planting.id, plantedId!),
      columns: { taskId: true, deletedAt: true },
    });
    expect(row).toMatchObject({ taskId: null, deletedAt: null });

    const audit = await getAuditLog(ctx.db, {
      entityType: "planting",
      entityIds: [plantedId!],
      limit: 10,
    });
    expect(audit.entries[0]).toMatchObject({
      action: "update",
      changes: { taskId: { to: null } },
    });
  });

  it("updatePlanting records audit changes on a locationId edit", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Update audit crop" },
      TEST_ACTOR,
    );
    const bedA = await bed("Update audit bed A");
    const bedB = await bed("Update audit bed B");
    const planted = await createPlanting(
      ctx.db,
      { ingredientId: crop.id, locationId: bedA.id, status: "growing" },
      TEST_ACTOR,
    );
    const plantedId = await resolveLiveShortcode(
      ctx.db,
      planted.id,
      "planting",
    );
    expect(plantedId).not.toBeNull();

    await updatePlanting(
      ctx.db,
      plantedId!,
      { locationId: bedB.id },
      TEST_ACTOR,
    );

    const audit = await getAuditLog(ctx.db, {
      entityType: "planting",
      entityIds: [plantedId!],
      limit: 10,
    });
    const updateEntry = audit.entries.find(
      (entry) => entry.action === "update",
    );
    // `changes` values are remapped from raw uuids to public shortcodes for
    // FK-shaped fields (`EDGE_KEY_TARGET_ENTITY`), so `to` reads as `bedB.id`
    // rather than an opaque uuid.
    expect(updateEntry?.changes).toMatchObject({
      locationId: { from: bedA.id, to: bedB.id },
    });
  });
});
