import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import type { SortParams } from "~/schemas/pagination";
import { useTRPC } from "~/trpc/react";

/** Format large numbers with compact notation (e.g., 2.1M, 15K) */
const compactFormatter = new Intl.NumberFormat("en", { notation: "compact" });
const formatCount = (count: number): string => compactFormatter.format(count);

interface StatCardProps {
  entity: Entity;
  count: number | undefined;
  isLoading: boolean;
}

function StatCard({ entity, count, isLoading }: StatCardProps) {
  const def = entities[entity];
  const Icon = def.lucideIcon;

  return (
    <Link to={`/${def.basePath}` as "/locations"}>
      <Card
        className={cn(
          "p-2.5 transition-all duration-200",
          "hover:border-muted-foreground/30 hover:shadow-md",
          "cursor-pointer",
        )}
      >
        <div className="flex items-center gap-2">
          <div className={cn("rounded p-1.5", def.color.bg, def.color.text)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <div className="h-5 w-8 animate-pulse rounded bg-muted" />
            ) : (
              <p className="font-semibold text-base leading-none">
                {formatCount(count ?? 0)}
              </p>
            )}
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {def.pluralLabel}
            </p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function EntityCount() {
  const api = useTRPC();
  const { data: activeOrg } = authClient.useActiveOrganization();

  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 1 },
  };

  const results = useQueries({
    queries: [
      { ...api.location.list.queryOptions(opts), enabled: !!activeOrg },
      { ...api.product.list.queryOptions(opts), enabled: !!activeOrg },
      { ...api.inventoryItem.list.queryOptions(opts), enabled: !!activeOrg },
      { ...api.recipe.list.queryOptions(opts), enabled: !!activeOrg },
      { ...api.ingredient.list.queryOptions(opts), enabled: !!activeOrg },
      { ...api.image.list.queryOptions(opts), enabled: !!activeOrg },
      { ...api.usda.list.queryOptions(opts), enabled: !!activeOrg },
    ],
  });

  // Entity order matches query order above
  const displayOrder: Entity[] = [
    "location",
    "product",
    "inventory-item",
    "recipe",
    "ingredient",
    "image",
    "usda-food",
  ];

  if (!activeOrg) {
    return (
      <p className="text-muted-foreground text-sm">
        Select an organization to view entity counts
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {displayOrder.map((entity, i) => (
        <StatCard
          key={entity}
          entity={entity}
          count={results[i].data?.meta.totalCount}
          isLoading={results[i].isLoading}
        />
      ))}
    </div>
  );
}
