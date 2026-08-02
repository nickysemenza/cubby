import type { Entity } from "@cubby/schemas/entity";
import {
  type CountableEntity,
  countableEntities,
} from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Eyebrow } from "~/components/ui/eyebrow";
import { Skeleton } from "~/components/ui/skeleton";
import { entities } from "~/entities/entities";
import { useHydrated } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";

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

/**
 * StatLedger — a single hairline-ruled strip of entity counts, the Warm-Paper
 * Ledger's native idiom (mono tabular numbers over eyebrow labels, no card
 * chrome or per-entity color). Problems are surfaced separately by
 * ProblemsBanner, so this strip is purely the countable-entity totals.
 */
export default function EntityCount() {
  const api = useTRPC();
  const session = authClient.useSession();
  // Hydration gate: the session store can resolve before React hydrates, so
  // branching on it alone makes the first client render diverge from SSR.
  const isAuthenticated = useHydrated() && !!session.data?.user;

  // One call for every local count plus the USDA manifest count, none of which
  // fetch or enrich a list row (see dashboard router). The
  // old per-entity `list({pageSize:1})` cards fired discarded USDA enrichment on
  // the product/ingredient/usda cards — the homepage's USDA-on-critical-path.
  const countsQuery = useQuery({
    ...api.dashboard.counts.queryOptions(),
    enabled: isAuthenticated,
  });
  const counts = countsQuery.data;

  // One cell per countable entity (manifest-driven, so meal/cookbook and any
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
    <div className="overflow-hidden border border-[var(--border)] bg-card">
      {/* 16 cells → exact 8/4/2-column rows at each responsive tier. */}
      <div className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-4 xl:grid-cols-8">
        {cards.map(({ entity, count }) => {
          const def = entities[entity];
          return (
            <Link
              key={entity}
              to={def.routes.list}
              // Negative margins hide the outer edge doubling where the grid's
              // divide-* hairlines meet the container border (ledger idiom).
              className="-mr-px -mb-px flex flex-col gap-1 p-2 transition-colors hover:bg-muted/50"
            >
              {isLoading ? (
                <Skeleton className="h-6 w-10" />
              ) : countsQuery.isError ? (
                <p className="font-mono font-semibold text-muted-foreground text-xl leading-none tracking-tight">
                  —
                </p>
              ) : (
                <p className="font-mono font-semibold text-xl tabular-nums leading-none tracking-tight">
                  {formatCount(count ?? 0)}
                </p>
              )}
              <Eyebrow className="truncate">
                {getCountLabel(def.pluralLabel, count)}
              </Eyebrow>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
