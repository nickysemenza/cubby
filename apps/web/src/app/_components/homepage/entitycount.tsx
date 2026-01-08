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

interface StatCardPropsWithIndex extends StatCardProps {
  index: number;
}

function StatCard({ entity, count, isLoading, index }: StatCardPropsWithIndex) {
  const def = entities[entity];
  const Icon = def.lucideIcon;

  return (
    <Link to={def.routes.list}>
      <Card
        className={cn(
          "stat-card-glow group relative overflow-hidden p-3 transition-all duration-200",
          "hover:-translate-y-0.5 hover:shadow-[var(--shadow-warm-lg)]",
          "cursor-pointer border-l-4",
          "fade-in slide-in-from-bottom-2 animate-in",
          def.color.text.replace("text-", "border-l-"),
        )}
        style={{ animationDelay: `${index * 50}ms`, animationFillMode: "both" }}
      >
        <div className="relative flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br transition-all duration-200 group-hover:rotate-3 group-hover:scale-110",
              def.color.bg,
              def.color.text,
            )}
            style={{
              boxShadow:
                "inset 0 1px 2px rgba(255,255,255,0.3), inset 0 -1px 2px rgba(0,0,0,0.1)",
            }}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <div className="h-7 w-12 animate-pulse rounded bg-muted" />
            ) : (
              <p className="font-heading font-semibold text-2xl leading-none tracking-tight">
                {formatCount(count ?? 0)}
              </p>
            )}
            <p className="mt-1 truncate text-muted-foreground text-xs">
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
  const session = authClient.useSession();
  const isAuthenticated = !!session.data?.user;

  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 1 },
  };

  const results = useQueries({
    queries: [
      { ...api.location.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.product.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.inventory.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.recipe.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.ingredient.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.image.list.queryOptions(opts), enabled: isAuthenticated },
      { ...api.usda.list.queryOptions(opts), enabled: isAuthenticated },
    ],
  });

  // Entity order matches query order above
  const displayOrder: Entity[] = [
    "location",
    "product",
    "inventory",
    "recipe",
    "ingredient",
    "image",
    "usda-food",
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {displayOrder.map((entity, i) => (
        <StatCard
          key={entity}
          entity={entity}
          count={results[i]?.data?.meta.totalCount}
          isLoading={results[i]?.isLoading ?? true}
          index={i}
        />
      ))}
    </div>
  );
}
