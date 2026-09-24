import type { TaskFilters } from "@cubby/schemas/project";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { describe, expect, it } from "vitest";

import { task } from "~/server/db/schema";

import { declaredFilterPredicates } from "./declared-filter-predicates";

describe("declaredFilterPredicates", () => {
  it("leaves effective task trade to the task resolver", () => {
    const defined = (filters: Partial<TaskFilters>) =>
      declaredFilterPredicates("task", task, filters).filter(
        (predicate) => predicate !== undefined,
      );
    expect(defined({ status: "done" })).toHaveLength(1);
    expect(
      defined({
        status: ["done", "in_progress"],
        trade: tradeSchema.options[0],
      }),
    ).toHaveLength(1);
    expect(defined({ status: [] })).toHaveLength(0);
  });
});
