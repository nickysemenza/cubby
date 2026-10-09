import {
  QueryClientProvider,
  useMutation,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { EMPTY_INVALIDATION_TAG_SET } from "./cache-tags";
import { entityMutation } from "./generated/entity-mutation.gen";
import { inventory } from "./generated/inventory.gen";
import { location } from "./generated/location.gen";
import { mcp } from "./generated/mcp.gen";
import { recipe } from "./generated/recipe.gen";
import { run } from "./generated/run.gen";
import { invalidateOperationTags } from "./operation-cache";
import { operationInvalidationTags } from "./operation-catalog";
import type { CubbyOperationMeta } from "./operation-meta";
import { getContext } from "./root-provider";

/**
 * The generated catalog is the only source of a query's tags and a mutation's
 * fan-out, so this drives the real root `MutationCache` from a rendered
 * `useMutation` over catalog descriptors and asks which cached queries went
 * stale. It pins the three contract-data behaviors a refactor could lose: a
 * defaulted tag reached by prefix, an explicit `tags: []` opt-out, and the one
 * fan-out chosen from the mutation's input (`operation-overrides.ts`).
 */
function mountedClient() {
  const { queryClient } = getContext({
    registeredInvalidations: (operation, variables) =>
      operationInvalidationTags(operation, variables) ??
      EMPTY_INVALIDATION_TAG_SET,
    afterSuccess: ({ queryClient: client, invalidations }) => {
      void invalidateOperationTags(client, invalidations);
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const cacheQuery = (
    name: string,
    descriptor: { meta: CubbyOperationMeta },
  ) => {
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: ["catalog-invalidation", name],
      queryFn: async () => null,
      meta: descriptor.meta,
    });
    queryClient.setQueryData(query.queryKey, null);
    return query;
  };
  return { queryClient, wrapper, cacheQuery };
}

async function runMutation<Variables>(
  wrapper: ({ children }: { children: ReactNode }) => ReactNode,
  descriptor: { meta: CubbyOperationMeta; id: string },
  variables: Variables,
) {
  const options: UseMutationOptions<null, Error, Variables> = {
    mutationKey: ["operation", descriptor.id],
    meta: descriptor.meta,
    mutationFn: async () => null,
  };
  const { result } = renderHook(() => useMutation(options), { wrapper });
  await act(async () => {
    await result.current.mutateAsync(variables);
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

describe("catalog-driven invalidation", () => {
  it("invalidates queries reached by a defaulted tag and leaves the rest fresh", async () => {
    const { wrapper, cacheQuery } = mountedClient();
    // `inventory.locationSnapshot` declares no tags: it is tagged
    // `["inventory", "locationSnapshot"]`, which `ripple.inventory` reaches by prefix.
    const snapshot = cacheQuery("snapshot", inventory.locationSnapshot);
    const subtree = cacheQuery("subtree", location.subtree);
    const flow = cacheQuery("flow", recipe.getFlow);
    const tools = cacheQuery("tools", mcp.listTools);

    await runMutation(wrapper, inventory.bulkMove, {});

    expect(snapshot.state.isInvalidated).toBe(true);
    expect(subtree.state.isInvalidated).toBe(true);
    expect(flow.state.isInvalidated).toBe(false);
    expect(tools.state.isInvalidated).toBe(false);
  });

  it("keeps a query with an explicit empty tag list out of every fan-out", async () => {
    const { wrapper, cacheQuery } = mountedClient();
    const detail = cacheQuery("detail", run.history);
    const untagged = cacheQuery("untagged", run.merchantRules);

    await runMutation(wrapper, run.control, {});

    expect(detail.state.isInvalidated).toBe(true);
    expect(untagged.state.isInvalidated).toBe(false);
  });

  it("chooses an entity write's fan-out from its input", async () => {
    const { wrapper, cacheQuery } = mountedClient();
    const vendors = cacheQuery("vendors", {
      meta: { cacheTags: [["vendor", "options"]] },
    });
    const products = cacheQuery("products", {
      meta: { cacheTags: [["product", "search"]] },
    });

    await runMutation(wrapper, entityMutation.mutate, {
      action: "create",
      entity: "vendor",
      data: { name: "Acme Supply" },
    });

    expect(vendors.state.isInvalidated).toBe(true);
    expect(products.state.isInvalidated).toBe(false);
  });
});
