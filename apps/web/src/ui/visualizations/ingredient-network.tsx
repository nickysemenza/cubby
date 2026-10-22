import type {
  IngredientEdge,
  IngredientNode,
} from "@cubby/schemas/ingredient-cooccurrence";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { recipe } from "~/integrations/tanstack-query/generated/catalog/recipe.gen";
import { NetworkChart } from "~/ui/charts/network-chart";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

export default function IngredientNetwork() {
  const { data, isError, error, isLoading, refetch } = useQuery(
    recipe.getIngredientCooccurrence.queryOptions({ minEdgeWeight: 2 }),
  );

  return (
    <Visualization
      state={visualizationState({
        data,
        isLoading,
        error: isError ? error : null,
        empty: !data?.nodes.length || !data?.edges.length,
        onRetry: () => void refetch(),
      })}
      message="No ingredient relationships to display"
      subMessage="Add more recipes with shared ingredients to see connections"
      height={400}
    >
      {data && <NetworkGraph nodes={data.nodes} edges={data.edges} />}
    </Visualization>
  );
}

function NetworkGraph({
  nodes,
  edges,
}: {
  nodes: IngredientNode[];
  edges: IngredientEdge[];
}) {
  const data = useMemo(
    () => ({
      nodes: nodes.map((node) => ({
        id: node.id,
        label: node.name,
        color: "var(--chart-3)",
        size: 12 + Math.min(32, Math.sqrt(node.recipeCount) * 4),
      })),
      links: edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        weight: edge.weight,
      })),
    }),
    [nodes, edges],
  );
  return (
    <div>
      <NetworkChart
        data={data}
        summary={`${nodes.length} ingredients, ${edges.length} co-occurrence connections. Node size shows recipe count; line thickness shows shared recipes.`}
      />
      <details className="border-t border-border p-2 text-xs">
        <summary className="cursor-pointer">
          Ingredients and shared recipes
        </summary>
        <nav
          aria-label="Connected ingredients"
          className="flex flex-wrap gap-2 py-2"
        >
          {nodes.map((node) => (
            <Link
              key={node.id}
              to="/ingredients/$shortcode"
              params={{ shortcode: node.id }}
              className="inline-flex min-h-11 items-center text-primary hover:underline sm:min-h-0"
            >
              {node.name} ({node.recipeCount})
            </Link>
          ))}
        </nav>
        <ul className="max-h-64 space-y-2 overflow-auto">
          {edges.map((edge) => (
            <li key={`${edge.source}-${edge.target}`}>
              <span className="font-medium">
                {nodes.find((node) => node.id === edge.source)?.name} +{" "}
                {nodes.find((node) => node.id === edge.target)?.name}
              </span>
              {": "}
              {countLabel(edge.weight, "recipe")}
              <ul className="pl-3">
                {edge.recipes.map((recipe) => (
                  <li key={recipe.id}>
                    <Link
                      to="/recipes/$shortcode"
                      params={{ shortcode: recipe.id }}
                      className="inline-flex min-h-11 items-center text-primary hover:underline sm:min-h-0"
                    >
                      {recipe.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
