import { describe, expect, expectTypeOf, it } from "vitest";
import {
  backgroundTaskSchema,
  RECIPE_RECOMPUTE_CHUNK_SIZE,
} from "./background-tasks";
import type { RecipeId } from "./identifiers";
import { mutationSideEffectsSchema } from "./background-jobs";
import { backgroundTaskMessageSchema } from "./queue-messages";
import { telemetryMessageV1Schema } from "./telemetry";
import { testEntityId } from "./test-support/identifiers";

const requestedAt = "2026-09-12T12:00:00.000Z";

describe("background task messages", () => {
  it("parses a version-2 message and brands the task's ids", () => {
    const entityId = testEntityId("product", "embedding");
    const parsed = backgroundTaskMessageSchema.parse({
      version: 2,
      queueType: "background",
      task: {
        kind: "entity-embedding.refresh",
        requestedAt,
        entityType: "product",
        entityId,
      },
    });
    if (parsed.task.kind !== "entity-embedding.refresh")
      throw new Error("wrong kind");
    // The ref is the branded pair; its id is a union over searchable entities
    // because the message does not narrow the entity type statically.
    expectTypeOf(parsed.task.ref.id).toMatchTypeOf<string>();
    expect(parsed.task.ref).toEqual({ entity: "product", id: entityId });
  });

  it("rejects the retired version-1 wakeup instead of treating it as work", () => {
    const result = backgroundTaskMessageSchema.safeParse({
      version: 1,
      queueType: "background",
      batchId: "b",
      jobId: "j",
      kind: "recipe-totals.recompute",
    });
    expect(result.success).toBe(false);
  });

  it("bounds a recipe recompute task to one chunk", () => {
    const recipeId = testEntityId("recipe", "totals");
    const parsed = backgroundTaskSchema.parse({
      kind: "recipe-totals.recompute",
      requestedAt,
      recipeIds: [recipeId],
    });
    if (parsed.kind !== "recipe-totals.recompute") throw new Error("wrong");
    expectTypeOf(parsed.recipeIds).toEqualTypeOf<RecipeId[]>();
    expect(
      backgroundTaskSchema.safeParse({
        kind: "recipe-totals.recompute",
        requestedAt,
        recipeIds: Array.from({ length: RECIPE_RECOMPUTE_CHUNK_SIZE + 1 }, () =>
          testEntityId("recipe", "too-many"),
        ),
      }).success,
    ).toBe(false);
  });

  it("leaves telemetry on its version-1 envelope", () => {
    expect(
      telemetryMessageV1Schema.safeParse({
        version: 2,
        queueType: "telemetry",
        eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
        occurredAt: requestedAt,
        release: "abc",
        type: "mcp_tool_call",
        toolName: "x",
        outcome: "success",
        registeredAtCall: true,
        surface: "external_mcp",
        userId: "u",
        clientId: "c",
      }).success,
    ).toBe(false);
  });

  it("keeps the deprecated side-effects field decodable but always empty", () => {
    expect(mutationSideEffectsSchema.parse({ backgroundBatches: [] })).toEqual({
      backgroundBatches: [],
    });
    expect(
      mutationSideEffectsSchema.safeParse({ backgroundBatches: [{ id: "x" }] })
        .success,
    ).toBe(false);
  });
});
