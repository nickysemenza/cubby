import type { Query } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { CubbyOperationMeta, OperationCacheTag } from "./operation-meta";
import { getContext } from "./root-provider";

const asQuery = (cacheTags: readonly OperationCacheTag[]) =>
  ({ meta: { cacheTags } }) as unknown as Query;

/**
 * Runs one mutation through the real root `MutationCache` and reports which
 * queries its invalidation predicate would have matched. `invalidateQueries` is
 * stubbed rather than exercised so the assertion is about the tag set the cache
 * resolved, not about React Query's own refetch machinery.
 */
async function invalidatedTagsFor(
  meta: CubbyOperationMeta,
  variables: unknown,
  probes: readonly OperationCacheTag[],
) {
  const { queryClient } = getContext();
  const matched: OperationCacheTag[] = [];
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
    async (filters) => {
      const predicate = filters?.predicate;
      if (!predicate) return;
      for (const probe of probes)
        if (predicate(asQuery([probe]))) matched.push(probe);
    },
  );
  await queryClient
    .getMutationCache()
    .build(queryClient, { mutationFn: async () => ({ ok: true }), meta })
    .execute(variables);
  return matched;
}

describe("root MutationCache invalidation", () => {
  it("uses a descriptor's static tag list", async () => {
    expect(
      await invalidatedTagsFor(
        { operation: "product.quickCreate", invalidates: [["product"]] },
        { name: "Hammer" },
        [["product", "search"], ["task"], ["meal"]],
      ),
    ).toEqual([["product", "search"]]);
  });

  it("falls back to the registered policy when meta declares nothing", async () => {
    // `entity.mutate` declares `invalidates` as a FUNCTION, so its `meta` is the
    // empty array and only the registered policy knows the entity.
    await import("~/entities/entity-mutation.functions");
    expect(
      await invalidatedTagsFor(
        { operation: "entity.mutate", invalidates: [] },
        { entity: "wish", action: "update", id: "WSH-1", data: {} },
        [["wish"], ["product", "search"]],
      ),
    ).toEqual([["wish"]]);
  });

  it("lets a non-empty meta.invalidates beat the registered policy", async () => {
    await import("~/entities/entity-mutation.functions");
    // The variables a component hands `entity.mutate` carry no `entity`, so the
    // policy alone would resolve the wrong fan-out; `meta` overrides it.
    expect(
      await invalidatedTagsFor(
        { operation: "entity.mutate", invalidates: [["vendor"]] },
        { id: "VEN-1", data: { name: "Acme" } },
        [
          ["vendor", "options"],
          ["product", "search"],
        ],
      ),
    ).toEqual([["vendor", "options"]]);
  });
});
