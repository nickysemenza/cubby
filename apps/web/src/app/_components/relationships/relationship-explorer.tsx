import type { Entity } from "@cubby/schemas/entity";
import {
  type RelatedPreviewGroup,
  relatedViewsFor,
} from "@cubby/schemas/related-view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { type RelationshipPreset, RelationshipTree } from "./relationship-tree";

const NO_PREVIEW_GROUPS: RelatedPreviewGroup[] = [];

function presetLabel(
  entity: Entity,
  key: "connections" | "purchase" | "product",
) {
  if (key === "purchase") return "By purchase";
  if (key === "product") return "By product";
  return entity === "product" ? "Acquisition & stock" : "Connections";
}

/**
 * Adapts the registered graph for the outline surface. Previews make the first
 * paint inexpensive; expanding a branch continues from the same canonical SQL
 * relation through the paginated branch endpoint.
 */
export function RelationshipExplorer({
  entity,
  sourceId,
}: {
  entity: Entity;
  sourceId: string | undefined;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const views = useMemo(() => relatedViewsFor(entity), [entity]);
  const relationKeys = useMemo(() => views.map((view) => view.key), [views]);
  // The recommended preset opens with a real page, rather than the three-row
  // table preview. Vendor deliberately leads with purchases; other entities
  // lead with their first registered relationship.
  const primaryRelationKey =
    entity === "vendor" ? "vendor.purchases" : relationKeys[0];
  const query = useQuery({
    ...api.relatedData.previews.queryOptions({
      source: entity,
      sourceIds: sourceId ? [sourceId] : [],
      relationKeys,
    }),
    enabled: Boolean(sourceId) && relationKeys.length > 0,
  });
  const primaryBranchQuery = useQuery({
    ...api.relatedData.branch.queryOptions({
      relationKey: primaryRelationKey as (typeof relationKeys)[number],
      sourceId: sourceId ?? "",
      limit: 25,
    }),
    enabled: Boolean(sourceId && primaryRelationKey),
  });
  // Hydration-stable: whether the previews have landed differs between the SSR
  // render and the first client render (TanStack Start's query stream races
  // React's hydration), and the two branches below differ by a whole subtree.
  // `views` comes from static config, so holding this gate `true` until
  // hydration is enough. See useHydratedLoading.
  const previewsLoading = useHydratedLoading(query.isLoading);
  const groups = query.data ?? NO_PREVIEW_GROUPS;
  const presets = useMemo<RelationshipPreset[]>(() => {
    const byKey = new Map(groups.map((group) => [group.relationKey, group]));
    if (primaryBranchQuery.data) {
      byKey.set(primaryBranchQuery.data.relationKey, {
        sourceId: primaryBranchQuery.data.sourceId,
        relationKey: primaryBranchQuery.data.relationKey,
        totalCount: primaryBranchQuery.data.totalCount,
        items: primaryBranchQuery.data.items.slice(0, 3),
      });
    }
    const makePreset = (
      key: "connections" | "purchase" | "product",
      preferred: string[] = [],
    ): RelationshipPreset => {
      const orderedViews = [...views].sort((left, right) => {
        const leftIndex = preferred.indexOf(left.key);
        const rightIndex = preferred.indexOf(right.key);
        return (
          (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
          (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
        );
      });
      return {
        key,
        label: presetLabel(entity, key),
        groups: orderedViews.map((view) => {
          const group = byKey.get(view.key);
          return {
            key: view.key,
            label: view.label,
            totalCount: group?.totalCount ?? 0,
            items:
              view.key === primaryBranchQuery.data?.relationKey
                ? primaryBranchQuery.data.items
                : group?.items,
            hasMore:
              view.key === primaryBranchQuery.data?.relationKey
                ? primaryBranchQuery.data.nextOffset !== null
                : (group?.totalCount ?? 0) > (group?.items.length ?? 0),
          };
        }),
      };
    };

    if (entity === "vendor") {
      return [
        makePreset("purchase", [
          "vendor.purchases",
          "vendor.expenses",
          "vendor.transactions",
        ]),
        makePreset("product", ["vendor.products", "vendor.purchases"]),
        makePreset("connections"),
      ];
    }
    return [makePreset("connections")];
  }, [entity, groups, primaryBranchQuery.data, views]);

  const loadChildren = useCallback(
    async ({
      relationKey,
      parent,
      offset,
    }: {
      relationKey: string;
      parent?: { id: string };
      offset: number;
    }) => {
      const branchSourceId = parent?.id ?? sourceId;
      if (!branchSourceId) return { items: [], hasMore: false };
      const page = await queryClient.fetchQuery(
        api.relatedData.branch.queryOptions({
          relationKey: relationKey as (typeof relationKeys)[number],
          sourceId: branchSourceId,
          offset,
          limit: 25,
        }),
      );
      return {
        items: page.items,
        hasMore: page.nextOffset !== null,
        totalCount: page.totalCount,
      };
    },
    [api.relatedData.branch, queryClient, sourceId],
  );

  if (views.length === 0) return null;
  if (previewsLoading) {
    return (
      <p className="text-muted-foreground text-sm">Loading relationships…</p>
    );
  }
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Relationships could not be loaded.
      </p>
    );
  }
  return <RelationshipTree presets={presets} loadChildren={loadChildren} />;
}
