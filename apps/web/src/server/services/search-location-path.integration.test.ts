import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocument } from "~/server/repo/search-document";

import { findSearchHits } from "./search.service";

describe("location search paths", () => {
  const ctx = withTestDb();

  it("returns root-first structured ancestors for a typed location hit", async () => {
    const parent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic instrument room" }),
      ctx.actor,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic brass shelf",
        parentId: parent.id,
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", child.entityId);

    const hits = await findSearchHits(ctx.db, {
      query: "Synthetic brass shelf",
      entityTypes: ["location"],
      limit: 10,
    });
    const hit = hits.find((item) => item.id === child.id);
    expect(hit?.locationPath).toEqual([
      { id: TEST_HOME_SHORTCODE, name: "Home" },
      { id: parent.id, name: "Synthetic instrument room" },
    ]);
  });
});
