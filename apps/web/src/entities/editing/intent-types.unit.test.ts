import { describe, expect, expectTypeOf, it } from "vitest";
import type { EntityEditRequest } from "./types";

describe("typed entity edit requests", () => {
  it("derives operation, intent, record, and seed types from the entity", () => {
    const request = {
      entity: "task",
      operation: "update",
      intent: "schedule",
      surface: "calendar",
      record: {
        id: "TSK-TYPED",
        status: "not_started",
        dueDate: "2026-08-20",
      },
    } satisfies EntityEditRequest<"task", "update", "schedule">;

    expectTypeOf(request.intent).toEqualTypeOf<"schedule">();
    expect(request.record.id).toBe("TSK-TYPED");

    const createRequest = {
      entity: "expense",
      operation: "create",
      intent: "capture",
      surface: "dialog",
      seed: { future: true, date: "2026-08-21" },
    } satisfies EntityEditRequest<"expense", "create", "capture">;
    expect(createRequest.seed.future).toBe(true);
  });

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
