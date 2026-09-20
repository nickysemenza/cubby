import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { gardenEntryPlanting } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

const ctx = withTestDb();
const cutoverSql = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../../scripts/cutovers/garden-entry-plantings.sql",
  ),
  "utf8",
);

describe("Garden Entry planting cutover", () => {
  it("backfills live and deleted legacy pairs, is rerunnable, and refuses mismatch", async () => {
    const location = await insertWithShortcode(ctx.db, "location", {
      name: "Cutover Garden Bed",
      type: "room",
    });
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Cutover Crop",
    });
    const planting = await insertWithShortcode(ctx.db, "planting", {
      ingredientId: ingredient.id,
      locationId: location.id,
      status: "growing",
    });
    const liveEntry = await insertWithShortcode(ctx.db, "gardenEntry", {
      locationId: location.id,
      observedOn: "2026-05-01",
    });
    const deletedEntry = await insertWithShortcode(ctx.db, "gardenEntry", {
      locationId: location.id,
      observedOn: "2026-05-02",
    });

    // The additive schema keeps this column only for the coordinated cutover;
    // this test creates the pre-cutover shape inside its isolated database.
    await getDb(ctx.db).execute(
      sql`ALTER TABLE "GardenEntry" ADD COLUMN "plantingId" uuid`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "GardenEntry" SET "plantingId" = ${planting.id} WHERE "id" = ${liveEntry.id}`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "GardenEntry"
          SET "plantingId" = ${planting.id}, "deletedAt" = ${new Date()}
          WHERE "id" = ${deletedEntry.id}`,
    );

    await getDb(ctx.db).execute(sql.raw(cutoverSql));

    const firstRows = await getDb(ctx.db)
      .select({
        gardenEntryId: gardenEntryPlanting.gardenEntryId,
        plantingId: gardenEntryPlanting.plantingId,
        deletedAt: gardenEntryPlanting.deletedAt,
      })
      .from(gardenEntryPlanting)
      .where(
        and(
          eq(
            gardenEntryPlanting.plantingId,
            parseEntityId("planting", planting.id),
          ),
          inArray(gardenEntryPlanting.gardenEntryId, [
            parseEntityId("gardenEntry", liveEntry.id),
            parseEntityId("gardenEntry", deletedEntry.id),
          ]),
        ),
      );
    expect(firstRows).toHaveLength(2);
    expect(
      firstRows.find((row) => row.gardenEntryId === liveEntry.id)?.deletedAt,
    ).toBeNull();
    expect(
      firstRows.find((row) => row.gardenEntryId === deletedEntry.id)?.deletedAt,
    ).not.toBeNull();

    const rowCountBeforeRerun = await getDb(ctx.db)
      .select({ id: gardenEntryPlanting.id })
      .from(gardenEntryPlanting);
    await getDb(ctx.db).execute(sql.raw(cutoverSql));
    const rowCountAfterRerun = await getDb(ctx.db)
      .select({ id: gardenEntryPlanting.id })
      .from(gardenEntryPlanting);
    expect(rowCountAfterRerun).toHaveLength(rowCountBeforeRerun.length);

    // The script must reject a pair whose association liveness no longer
    // matches the legacy source instead of silently declaring the cutover safe.
    await getDb(ctx.db)
      .update(gardenEntryPlanting)
      .set({ deletedAt: null })
      .where(
        eq(
          gardenEntryPlanting.gardenEntryId,
          parseEntityId("gardenEntry", deletedEntry.id),
        ),
      );
    await expect(getDb(ctx.db).execute(sql.raw(cutoverSql))).rejects.toThrow(
      /verification failed/u,
    );
  });
});
