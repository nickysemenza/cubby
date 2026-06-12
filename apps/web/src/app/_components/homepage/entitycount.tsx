import type { Entity } from "@cubby/schemas/entity";
import type { SortParams } from "@cubby/schemas/pagination";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { entities } from "~/entities/entities";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

/**
 * Alert stat — the mockup's red "EXPIRING" block, fed by the data-problems
 * count. Red ink + red chunky frame when anything needs attention.
 */
function ProblemsStatCard({ enabled }: { enabled: boolean }) {
  const api = useTRPC();
  // `enabled` must gate this query like the sibling StatCard queries: an
  // always-on query is idle during SSR but fetching on the client's first
  // render, so the isLoading branch diverges and hydration mismatches.
  const { data, isLoading } = useQuery({
    ...api.problems.getProblemsCount.queryOptions(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  const count = data?.total ?? 0;
  const alert = count > 0;

  return (
    <Link to="/problems">
      <Card
        className={cn(
          "p-2.5 transition-all duration-150 ease-cozy",
          "hover:-translate-x-px hover:-translate-y-px",
          "cursor-pointer border-l-4",
          alert
            ? "border-destructive/60 border-l-destructive hover:shadow-[4px_4px_0_0_oklch(from_var(--destructive)_l_c_h_/_0.55)]"
            : "border-l-positive hover:shadow-[var(--shadow-chunky-lg)]",
        )}
        style={
          alert
            ? {
                boxShadow:
                  "3px 3px 0 0 oklch(from var(--destructive) l c h / 0.55)",
              }
            : undefined
        }
      >
        <div className="flex flex-col items-start gap-1.5">
          <div
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
              alert
                ? "bg-destructive/10 text-destructive"
                : "bg-positive/10 text-positive",
            )}
          >
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <Skeleton className="h-6 w-10" />
            ) : (
              <p
                className={cn(
                  "font-mono font-semibold text-xl tabular-nums leading-none tracking-tight",
                  alert && "text-destructive",
                )}
              >
                {count}
              </p>
            )}
            <p
              className={cn(
                "mt-1 truncate font-mono text-2xs uppercase tracking-wider",
                alert ? "text-destructive/80" : "text-eyebrow",
              )}
            >
              Problems
            </p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

/** Format large numbers with compact notation (e.g., 2.1M, 15K) */
const compactFormatter = new Intl.NumberFormat("en", { notation: "compact" });
const formatCount = (count: number): string => compactFormatter.format(count);

interface StatCardProps {
  entity: Entity;
  count: number | undefined;
  isLoading: boolean;
  isError: boolean;
}

function StatCard({ entity, count, isLoading, isError }: StatCardProps) {
  const def = entities[entity];
  const Icon = def.lucideIcon;

  return (
    <Link to={def.routes.list}>
      <Card
        className={cn(
          "p-2.5 transition-all duration-150 ease-cozy",
          "hover:-translate-y-0.5 hover:shadow-[var(--shadow-chunky)]",
          "cursor-pointer border-l-4",
          def.color.text.replace("text-", "border-l-"),
        )}
      >
        <div className="flex flex-col items-start gap-1.5">
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
              <p className="font-mono font-semibold text-muted-foreground text-xl leading-none tracking-tight">
                —
              </p>
            ) : (
              <p className="font-mono font-semibold text-xl tabular-nums leading-none tracking-tight">
                {formatCount(count ?? 0)}
              </p>
            )}
            <p className="mt-1 truncate font-mono text-2xs text-eyebrow uppercase tracking-wider">
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
  // Hydration gate: the session store can resolve before React hydrates, so
  // branching on it alone makes the first client render diverge from SSR.
  const isAuthenticated = useHydrated() && !!session.data?.user;

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
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {displayOrder.map((entity, i) => (
        <StatCard
          key={entity}
          entity={entity}
          count={results[i]?.count}
          isLoading={results[i]?.isLoading ?? true}
          isError={results[i]?.isError ?? false}
        />
      ))}
      <ProblemsStatCard enabled={isAuthenticated} />
    </div>
  );
}
