import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getFilterOptions } from "./filter-options";
import { createIngredient } from "./ingredient";

describe("entity reference filter options", () => {
  const ctx = withTestDb();

  it("searches live shortcode entities and hydrates selected values outside the page query", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Selected winter squash" },
      TEST_ACTOR,
    );
    await createIngredient(
      ctx.db,
      { name: "Unrelated summer herb" },
      TEST_ACTOR,
    );

    const searched = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ingredient",
      search: "winter squash",
      selectedIds: [],
      limit: 25,
    });
    expect(searched.items).toEqual([
      { id: crop.id, label: "Selected winter squash" },
    ]);

    const hydrated = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ingredient",
      search: "no page match",
      selectedIds: [crop.id],
      limit: 25,
    });
    expect(hydrated.items).toEqual([
      { id: crop.id, label: "Selected winter squash" },
    ]);
  });
});
