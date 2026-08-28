import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(import.meta.dirname, path), "utf8");

describe("Problems read architecture", () => {
  it("does not smuggle execution modes through pagination", () => {
    const files = [
      "problem-views.service.ts",
      "../repo/database-helpers/query.ts",
      "../repo/expense/lookup.ts",
      "../repo/financial-transaction.ts",
      "../repo/image.ts",
      "../repo/ingredient/search.ts",
      "../repo/inventory/crud.ts",
      "../repo/location/crud.ts",
      "../repo/meal/crud.ts",
      "../repo/product/crud.ts",
      "../repo/project/lookup.ts",
      "../repo/purchase.ts",
      "../repo/recipe/crud.ts",
      "../repo/task/lookup.ts",
      "../repo/vendor.ts",
    ];
    const forbidden = [
      ["count", "Only"].join(""),
      ["skip", "ListAggregates"].join(""),
      ["is", "CountOnlyPagination"].join(""),
      ["skips", "ListAggregates"].join(""),
    ];

    for (const file of files) {
      const source = read(file);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      for (const token of forbidden) expect(source, file).not.toContain(token);
    }
  });

  it("keeps heterogeneous entity readers behind explicit adapters", () => {
    const source = read("problem-views.service.ts");
    expect(source).toContain("const ENTITY_READERS");
    expect(source).not.toContain("as unknown as Partial<Record<Entity");
  });
});
