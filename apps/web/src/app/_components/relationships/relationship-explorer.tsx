import type { Entity } from "@cubby/schemas/entity";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { Button } from "~/components/ui/button";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { relatedData } from "~/lib/related-data.functions";

import {
  type RelationshipPreviewOperations,
  useRelationshipRoutePreview,
} from "./relationship-route-preview";
import { type RelationshipPreset, RelationshipTree } from "./relationship-tree";

function presetLabel(key: "connections" | "purchase" | "product") {
  if (key === "purchase") return "By purchase";
  if (key === "product") return "By product";
  return "Connections";
}

export interface RelationshipExplorerOperations extends RelationshipPreviewOperations {
  branch: typeof relatedData.branch;
}

const productionRelationshipExplorerOperations: RelationshipExplorerOperations =
  {
    previews: relatedData.previews,
    branch: relatedData.branch,
  };

/**
 * Adapts the registered graph for the outline surface. Previews make the first
 * paint inexpensive; expanding a branch continues from the same canonical SQL
 * relation through the paginated branch endpoint.
 */
export function RelationshipExplorer({
  entity,
  sourceId,
  operations = productionRelationshipExplorerOperations,
}: {
  entity: Entity;
  sourceId: string | undefined;
  operations?: RelationshipExplorerOperations;
}) {
  const queryClient = useQueryClient();
  const { groups, query, relationKeys, views } = useRelationshipRoutePreview(
    entity,
    sourceId,
    undefined,
    operations,
  );
  // Hydration-stable: whether the previews have landed differs between the SSR
  // render and the first client render (TanStack Start's query stream races
  // React's hydration), and the two branches below differ by a whole subtree.
  // `views` comes from static config, so holding this gate `true` until
  // hydration is enough. See useHydratedLoading.
  // Guarded like background-jobs-page: `query` is disabled without a `sourceId`,
  // and a disabled query's `isLoading` is already a stable `false`. (The
  // `relationKeys.length` half of `enabled` cannot bite here — an empty
  // `relationKeys` means empty `views`, which returns null above.)
  const previewsHydratedLoading = useHydratedLoading(query.isLoading);
  const previewsLoading = Boolean(sourceId) && previewsHydratedLoading;
  const presets = useMemo<RelationshipPreset[]>(() => {
    const byKey = new Map(groups.map((group) => [group.relationKey, group]));
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
        label: presetLabel(key),
        groups: orderedViews.map((view) => {
          const group = byKey.get(view.key);
          return {
            key: view.key,
            label: view.label,
            totalCount: group?.totalCount ?? 0,
            items: group?.items,
            hasMore: (group?.totalCount ?? 0) > (group?.items.length ?? 0),
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
  }, [entity, groups, views]);

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
        operations.branch.queryOptions({
          // SAFETY: preview relation keys are generated from this entity's
          // registry; the dynamic tree callback has erased that correlation.
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
    [operations.branch, queryClient, sourceId],
  );

  if (views.length === 0) return null;
  if (previewsLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading relationships…</p>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Relationships could not be loaded.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (groups.every((group) => group.totalCount === 0)) {
    return <p className="text-sm text-muted-foreground">No linked records.</p>;
  }
  return <RelationshipTree presets={presets} loadChildren={loadChildren} />;
}
