import type { TaskFilters } from "@cubby/schemas/project";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { task } from "~/server/db/schema";
import { renderWhereSql } from "~/server/testing/mock-db";

import { ListContext } from "./field-compiler";
import { declaredFilterPredicates } from "./list";

describe("declaredFilterPredicates", () => {
  it("compiles task trade over the declared effective trade, not the column", () => {
    const defined = (filters: Partial<TaskFilters>) =>
      declaredFilterPredicates("task", task, filters, {
        derived: { effectiveTrade: sql`effective_trade` },
        context: ListContext.empty,
      }).filter((predicate) => predicate !== undefined);
    expect(defined({ status: "done" })).toHaveLength(1);
    const both = defined({
      status: ["done", "in_progress"],
      trade: tradeSchema.options[0],
    }).map(renderWhereSql);
    expect(both).toHaveLength(2);
    expect(
      both.some((rendered) => rendered?.includes("effective_trade IN (")),
    ).toBe(true);
    expect(defined({ status: [] })).toHaveLength(0);
  });
});
