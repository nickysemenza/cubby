import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { loadCategoryConnections } from "./category-connections";
import { insertWithShortcode } from "./shortcode-utils";

// Failure modes: inherited mappings disappear, a blocked descendant leaks into reverse links,
// or mapping identity is reduced to a shortcode instead of its name and source.
describe("effective category connections", () => {
  const ctx = withTestDb();
  it("preserves inherited identity and excludes blocked descendants", async () => {
    const spending = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture groceries",
      emoji: "🥕",
    });
    const root = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture food",
      spendingCategoryMode: "mapped",
      spendingCategoryId: spending.id,
    });
    const child = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture vegetables",
      parentId: root.id,
    });
    const blocked = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Fixture unresolved",
      parentId: root.id,
      spendingCategoryMode: "blocked",
    });
    const links = await loadCategoryConnections(ctx.db, [
      root.id,
      child.id,
      blocked.id,
    ]);
    expect(links.get(child.id)).toMatchObject({
      category: {
        id: spending.shortcode,
        name: "Fixture groceries",
        emoji: "🥕",
      },
      state: "inherited",
      source: { id: root.shortcode },
    });
    expect(links.get(blocked.id)).toMatchObject({
      category: null,
      state: "blocked",
    });
  });
});
