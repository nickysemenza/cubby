import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { parseEntityTimelineInput } from "~/entities/generated/entity-timelines.gen";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createLocation } from "~/server/repo/location";
import {
  createPlantFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { createPlanting } from ".";
import { plantingTimeline } from "./timeline";

/**
 * `tomato`'s `sunny` window (the household microclimate) has a transplant
 * band; picking a guide key with a real window keeps these cases from
 * silently passing on an empty band list.
 */
const GUIDE_KEY_WITH_WINDOW = "tomato";

describe("plantingTimeline guide bands", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  const bed = (name: string) =>
    createLocation(
      ctx.db,
      makeLocationInput({ name, type: "bed" }),
      TEST_ACTOR,
    );

  const timelineFor = async (shortcode: string) =>
    plantingTimeline(
      context(),
      parseEntityTimelineInput("planting", {
        entity: "planting",
        filters: {},
        window: { ids: [shortcode] },
      }),
    );

  const guideRowIds = (rows: readonly { id: string }[] | undefined) =>
    (rows ?? []).map((row) => row.id).filter((id) => id.startsWith("guide-"));

  it.each([
    { status: "growing" as const, expectBand: true },
    { status: "planned" as const, expectBand: true },
    { status: "finished" as const, expectBand: false },
  ])(
    "$status planting with a guide: band present = $expectBand",
    async ({ status, expectBand }) => {
      const crop = await createPlantFixture(
        ctx.db,
        {
          name: `Guide band crop ${status}`,
          gardenGuideKey: GUIDE_KEY_WITH_WINDOW,
        },
        TEST_ACTOR,
      );
      const location = await bed(`Guide band bed ${status}`);
      const input = {
        plantId: crop.id,
        locationId: location.id,
        status,
        sowedOn: status === "finished" ? "2026-01-01" : null,
        finishedOn: status === "finished" ? "2026-02-01" : null,
      };
      const planted = await createPlanting(ctx.db, input, TEST_ACTOR);

      const out = await timelineFor(planted.id);
      expect(guideRowIds(out.rows).length > 0).toBe(expectBand);
    },
  );

  it("emits no guide band for a planting whose plant has no garden guide key", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "No guide crop" },
      TEST_ACTOR,
    );
    const location = await bed("No guide bed");
    const planted = await createPlanting(
      ctx.db,
      { plantId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );

    const out = await timelineFor(planted.id);
    expect(guideRowIds(out.rows)).toEqual([]);
  });

  it("cohort respects window.ids: a guide band only appears for the requested planting, not a sibling in the same bed", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "Cohort guide crop", gardenGuideKey: GUIDE_KEY_WITH_WINDOW },
      TEST_ACTOR,
    );
    const location = await bed("Cohort guide bed");
    const inScope = await createPlanting(
      ctx.db,
      { plantId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );
    await createPlanting(
      ctx.db,
      { plantId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );

    const out = await timelineFor(inScope.id);
    const ids = guideRowIds(out.rows);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.endsWith(`:${inScope.id}`)).toBe(true);
  });

  it("keeps each guide row's synthetic identity while linking it to its planting", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "Guide link crop", gardenGuideKey: GUIDE_KEY_WITH_WINDOW },
      TEST_ACTOR,
    );
    const location = await bed("Guide link bed");
    const planted = await createPlanting(
      ctx.db,
      { plantId: crop.id, locationId: location.id, status: "growing" },
      TEST_ACTOR,
    );

    const rows = (await timelineFor(planted.id)).rows ?? [];
    const guideRows = rows.filter((row) => row.id.startsWith("guide-"));
    expect(guideRows.length).toBeGreaterThan(0);
    for (const row of guideRows) {
      expect(row.id).toMatch(
        new RegExp(`^guide-(sow|transplant):${planted.id}$`),
      );
      expect(row.link).toEqual({ entity: "planting", id: planted.id });
    }
  });
});
