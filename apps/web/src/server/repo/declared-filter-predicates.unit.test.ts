import {
  allEntities,
  entityInspectorMetadata,
} from "@cubby/schemas/entity-manifest";
import type { TaskFilters } from "@cubby/schemas/project";
import { tradeSchema } from "@cubby/schemas/task-fields";
import { describe, expect, it } from "vitest";

import { task } from "~/server/db/schema";
import { SHORTCODE_TABLE } from "~/server/repo/generated/shortcode-tables.gen";

import { declaredFilterPredicates } from "./declared-filter-predicates";

const storedEntities = allEntities.filter((entity) =>
  Object.entries(entityInspectorMetadata)
    .find(([key]) => key === entity)?.[1]
    .filterDescriptors.some((descriptor) => descriptor.stored),
);

describe("declaredFilterPredicates", () => {
  it("resolves a table column for every stored descriptor", () => {
    expect(storedEntities.length).toBeGreaterThan(0);
    for (const entity of storedEntities) {
      const table = Object.entries(SHORTCODE_TABLE).find(
        ([key]) => key === entity,
      )?.[1];
      if (!table) throw new Error(`${entity} has no shortcode table`);
      // An empty filter set yields only absent predicates: nothing is
      // unconditionally narrowed, and every column resolved.
      const predicates = declaredFilterPredicates(entity, table, {});
      expect(predicates.every((predicate) => predicate === undefined)).toBe(
        true,
      );
    }
  });

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
