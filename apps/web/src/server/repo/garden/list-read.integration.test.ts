import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createGardenEntry,
  createPlanting,
  gardenEntryList,
  gardenEntryListRead,
  plantingList,
  plantingListRead,
} from ".";
import {
  createLocationFixture,
  createPlantFixture,
  makeLocationInput,
} from "../repo.fixtures";

describe("progressive garden lists", () => {
  const ctx = withTestDb();

  it("retains core titles while skipping guide, quality, media and association work", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      {
        name: "Synthetic progressive crop",
        daysFromSowMin: 30,
        daysFromSowMax: 45,
      },
      ctx.actor,
    );
    const bed = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic progressive bed",
        type: "bed",
      }),
      ctx.actor,
    );
    const planted = await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        locationId: bed.id,
        sowedOn: "2026-01-01",
        status: "growing",
      },
      ctx.actor,
    );
    const entry = await createGardenEntry(
      ctx.db,
      {
        locationId: bed.id,
        plantingIds: [planted.id],
        kind: "note",
        observedOn: "2026-01-02",
      },
      ctx.actor,
    );
    const pagination = { pageIndex: 0, pageSize: 25 };
    const fullPlantings = await plantingList(ctx.db, {}, pagination);
    const corePlantings = await countTestDbQueries(() =>
      plantingListRead(ctx.db, {}, pagination, [], { kind: "base" }),
    );
    expect(corePlantings.queryCount).toBe(2);
    expect(corePlantings.result.data[0]).toMatchObject({
      id: planted.id,
      displayName: fullPlantings.data[0]?.displayName,
    });
    expect(corePlantings.result.data[0]).not.toHaveProperty("plantId");
    expect(corePlantings.result.data[0]).not.toHaveProperty("guideSowWindow");
    expect(corePlantings.result.data[0]).not.toHaveProperty("dataQuality");
    const harvest = await countTestDbQueries(() =>
      plantingListRead(ctx.db, {}, pagination, [], {
        kind: "enrichment",
        groups: ["derived"],
      }),
    );
    expect(harvest.queryCount).toBe(2);
    expect(harvest.result.data[0]).toEqual({
      id: planted.id,
      expectedHarvestStart: fullPlantings.data[0]?.expectedHarvestStart,
      expectedHarvestEnd: fullPlantings.data[0]?.expectedHarvestEnd,
      expectedHarvest: fullPlantings.data[0]?.expectedHarvest,
      guideSowWindow: fullPlantings.data[0]?.guideSowWindow,
      guideTransplantWindow: fullPlantings.data[0]?.guideTransplantWindow,
    });
    expect(harvest.result.data[0]?.expectedHarvestStart).toBe("2026-01-31");

    const fullEntries = await gardenEntryList(ctx.db, {}, pagination);
    const coreEntries = await countTestDbQueries(() =>
      gardenEntryListRead(ctx.db, {}, pagination, [], { kind: "base" }),
    );
    expect(coreEntries.queryCount).toBe(2);
    expect(coreEntries.result.data[0]).toMatchObject({
      id: entry.id,
      displayName: fullEntries.data[0]?.displayName,
    });
    expect(coreEntries.result.data[0]).not.toHaveProperty("plantingIds");
    expect(coreEntries.result.data[0]).not.toHaveProperty("images");
    expect(coreEntries.result.data[0]).not.toHaveProperty("locationId");
    const references = await countTestDbQueries(() =>
      gardenEntryListRead(ctx.db, {}, pagination, [], {
        kind: "enrichment",
        groups: ["relations"],
      }),
    );
    expect(references.queryCount).toBe(3);
    expect(references.result.data[0]).toEqual({
      id: entry.id,
      locationId: bed.id,
      locationName: bed.name,
      plantingIds: [planted.id],
      plantings: [{ id: planted.id, name: fullPlantings.data[0]?.displayName }],
    });
  });
});
