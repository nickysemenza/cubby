import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { countableEntities } from "@cubby/schemas/entity-manifest";
import { imageOut } from "@cubby/schemas/image";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { DataOf } from "~/app/_components/hooks/useActionMutation";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { mock } from "~/lib/test/mock-schema";
import { entityMutationResultSchema } from "~/server/entity-kernel/contracts";
import { entityMutationOptionsFactory } from "./entity-contracts";
import { entityListQueryOptions } from "./entity-list.functions";
import { flattenEntityMutationResult } from "./entity-mutation.functions";

const mutationTransport = vi.hoisted(() => vi.fn());

vi.mock("./entity-mutation.functions", async (importOriginal) => ({
  ...(await importOriginal()),
  executeEntityMutation: ({ data }: { data: unknown }) =>
    mutationTransport(data),
}));

describe("entity-contracts drift guard", () => {
  it.each(countableEntities)(
    "%s mutations invalidate the shared dashboard count",
    (entity) => {
      expect(entityRipple(entity)).toContainEqual(["dashboard"]);
    },
  );

  it("hangs the entity's ripple on the options every CRUD call site uses", () => {
    // The regression this guards: the factory set no `meta` at all, so the root
    // MutationCache read `undefined` and every entity create/update/delete
    // invalidated nothing through the tag path.
    const options = entityMutationOptionsFactory("product", "update")();
    expect(options.meta).toMatchObject({
      operation: "entity.mutate",
      entity: "product",
      invalidates: entityRipple("product"),
    });
  });
});

describe("kernel browser transport", () => {
  it("flattens Start mutation envelopes for existing form callers", () => {
    expect(
      flattenEntityMutationResult({
        action: "create",
        entity: "product",
        item: { id: "PRD-1", name: "Hammer" } as never,
        sideEffects: { backgroundBatches: [] },
      }),
    ).toMatchObject({
      id: "PRD-1",
      name: "Hammer",
      sideEffects: { backgroundBatches: [] },
    });
  });

  it("preserves entity-specific result types without transport inference", () => {
    const factory = entityMutationOptionsFactory("product", "create");
    expectTypeOf<DataOf<typeof factory>>().toEqualTypeOf<
      ProductWithFoodOut & { sideEffects: MutationSideEffects }
    >();
  });

  it("maps generated list contracts onto normalized operation cache keys", () => {
    const params = {
      filters: {},
      sort: { orderBy: "name", direction: "asc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };

    const options = entityListQueryOptions("product", params);

    expect(options.queryKey).toEqual([
      "operation",
      "entity.list",
      { entity: "product", input: { entity: "product", ...params } },
    ]);
    expect(options.queryFn).toEqual(expect.any(Function));
  });

  it("maps generated mutation contracts onto the Start command and unwraps results", async () => {
    mutationTransport.mockResolvedValueOnce({
      action: "create",
      entity: "product",
      item: { id: "PRD-1", name: "Hammer" },
      sideEffects: { backgroundBatches: [] },
    });
    const options = entityMutationOptionsFactory("product", "create")();
    const mutationFn = options.mutationFn;
    if (!mutationFn) throw new Error("missing mutation function");

    await expect(
      (mutationFn as (variables: { name: string }) => Promise<unknown>)({
        name: "Hammer",
      }),
    ).resolves.toEqual({
      id: "PRD-1",
      name: "Hammer",
      sideEffects: { backgroundBatches: [] },
    });
    expect(mutationTransport).toHaveBeenCalledWith({
      action: "create",
      entity: "product",
      data: { name: "Hammer" },
    });
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
