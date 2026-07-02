import type { Entity } from "@cubby/schemas/entity";
import {
  type CountableEntity,
  countableEntities,
} from "@cubby/schemas/entity-manifest";
import { countProblems } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useProblemsData } from "~/app/problems/use-problems-data";
import { Card } from "~/components/ui/card";
import { Eyebrow } from "~/components/ui/eyebrow";
import { IconTile } from "~/components/ui/icon-tile";
import { Skeleton } from "~/components/ui/skeleton";
import { entities } from "~/entities/entities";
import { useHydrated } from "~/hooks/useHydrated";
import { useIdle } from "~/hooks/useIdle";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

/**
 * Alert stat — the mockup's red "EXPIRING" block, fed by the data-problems
 * count. Red ink + red chunky frame when anything needs attention.
 */
function ProblemsStatCard({ enabled }: { enabled: boolean }) {
  // Defer the 5 cost-grouped detector invocations off the first-paint critical
  // path: they're not needed for the page to be interactive (just this badge
  // count), and firing them on hydration competes with the homepage's other
  // work on the single isolate thread. `useIdle` keeps them gated until the
  // browser is idle; combined with `enabled` (auth+hydration) it stays SSR-safe.
  const idle = useIdle();
  const ready = enabled && idle;
  const { problems, isLoading } = useProblemsData({
    staleTime: 5 * 60 * 1000,
    enabled: ready,
  });
  const count = countProblems(problems).total;
  const alert = count > 0;

  return (
    <Link to="/problems">
      <Card
        className={cn(
          "p-2 transition-colors duration-150",
          "cursor-pointer border-l-4 hover:bg-muted/50",
          alert
            ? "border-destructive/60 border-l-destructive"
            : "border-l-positive",
        )}
      >
        <div className="flex flex-col items-start gap-2">
          <IconTile
            size="sm"
            className={cn(
              alert
                ? "bg-destructive/10 text-destructive"
                : "bg-positive/10 text-positive",
            )}
          >
            <AlertTriangle />
          </IconTile>
          <div className="min-w-0 flex-1">
            {!ready || isLoading ? (
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
                alert ? "text-destructive/80" : "text-slate",
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

/** Get singular label when count is 1, otherwise use plural label */
const getCountLabel = (
  pluralLabel: string,
  count: number | undefined,
): string => {
  if (count === 1) {
    // Simple singularization: strip trailing 'S' if present
    // Special cases: Inventory stays Inventory, USDA Foods → USDA Food
    if (pluralLabel === "Inventory") return "Inventory";
    if (pluralLabel.endsWith("s")) return pluralLabel.slice(0, -1);
  }
  return pluralLabel;
};

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
          "p-2 transition-colors duration-150",
          "cursor-pointer border-l-4 hover:bg-muted/50",
          def.color.border,
        )}
      >
        <div className="flex flex-col items-start gap-2">
          <IconTile size="sm" className={cn(def.color.bg, def.color.text)}>
            <Icon />
          </IconTile>
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
            <Eyebrow className="mt-1 truncate">
              {getCountLabel(def.pluralLabel, count)}
            </Eyebrow>
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

  // One call for all seven totals: six cheap COUNT(*)s + the USDA manifest
  // count, none of which fetch or enrich a list row (see dashboard router). The
  // old per-entity `list({pageSize:1})` cards fired discarded USDA enrichment on
  // the product/ingredient/usda cards — the homepage's USDA-on-critical-path.
  const countsQuery = useQuery({
    ...api.dashboard.counts.queryOptions(),
    enabled: isAuthenticated,
  });
  const counts = countsQuery.data;

  // One card per countable entity (manifest-driven, so meal/cookbook and any
  // future entity appear automatically) plus the USDA total. usda-food has no
  // local table, so its count comes from the separate `usdaFoods` field.
  const cards: { entity: Entity; count: number | undefined }[] = [
    ...countableEntities.map((entity: CountableEntity) => ({
      entity,
      count: counts?.[entity],
    })),
    { entity: "usda-food" as Entity, count: counts?.usdaFoods },
  ];

  // While auth is still resolving the query is disabled (isLoading false), so
  // treat the pre-auth window as loading to keep the skeleton up rather than
  // flashing "0".
  const isLoading = !isAuthenticated || countsQuery.isLoading;

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-5">
      {cards.map(({ entity, count }) => (
        <StatCard
          key={entity}
          entity={entity}
          count={count}
          isLoading={isLoading}
          isError={countsQuery.isError}
        />
      ))}
      <ProblemsStatCard enabled={isAuthenticated} />
    </div>
  );
}
