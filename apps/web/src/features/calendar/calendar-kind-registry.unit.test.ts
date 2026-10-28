import { calendarMealItem, calendarMealSource } from "@cubby/schemas/calendar";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { createEditorTestQueryClient } from "#web/tests/editor-metadata.fixtures.ts";
import {
  initialEntityEditValues,
  resolveEntityEdit,
} from "~/entity/editing/kernel";
import { mock } from "~/lib/test/mock-schema";

import { calendarItemEditDescriptor } from "./calendar-kind-registry";
import { mealCalendarSourceFixture } from "./calendar-source.fixtures";

const queryClient = createEditorTestQueryClient();

describe("Calendar Meal editor source intent", () => {
  it("seeds the stored assignment and retains current controls when the effective value differs", () => {
    const id = testShortcode("meal", "MEL-4K7M");
    const base = mealCalendarSourceFixture({
      id,
      name: "Synthetic supper",
      date: "2026-10-10",
      mealType: "dinner",
    });
    const source = calendarMealSource.parse({
      ...base,
      fields: {
        ...base.fields,
        mealType: {
          ...base.fields.mealType,
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "value", value: "lunch" },
              provenance: { kind: "computed" },
            },
          },
        },
      },
    });
    const item = mock(calendarMealItem, {
      overrides: {
        id,
        name: source.name,
        startDate: source.date,
        endDateExclusive: "2026-10-11",
        source,
      },
    });
    const edit = calendarItemEditDescriptor(item);
    if (edit.mode !== "editable" || edit.entity !== "meal")
      throw new Error("Synthetic Meal must be editable");
    expect(edit.record).toBe(item.source);
    expect(edit.record).not.toHaveProperty("mealType");
    const request = {
      entity: "meal",
      operation: "update",
      intent: "calendar",
      surface: "calendar",
      record: edit.record,
    } as const;
    const resolved = resolveEntityEdit(queryClient, request);
    if (!("definition" in resolved))
      throw new Error("Synthetic Meal editor must resolve");
    const values = initialEntityEditValues(resolved, request);
    expect(values.mealType).toBe("dinner");
    expect(values.date).toBe("2026-10-10");
    expect(source.fields.mealType.current.controls).toEqual(
      base.fields.mealType.current.controls,
    );
  });
  it("honors current read-only controls even when a usable effective value exists", () => {
    const id = testShortcode("meal", "MEL-4K7M");
    const base = mealCalendarSourceFixture({ id, mealType: "dinner" });
    const source = calendarMealSource.parse({
      ...base,
      fields: {
        ...base.fields,
        mealType: {
          ...base.fields.mealType,
          current: {
            ...base.fields.mealType.current,
            controls: { kind: "readonly", reason: "not_allowed" },
          },
        },
      },
    });
    const item = mock(calendarMealItem, { overrides: { id, source } });
    expect(calendarItemEditDescriptor(item)).toMatchObject({
      mode: "read-only",
      entity: "meal",
    });
  });
});
