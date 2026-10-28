import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { seedEditorTestMetadata } from "#web/tests/editor-metadata.fixtures.ts";

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
  it("publishes a canonical receipt across views without awaiting refresh and evicts inactive baselines", async () => {
    const { queryClient: client } = getContext();
    seedEditorTestMetadata(client);
    const key = ["synthetic-task-page"];
    const detail = ["synthetic-task-detail"];
    const inactive = ["synthetic-task-baseline"];
    const id = "TSK-AAAA";
    const gate = Promise.withResolvers<{
      items: { id: string; status: string }[];
    }>();
    client.setQueryData(key, { items: [{ id, status: "todo" }] });
    client.setQueryDefaults(detail, { meta: { cacheTags: [["task"]] } });
    client.setQueryData(detail, { id, status: "todo" });
    client.getQueryCache().build(client, {
      queryKey: inactive,
      meta: { cacheTags: [["task"]] },
      queryFn: async () => null,
    });
    const observer = new QueryObserver(client, {
      queryKey: key,
      meta: { cacheTags: [["task"]], silentErrors: true },
      queryFn: () => gate.promise,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const unrelatedKey = ["synthetic-other-view"];
    client.setQueryData(unrelatedKey, {
      id: "PRD-AAAA",
      name: "Synthetic item",
    });
    const unrelated = client.getQueryCache().find({ queryKey: unrelatedKey });
    const readFailure = new Error("Synthetic unrelated refresh failed");
    await client
      .fetchQuery({
        queryKey: unrelatedKey,
        staleTime: 0,
        meta: { silentErrors: true },
        queryFn: async () => {
          throw readFailure;
        },
      })
      .catch(() => undefined);
    unrelated?.invalidate();
    try {
      const receipt = {
        action: "update",
        entity: "task",
        item: { id, status: "done" },
        appliedFields: ["status"],
        sideEffects: {},
      };
      const saved = await client
        .getMutationCache()
        .build(client, {
          mutationFn: async () => receipt,
          meta: {
            operation: "entity.mutate",
            entity: "task",
            invalidates: entityRipple("task"),
          },
        })
        .execute({ id, data: { status: "done" } });
      expect(saved).toEqual(receipt);
      expect(client.getQueryState(unrelatedKey)?.error).toBe(readFailure);
      expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(true);
      expect(client.getQueryData(key)).toEqual({
        items: [{ id, status: "done" }],
      });
      expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
      expect(client.getQueryState(inactive)).toBeUndefined();
      expect(client.getQueryState(detail)).toBeUndefined();
      gate.reject(new Error("Synthetic refresh failed after commit"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.getQueryData(key)).toEqual({
        items: [{ id, status: "done" }],
      });
      expect(client.getQueryState(key)?.status).toBe("error");
    } finally {
      unsubscribe();
      client.clear();
    }
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

  it("refreshes Shipment reads when their declared seller label changes", async () => {
    expect(
      await invalidatedTagsFor(
        { operation: "entity.mutate", invalidates: ripple.none },
        {
          entity: "vendor",
          action: "update",
          id: "VEN-1",
          data: { name: "Synthetic seller" },
        },
        [["shipment"], ["entity", "filterOptions"]],
      ),
    ).toEqual([["shipment"], ["entity", "filterOptions"]]);
  });
});
