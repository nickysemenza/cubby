import type { LocationCreateInput } from "@cubby/schemas/location";
import { TEST_ACTOR, TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  LOCATION_DESCRIPTION_FEATURE,
  buildLocationAnalysisFingerprint,
} from "~/server/ai/features";
import { upsertAiAnalysis } from "~/server/repo/ai-analysis";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  getLocationById,
  locationList,
  updateLocation,
  updateLocationAiDescription,
} from "./index";

const page = { pageIndex: 0, pageSize: 50 };

/**
 * `Location.type` is NOT NULL (a Product-instance location is `furniture`),
 * `Location.aiDescription` is the latest live `location-description`
 * AiAnalysis rather than a column, and stock of a furniture location's own
 * Product is flagged as double counting.
 */
/** A create input with no `type`: a Product link alone must yield `furniture`. */
const productInstanceInput = (
  name: string,
  productId: LocationCreateInput["productId"],
) => {
  const { type: _type, ...input } = makeLocationInput({ name, productId });
  return input;
};

describe("location shape", () => {
  const ctx = withTestDb();

  const describeWith = async (
    locationId: Parameters<typeof getLocationById>[1],
    name: string,
    description: string,
  ) =>
    upsertAiAnalysis(
      ctx.db,
      {
        entityKind: "location",
        entityId: locationId,
        feature: LOCATION_DESCRIPTION_FEATURE,
        inputFingerprint: buildLocationAnalysisFingerprint(
          LOCATION_DESCRIPTION_FEATURE,
          { locationName: name, images: [] },
        ),
      },
      { description, confidence: "high" },
    );

  it("takes the AI description from the latest live location-description analysis", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Described shelf", type: "shelf" }),
      ctx.actor,
    );
    expect((await getLocationById(ctx.db, shelf.entityId)).aiDescription).toBe(
      null,
    );

    await describeWith(shelf.entityId, "Described shelf", "Cans on the left.");
    expect((await getLocationById(ctx.db, shelf.entityId)).aiDescription).toBe(
      "Cans on the left.",
    );
    const listed = await locationList(
      ctx.db,
      { aiDescriptionPresenceFilter: "has" },
      [],
      page,
    );
    const row = listed.data.find((item) => item.id === shelf.id);
    expect(row?.aiDescription).toBe("Cans on the left.");

    const undescribed = await locationList(
      ctx.db,
      { aiDescriptionPresenceFilter: "none" },
      [],
      page,
    );
    expect(undescribed.data.map((item) => item.id)).not.toContain(shelf.id);

    // Removing the last photo retires the description; nothing left to say.
    await updateLocationAiDescription(ctx.db, shelf.entityId, null);
    expect((await getLocationById(ctx.db, shelf.entityId)).aiDescription).toBe(
      null,
    );
  });

  it("stores furniture for a Product-linked location and refuses it without a Product", async () => {
    const crate = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Shape Crate" }),
      ctx.actor,
    );
    const linked = await createLocationFixture(
      ctx.db,
      productInstanceInput("Crate A", crate.id),
      ctx.actor,
    );
    expect(linked.type).toBe("furniture");

    // A bed or planter may link a Product and keep its own type.
    const bed = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Raised bed",
        type: "bed",
        productId: crate.id,
      }),
      ctx.actor,
    );
    expect(bed.type).toBe("bed");

    await expect(
      updateLocation(ctx.db, linked.entityId, { productId: null }, TEST_ACTOR),
    ).rejects.toThrow(/furniture location is an instance of a Product/u);

    await expect(
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Bare furniture", type: "furniture" }),
        ctx.actor,
      ),
    ).rejects.toThrow(/furniture location is an instance of a Product/u);

    // The database refuses it too, whatever path wrote the row.
    await expect(
      insertWithShortcode(ctx.db, "location", {
        name: "Orphan furniture",
        type: "furniture",
        parentId: TEST_HOME_ID,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "Location_furniture_product_check" },
    });
  });

  it("flags a furniture location whose Product also has live inventory", async () => {
    const [crate, other] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Double Crate" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Single Crate" }),
        ctx.actor,
      ),
    ]);
    const [doubled, single, garage] = await Promise.all([
      createLocationFixture(
        ctx.db,
        productInstanceInput("Doubled crate", crate.id),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        productInstanceInput("Single crate", other.id),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Garage", type: "room" }),
        ctx.actor,
      ),
    ]);
    await createInventoryFixture(
      ctx.db,
      {
        productId: crate.id,
        locationId: garage.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const qualities = await loadDataQualities(ctx.db, "location", [
      doubled.entityId,
      single.entityId,
    ]);
    expect(
      qualities.get(doubled.entityId)?.gaps.map((gap) => gap.check),
    ).toContain("location_furniture_counted");
    expect(
      qualities.get(single.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("location_furniture_counted");
  });
});
