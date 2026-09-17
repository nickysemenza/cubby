import { SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it } from "vitest";

import { entityCommandSchema } from "./contracts";

const idFor = (entity: keyof typeof SHORTCODE_PREFIX, suffix = "ABCD") =>
  `${SHORTCODE_PREFIX[entity]}${suffix}`;

const parseCommand = <TInput>(command: TInput) =>
  entityCommandSchema.safeParse(command);

describe("entity kernel bulkUpdate", () => {
  it("accepts a patch limited to the declared fields", () => {
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "task",
        ids: [idFor("task", "AAAA"), idFor("task", "BBBB")],
        data: { status: "done", trade: "planning" },
      }).success,
    ).toBe(true);
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "product",
        ids: [idFor("product")],
        data: { stockTracked: true },
      }).success,
    ).toBe(true);
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "planting",
        ids: [idFor("planting")],
        data: {
          status: "finished",
          finishedOn: "2026-08-01",
          locationId: null,
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a field the entity never declared as bulk-updatable", () => {
    // `name` is a real task update field; only the declared subset is
    // patchable, and an undeclared one is refused rather than stripped.
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "task",
        ids: [idFor("task")],
        data: { status: "done", name: "Renamed in bulk" },
      }).success,
    ).toBe(false);
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "product",
        ids: [idFor("product")],
        data: { stockTracked: true, name: "Renamed in bulk" },
      }).success,
    ).toBe(false);
    // `variety` is a real planting update field; only status/finishedOn/
    // locationId are declared bulk-updatable.
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "planting",
        ids: [idFor("planting")],
        data: { status: "finished", variety: "Renamed in bulk" },
      }).success,
    ).toBe(false);
  });

  it("refuses an entity that never declared the capability", () => {
    expect(
      parseCommand({
        action: "bulkUpdate",
        entity: "recipe",
        ids: [idFor("recipe")],
        data: { name: "Bulk renamed" },
      }).success,
    ).toBe(false);
  });

  it("enforces the same 1-500 unique id bound bulk delete uses", () => {
    const bounded = (ids: string[]) =>
      parseCommand({
        action: "bulkUpdate",
        entity: "task",
        ids,
        data: { status: "done" },
      }).success;
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        idFor("task", String(index).padStart(4, "0")),
      );

    expect(bounded([])).toBe(false);
    expect(bounded(many(500))).toBe(true);
    expect(bounded(many(501))).toBe(false);
    expect(bounded([idFor("task"), idFor("task")])).toBe(false);
  });
});
