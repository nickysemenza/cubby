import { countableEntities } from "@cubby/schemas/entity-manifest";
import { imageOut } from "@cubby/schemas/image";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { mock } from "~/lib/test/mock-schema";
import {
  entityBrowserMutationResultSchema,
  entityMutationResultSchema,
  type EntityBrowserMutationInput,
} from "~/server/entity-kernel/contracts";

import {
  entityMutationOptionsFactory,
  type EntityMutationTransport,
} from "./entity-contracts";
import { entityListFor } from "./entity-list.functions";

function inMemoryMutationTransport(
  result: ReturnType<typeof entityBrowserMutationResultSchema.parse>,
) {
  const commands: EntityBrowserMutationInput[] = [];
  const transport: EntityMutationTransport = {
    execute: async (command) => {
      commands.push(command);
      return result;
    },
  };
  return { commands, transport };
}

describe("entity-contracts drift guard", () => {
  it.each(countableEntities)(
    "%s mutations invalidate the shared dashboard count",
    (entity) => {
      expect(entityRipple(entity)).toContainEqual(["dashboard"]);
    },
  );

  it("hangs the entity's ripple on the options every CRUD call site uses", () => {
    const options = entityMutationOptionsFactory("product", "update")();
    expect(options.meta).toMatchObject({
      operation: "entity.mutate",
      entity: "product",
      invalidates: entityRipple("product"),
    });
  });
});

describe("kernel browser transport", () => {
  it("maps generated list contracts onto normalized operation cache keys", () => {
    const params = {
      filters: {},
      sort: { orderBy: "name", direction: "asc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };

    const options = entityListFor("product").queryOptions(params);

    expect(options.queryKey).toEqual([
      "operation",
      "entity.list",
      { entity: "product", input: { entity: "product", ...params } },
    ]);
    expect(options.queryFn).toEqual(expect.any(Function));
  });

  it("executes a generated delete command through an explicit in-memory transport", async () => {
    const adapter = inMemoryMutationTransport(
      entityBrowserMutationResultSchema.parse({
        action: "delete",
        entity: "product",
        deletedReferences: [
          { entity: "product", id: "PRD-4K7M" },
          { entity: "image", id: "IMG-2F9Q" },
          { entity: "image", id: "IMG-8J3W" },
        ],
        affectedEdges: [],
        sideEffects: { backgroundBatches: [] },
      }),
    );
    const options = entityMutationOptionsFactory(
      "product",
      "delete",
      adapter.transport,
    )();
    const observer = new MutationObserver(new QueryClient(), options);

    await expect(observer.mutate({ ids: ["PRD-4K7M"] })).resolves.toEqual({
      deleted: 1,
      sideEffects: { backgroundBatches: [] },
    });
    expect(adapter.commands).toEqual([
      {
        action: "delete",
        entity: "product",
        ids: ["PRD-4K7M"],
      },
    ]);
  });

  it("rejects duplicate exact delete references at the transport boundary", () => {
    expect(
      entityBrowserMutationResultSchema.safeParse({
        action: "delete",
        entity: "task",
        deletedReferences: [
          { entity: "task", id: "TSK-4K7M" },
          { entity: "task", id: "TSK-4K7M" },
        ],
        affectedEdges: [],
        sideEffects: { backgroundBatches: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps the explicit Image update result in the strict mutation union", () => {
    expect(
      entityMutationResultSchema.safeParse({
        action: "update",
        entity: "image",
        item: mock(imageOut, { seed: 1 }),
        sideEffects: { backgroundBatches: [] },
      }).success,
    ).toBe(true);
  });
});
