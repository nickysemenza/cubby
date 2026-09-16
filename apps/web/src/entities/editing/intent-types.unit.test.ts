import { describe, expect, it } from "vitest";

import type { EntityEditRequest } from "./types";

describe("typed entity edit requests", () => {
  it("rejects intent and draft fields belonging to another entity", () => {
    const invalidIntent: EntityEditRequest<"task", "update"> = {
      entity: "task",
      operation: "update",
      // @ts-expect-error planned belongs to Expense, not Task
      intent: "planned",
      surface: "calendar",
      record: { id: "TSK-TYPED" },
    };
    const invalidSeed: EntityEditRequest<"meal", "create"> = {
      entity: "meal",
      operation: "create",
      intent: "capture",
      surface: "dialog",
      // @ts-expect-error status is not a Meal draft field
      seed: { status: "not_started" },
    };
    expect(invalidIntent.entity).toBe("task");
    expect(invalidSeed.entity).toBe("meal");
  });
});
