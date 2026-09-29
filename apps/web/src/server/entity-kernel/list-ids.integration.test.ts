import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * `filters.ids` restricts a kernel list to named rows. Failure modes: the
 * restriction pages the whole repository to find a handful of rows (the
 * statement count grows with the table), or it drops the requested order,
 * paging or casing rules.
 */
describe("kernel list restricted to ids", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  const listIds = (ids: string[], pageIndex = 0) =>
    executeEntity(context(), {
      action: "list",
      entity: "ingredient",
      filters: { ids },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex, pageSize: 1 },
    });

  it("reads only the named rows, in list order, however large the table", async () => {
    const wanted = await Promise.all(
      ["Ids alpha", "Ids beta"].map((name) =>
        findOrCreateIngredient(ctx.db, name),
      ),
    );
    const codes = wanted.map((row) => row.shortcode);
    const small = await countTestDbQueries(() => listIds(codes));

    for (let index = 0; index < 120; index += 1)
      await findOrCreateIngredient(ctx.db, `Ids filler ${index}`);
    const large = await countTestDbQueries(() => listIds(codes));
    const second = await listIds(
      codes.map((code) => code.toLowerCase()),
      1,
    );

    for (const result of [small.result, large.result, second]) {
      if (result.action !== "list") throw new Error("expected list");
      expect(result.meta.totalCount).toBe(2);
    }
    if (large.result.action !== "list" || second.action !== "list")
      throw new Error("expected list");
    expect(large.result.items.map((row) => row.name)).toEqual(["Ids alpha"]);
    expect(second.items.map((row) => row.name)).toEqual(["Ids beta"]);
    expect(large.queryCount).toBe(small.queryCount);
  });
});
