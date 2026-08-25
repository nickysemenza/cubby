import { type TaskId, unsafeTaskId } from "@cubby/schemas/identifiers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Database } from "~/server/db";
import type * as ShortcodeResolver from "~/server/repo/shortcode-resolver";
import type * as MutationSideEffects from "~/server/services/mutation-side-effects";

const mocks = vi.hoisted(() => ({
  resolveAllPresent: vi.fn(),
  runMutationSideEffectsForEntities: vi.fn(),
}));

vi.mock("~/server/repo/shortcode-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof ShortcodeResolver>()),
  resolveAllPresent: mocks.resolveAllPresent,
}));

vi.mock("~/server/services/mutation-side-effects", async (importOriginal) => ({
  ...(await importOriginal<typeof MutationSideEffects>()),
  runMutationSideEffectsForEntities: mocks.runMutationSideEffectsForEntities,
}));

import { createBulkUpdatedMutation } from "./crud-factory";
import { createTestCaller, createTRPCRouter } from "./trpc";

const itemSchema = z.object({ id: z.string(), name: z.string() });
const inputSchema = z.object({ ids: z.array(z.string()), emit: z.boolean() });
const items = [
  { id: "TSK-ONE", name: "One" },
  { id: "TSK-TWO", name: "Two" },
];
const entityIds = [
  unsafeTaskId("10000000-0000-4000-8000-000000000001"),
  unsafeTaskId("10000000-0000-4000-8000-000000000002"),
] satisfies TaskId[];

const router = createTRPCRouter({
  bulk: createBulkUpdatedMutation({
    input: inputSchema,
    itemOutput: itemSchema,
    entity: "task",
    source: "task.testBulk",
    mutate: async () => items,
    entityShortcodes: (result, input) =>
      input.emit ? result.map((item) => item.id) : [],
  }),
});

describe("createBulkUpdatedMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAllPresent.mockResolvedValue(entityIds);
    mocks.runMutationSideEffectsForEntities.mockResolvedValue([]);
  });

  it("resolves the returned rows and dispatches exactly one homogeneous event wave", async () => {
    const caller = createTestCaller(router, {} as Database);

    const result = await caller.bulk({
      ids: items.map((item) => item.id),
      emit: true,
    });

    expect(result.items).toEqual(items);
    expect(mocks.resolveAllPresent).toHaveBeenCalledOnce();
    expect(mocks.resolveAllPresent).toHaveBeenCalledWith(
      expect.anything(),
      "task",
      ["TSK-ONE", "TSK-TWO"],
    );
    expect(mocks.runMutationSideEffectsForEntities).toHaveBeenCalledOnce();
    expect(mocks.runMutationSideEffectsForEntities).toHaveBeenCalledWith(
      expect.anything(),
      entityIds.map((entityId) => ({
        action: "updated",
        entity: { entityType: "task", entityId },
        source: "task.testBulk",
      })),
    );
    expect(result.sideEffects.backgroundBatches).toEqual([]);
  });

  it("dispatches no events when the selector excludes a pure reorder", async () => {
    mocks.resolveAllPresent.mockResolvedValue([]);
    const caller = createTestCaller(router, {} as Database);

    await caller.bulk({ ids: items.map((item) => item.id), emit: false });

    expect(mocks.resolveAllPresent).toHaveBeenCalledWith(
      expect.anything(),
      "task",
      [],
    );
    expect(mocks.runMutationSideEffectsForEntities).toHaveBeenCalledOnce();
    expect(mocks.runMutationSideEffectsForEntities).toHaveBeenCalledWith(
      expect.anything(),
      [],
    );
  });
});
