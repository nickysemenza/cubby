import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { countableEntities } from "@cubby/schemas/entity-manifest";
import { imageOut } from "@cubby/schemas/image";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  DataOf,
  VariablesOf,
} from "~/app/_components/hooks/useActionMutation";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { mock } from "~/lib/test/mock-schema";
import {
  entityBrowserMutationResultSchema,
  entityMutationResultSchema,
  type EntityBrowserMutationInput,
} from "~/server/entity-kernel/contracts";

import {
  entityMutationOptionsFactory,
  type EntityMutationData,
  type EntityMutationTransport,
  type EntityMutationVariables,
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
  it("preserves entity-specific result types through the mutation adapter", () => {
    const createFactory = entityMutationOptionsFactory("product", "create");
    const updateFactory = entityMutationOptionsFactory("product", "update");
    const deleteFactory = entityMutationOptionsFactory("product", "delete");
    const bulkFactory = entityMutationOptionsFactory("product", "bulkUpdate");

    expectTypeOf<DataOf<typeof createFactory>>().toEqualTypeOf<
      ProductTopLevelOut & { sideEffects: MutationSideEffects }
    >();
    expectTypeOf<VariablesOf<typeof updateFactory>>().toEqualTypeOf<
      EntityMutationVariables<"product", "update">
    >();
    expectTypeOf<DataOf<typeof deleteFactory>>().toEqualTypeOf<
      EntityMutationData<"product", "delete">
    >();
    expectTypeOf<VariablesOf<typeof bulkFactory>>().toEqualTypeOf<
      EntityMutationVariables<"product", "bulkUpdate">
    >();
  });

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
        deleted: 1,
        deletedReferences: [],
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
