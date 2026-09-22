import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import { recipe } from "~/app/recipes/recipe.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Stack } from "~/components/layout";

import type { GraphData, GraphFilters } from "./dependency-graph-model";
import { DependencyGraphViewer } from "./dependency-graph-viewer";
import { EntityGraphControls } from "./entity-graph-controls";

export function RecipeDependencyGraph({
  cookbookId,
  filters,
  onChange,
  search,
  onSearch,
}: {
  cookbookId?: CookbookShortcode;
  filters: GraphFilters;
  onChange: (patch: Partial<GraphFilters>) => void;
  search: string;
  onSearch: (value: string) => void;
}) {
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useQuery(
    recipe.getDependencyGraph.queryOptions({ cookbookId }),
  );
  const graph = useMemo<GraphData>(
    () => ({
      nodes:
        data?.nodes.map((node) => ({
          id: node.id,
          kind: "recipe" as const,
          name: node.name,
          metadata: node.cookbookName ? [node.cookbookName] : [],
          parentId: node.cookbookId,
          external: node.external,
          href: router.buildLocation({
            to: "/recipes/$shortcode",
            params: { shortcode: node.id },
          }).href,
        })) ?? [],
      edges:
        data?.edges.map((edge) => ({
          ...edge,
          kind: "dependency",
          label: "uses",
        })) ?? [],
    }),
    [data, router],
  );
  if (isLoading) return <output>Loading recipe graph…</output>;
  if (isError)
    return (
      <ErrorDisplay
        error={error}
        title="recipe relationships"
        onRetry={() => void refetch()}
      />
    );
  return (
    <Stack gap="md">
      <EntityGraphControls
        search={search}
        onSearch={onSearch}
        data={graph}
        filters={filters}
        onChange={onChange}
        recipes
      />
      <DependencyGraphViewer data={graph} filters={filters} />
    </Stack>
  );
}
