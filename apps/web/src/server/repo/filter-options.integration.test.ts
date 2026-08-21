import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getFilterOptions } from "~/server/repo/filter-options";
import { createProduct } from "~/server/repo/product";
import { makeProductInput } from "~/server/repo/repo.fixtures";

describe("filter option repository", () => {
  const ctx = withTestDb();

  it("returns minimal searched pages and retains selected ids outside the page", async () => {
    const alpha = await createProduct(
      ctx.db,
      makeProductInput({ name: "Option Alpha", manufacturer: "Maker A" }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Option Beta", manufacturer: "Maker B" }),
      ctx.actor,
    );
    const gamma = await createProduct(
      ctx.db,
      makeProductInput({ name: "Option Gamma", manufacturer: "Maker C" }),
      ctx.actor,
    );

    const result = await getFilterOptions(ctx.db, {
      kind: "product",
      search: "Option",
      selectedIds: [gamma.id],
      limit: 1,
    });

    expect(result.nextCursor).toBe("1");
    expect(result.items).toEqual([
      { id: alpha.id, label: "Option Alpha", detail: "Maker A" },
      { id: gamma.id, label: "Option Gamma", detail: "Maker C" },
    ]);
    expect(Object.keys(result.items[0] ?? {}).sort()).toEqual([
      "detail",
      "id",
      "label",
    ]);
  });
});
