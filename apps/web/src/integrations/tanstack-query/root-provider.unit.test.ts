import { describe, expect, it } from "vitest";
import { z } from "zod";

import { entityRipple, ripple } from "./cache-tags";
import { matchesTags } from "./operation-cache";
import type { CubbyOperationMeta, OperationCacheTag } from "./operation-meta";
import { getContext, type RootMutationSuccessRuntime } from "./root-provider";

const entityMutationVariablesSchema = z.object({ entity: z.string() });

const registeredInvalidations = <Variables>(
  operation: string | undefined,
  variables: Variables,
): ReturnType<typeof entityRipple> => {
  if (operation !== "entity.mutate") return ripple.none;
  const parsed = entityMutationVariablesSchema.safeParse(variables);
  return parsed.success ? entityRipple(parsed.data.entity) : ripple.none;
};

/**
 * Runs one mutation through the real root `MutationCache` and reports which
 * queries its invalidation predicate matches. The injected success port records
 * the resolved tags without replacing any TanStack module or client method.
 */
async function invalidatedTagsFor<Variables>(
  meta: CubbyOperationMeta,
  variables: Variables,
  probes: readonly OperationCacheTag[],
): Promise<OperationCacheTag[]> {
  const matched: OperationCacheTag[] = [];
  const probeByHash = new Map<string, OperationCacheTag>();
  const runtime: RootMutationSuccessRuntime = {
    registeredInvalidations,
    afterSuccess: ({ queryClient, invalidations }) => {
      const matches = matchesTags(invalidations);
      for (const query of queryClient.getQueryCache().getAll()) {
        const probe = probeByHash.get(query.queryHash);
        if (probe && matches(query)) matched.push(probe);
      }
    },
  };
  const { queryClient } = getContext(runtime);
  probes.forEach((probe, index) => {
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: ["invalidation-probe", index],
      queryFn: async () => null,
      meta: { cacheTags: [probe] },
    });
    probeByHash.set(query.queryHash, probe);
  });
  await queryClient
    .getMutationCache()
    .build(queryClient, { mutationFn: async () => ({ ok: true }), meta })
    .execute(variables);
  return matched;
}

describe("root MutationCache invalidation", () => {
  it("disables ambient browser revalidation for cached queries", () => {
    const { queryClient } = getContext();
    expect(queryClient.getDefaultOptions().queries?.refetchOnMount).toBe(false);
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(
      false,
    );
    expect(queryClient.getDefaultOptions().queries?.refetchOnReconnect).toBe(
      false,
    );
  });

  it("uses a descriptor's static tag list", async () => {
    expect(
      await invalidatedTagsFor(
        { operation: "product.quickCreate", invalidates: ripple.productOnly },
        { name: "Hammer" },
        [["product", "search"], ["task"], ["meal"]],
      ),
    ).toEqual([["product", "search"]]);
  });

  it("falls back to the registered policy when meta declares nothing", async () => {
    // `entity.mutate` declares `invalidates` as a FUNCTION, so its `meta` is the
    // empty array and only the registered policy knows the entity.
    expect(
      await invalidatedTagsFor(
        { operation: "entity.mutate", invalidates: ripple.none },
        { entity: "wish", action: "update", id: "WSH-1", data: {} },
        [["wish"], ["product", "search"]],
      ),
    ).toEqual([["wish"]]);
  });

  it("lets a non-empty meta.invalidates beat the registered policy", async () => {
    // The variables a component hands `entity.mutate` carry no `entity`, so the
    // policy alone would resolve the wrong fan-out; `meta` overrides it.
    expect(
      await invalidatedTagsFor(
        { operation: "entity.mutate", invalidates: ripple.vendor },
        { id: "VEN-1", data: { name: "Acme" } },
        [
          ["vendor", "options"],
          ["product", "search"],
        ],
      ),
    ).toEqual([["vendor", "options"]]);
  });
});
