import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { countableEntities } from "@cubby/schemas/entity-manifest";
import { imageOut } from "@cubby/schemas/image";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { DataOf } from "~/app/_components/hooks/useActionMutation";
import { queryKeys } from "~/lib/query-keys";
import { mock } from "~/lib/test/mock-schema";
import { entityMutationResultSchema } from "~/server/entity-kernel/contracts";
import {
  entityMutationOptionsFactory,
  getEntityContract,
} from "./entity-contracts";

const mutationTransport = vi.hoisted(() => vi.fn());

vi.mock("./entity-mutation", () => ({
  entityMutationOptions: () => ({ mutationFn: mutationTransport }),
}));

describe("entity-contracts drift guard", () => {
  it.each(countableEntities)(
    "%s mutations invalidate the shared dashboard count",
    (entity) => {
      expect(getEntityContract(entity).invalidationKeys).toContainEqual(
        queryKeys.dashboard.counts,
      );
    },
  );
});

describe("kernel browser transport", () => {
  it("preserves entity-specific result types without tRPC inference", () => {
    const factory = entityMutationOptionsFactory("product", "create");
    expectTypeOf<DataOf<typeof factory>>().toEqualTypeOf<
      ProductWithFoodOut & { sideEffects: MutationSideEffects }
    >();
  });

  it("maps generated list contracts onto Start-compatible list cache keys", () => {
    const params = {
      filters: {},
      sort: { orderBy: "name", direction: "asc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };

    const options = getEntityContract("product").query.list?.(
      {} as never,
      params,
    ) as {
      queryKey: unknown;
      queryFn: unknown;
    };

    expect(options.queryKey).toEqual([["product", "list"], { input: params }]);
    expect(options.queryFn).toEqual(expect.any(Function));
  });

  it("maps generated mutation contracts onto the Start command and unwraps results", async () => {
    mutationTransport.mockResolvedValueOnce({
      action: "create",
      entity: "product",
      item: { id: "PRD-1", name: "Hammer" },
      sideEffects: { backgroundBatches: [] },
    });
    const options = getEntityContract("product").mutation.create?.(
      {} as never,
      {} as never,
    ) as { mutationFn: (variables: unknown) => Promise<unknown> };

    await expect(options.mutationFn({ name: "Hammer" })).resolves.toEqual({
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
