import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getSpendingCategoryByShortcode } from "~/server/domains/spending-category/repo/spending-category";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { loadCategoryConnections } from "./category-connections";
import { listProductCategories } from "./product-category";

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
    const reverse = await getSpendingCategoryByShortcode(
      ctx.db,
      spending.shortcode,
    );
    const reverseCategories = reverse?.productCategories;
    if (!reverseCategories)
      throw new Error("Synthetic category reverse links missing");
    expect(new Set(reverseCategories.map((category) => category.id))).toEqual(
      new Set([root.shortcode, child.shortcode]),
    );
    expect(reverseCategories).toContainEqual(
      expect.objectContaining({
        id: child.shortcode,
        name: "Fixture food > Fixture vegetables (inherited)",
        inherited: true,
      }),
    );
    const filtered = await listProductCategories(
      ctx.db,
      { effectiveSpendingCategoryId: [spending.shortcode] },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(new Set(filtered.data.map((category) => category.id))).toEqual(
      new Set([root.shortcode, child.shortcode]),
    );
  });
});
