import { SHORTCODE_PREFIX } from "@cubby/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityKernelContext } from "./adapter";
import { entityCommandSchema } from "./contracts";
import { executeEntity } from "./execute";

const { taskBulkUpdate } = vi.hoisted(() => ({ taskBulkUpdate: vi.fn() }));

// The capability is per-repository, so the gate is asserted against bindings
// this test owns: `task` always has it and `expense` never does, whatever the
// real adapters grow later.
vi.mock("~/server/generated/entity-kernel-bindings.gen", async (original) => {
  const actual =
    await original<
      typeof import("~/server/generated/entity-kernel-bindings.gen")
    >();
  const bindings = actual.ENTITY_KERNEL_BINDINGS;
  const { bulkUpdate: _absent, ...expenseRepository } = bindings.expense
    .repository as Record<string, unknown>;
  return {
    ...actual,
    ENTITY_KERNEL_BINDINGS: {
      ...bindings,
      task: {
        ...bindings.task,
        repository: { ...bindings.task.repository, bulkUpdate: taskBulkUpdate },
      },
      expense: { ...bindings.expense, repository: expenseRepository },
    },
  };
});

/**
 * The bulkUpdate path never reads the context; the repository would, and every
 * repository here is a stub. Widened through `never` rather than asserted onto
 * the context type — `check-unsafe-identifiers` refuses an assertion onto a
 * branded type, and a hand-built context would be a page of stubs the test
 * never touches.
 */
const NO_CONTEXT: EntityKernelContext = {} as unknown as never;

const idFor = (entity: string, suffix = "ABCD") =>
  `${SHORTCODE_PREFIX[entity as keyof typeof SHORTCODE_PREFIX]}${suffix}`;

const parseCommand = (command: unknown) =>
  entityCommandSchema.safeParse(command);

describe("entity kernel bulkUpdate", () => {
  beforeEach(() => {
    taskBulkUpdate.mockReset();
  });

  it("refuses an entity whose repository has no bulkUpdate", async () => {
    await expect(
      executeEntity(NO_CONTEXT, {
        action: "bulkUpdate",
        entity: "expense",
        ids: [idFor("expense")],
        data: { trade: "planning" },
      } as never),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "CONSTRAINT_VIOLATION",
      message: "Expense does not support bulk update",
    });
  });

  it("hands the repository the parsed ids and patch, and reports the count", async () => {
    taskBulkUpdate.mockResolvedValue({ updated: 2 });
    const ids = [idFor("task", "AAAA"), idFor("task", "BBBB")];

    const result = await executeEntity(NO_CONTEXT, {
      action: "bulkUpdate",
      entity: "task",
      ids,
      data: { status: "done", trade: "planning" },
    } as never);

    expect(taskBulkUpdate).toHaveBeenCalledWith(NO_CONTEXT, ids, {
      status: "done",
      trade: "planning",
    });
    expect(result).toEqual({
      action: "bulkUpdate",
      entity: "task",
      updated: 2,
      updatedIds: ids,
      sideEffects: { backgroundBatches: [] },
    });
  });

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
