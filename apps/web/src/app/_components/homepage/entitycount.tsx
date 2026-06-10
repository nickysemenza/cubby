import type { Entity } from "@cubby/schemas/entity";
import type { SortParams } from "@cubby/schemas/pagination";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { entities } from "~/entities/entities";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

/** Format large numbers with compact notation (e.g., 2.1M, 15K) */
const compactFormatter = new Intl.NumberFormat("en", { notation: "compact" });
const formatCount = (count: number): string => compactFormatter.format(count);

interface StatCardProps {
  entity: Entity;
  count: number | undefined;
  isLoading: boolean;
  isError: boolean;
}

interface StatCardPropsWithIndex extends StatCardProps {
  index: number;
}

function StatCard({
  entity,
  count,
  isLoading,
  isError,
  index,
}: StatCardPropsWithIndex) {
  const def = entities[entity];
  const Icon = def.lucideIcon;

  return (
    <Link to={def.routes.list}>
      <Card
        emphasis="chunky"
        className={cn(
          "stat-card-glow group relative overflow-hidden p-2.5 transition-all duration-150 ease-cozy",
          "hover:-translate-x-px hover:-translate-y-px hover:shadow-[var(--shadow-chunky-lg)]",
          "cursor-pointer border-l-4",
          "fade-in slide-in-from-bottom-2 animate-in",
          def.color.text.replace("text-", "border-l-"),
        )}
        style={{ animationDelay: `${index * 50}ms`, animationFillMode: "both" }}
      >
        <div className="relative flex flex-col items-start gap-1.5">
          <div
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br",
              def.color.bg,
              def.color.text,
            )}
            style={{
              boxShadow:
                "inset 0 1px 2px rgba(255,255,255,0.3), inset 0 -1px 2px rgba(0,0,0,0.1)",
            }}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <Skeleton className="h-6 w-10" />
            ) : isError ? (
              <p className="font-heading font-semibold text-muted-foreground text-xl leading-none tracking-tight">
                —
              </p>
            ) : (
              <p className="font-heading font-semibold text-xl leading-none tracking-tight">
                {formatCount(count ?? 0)}
              </p>
            )}
            <p className="mt-1 truncate font-mono text-muted-foreground text-xs">
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
    combine: (queryResults) =>
      queryResults.map((q) => ({
        count: q.data?.meta.totalCount,
        isLoading: q.isLoading,
        isError: q.isError,
      })),
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
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {displayOrder.map((entity, i) => (
        <StatCard
          key={entity}
          entity={entity}
          count={results[i]?.count}
          isLoading={results[i]?.isLoading ?? true}
          isError={results[i]?.isError ?? false}
          index={i}
        />
      ))}
    </div>
  );
}
