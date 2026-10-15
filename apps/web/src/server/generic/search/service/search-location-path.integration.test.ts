import {
  TEST_HOME_ID,
  TEST_HOME_SHORTCODE,
  withTestDb,
} from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

import { findSearchHits } from "./search.service";

describe("search labels and location paths", () => {
  const ctx = withTestDb();

  // Current garden notes must not fall through a retired observation/move label.
  it("indexes a garden note with its declared kind label", async () => {
    const entry = await insertWithShortcode(ctx.db, "gardenEntry", {
      kind: "note",
      observedOn: "2026-10-06",
      locationId: TEST_HOME_ID,
      notes: "Synthetic garden journal",
    });
    await refreshSearchDocument(ctx.db, "gardenEntry", entry.id);
    const hits = await findSearchHits(ctx.db, {
      query: "Synthetic garden journal",
      entityKinds: ["gardenEntry"],
      limit: 10,
    });
    expect(hits.find((item) => item.id === entry.shortcode)?.title).toBe(
      "Note · 2026-10-06 · Home",
    );
  });

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
      entityKinds: ["location"],
      limit: 10,
    });
    const hit = hits.find((item) => item.id === child.id);
    expect(hit?.locationPath).toEqual([
      { id: TEST_HOME_SHORTCODE, name: "Home" },
      { id: parent.id, name: "Synthetic instrument room" },
    ]);
  });
});
