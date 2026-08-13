import type { InfLocation } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { Row } from "~/components/layout";
import {
  CardActionLink,
  DashboardCard,
} from "~/components/layout/dashboard-card";
import { Skeleton } from "~/components/ui/skeleton";
import { useHydrated } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";
import { formatCurrency } from "~/lib/utils";

// Ink ladder, not the accent. Rank here is already carried by bar height and
// left-to-right order, so painting the tallest bar ultramarine spent the
// interaction color on information the chart had already conveyed — and this
// panel sits beside the spend chart, which owns the page's one loud value.
const BAR_COLORS = [
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

/**
 * Home-page ledger chart: total pantry value with a bordered bar per top
 * location. Reads each location's persisted `valuation.directValuation`
 * (location.makeTree) instead of fetching every inventory row and summing on
 * the client — see location-valuation.service.
 */
export function PantryValueCard() {
  const api = useTRPC();
  const session = authClient.useSession();
  // Hydration-gated auth (see useHydrated): keeps SSR and first client
  // render identical, and stops the query from firing Unauthorized on the
  // public home page.
  const isAuthenticated = useHydrated() && !!session.data?.user;
  const { data, isLoading, isError } = useQuery({
    ...api.location.makeTree.queryOptions(),
    enabled: isAuthenticated,
  });

  const { total, bars } = useMemo(() => {
    // Each location's direct valuation is one bar; walk the tree to collect them.
    const byLocation: { label: string; value: number }[] = [];
    const walk = (nodes: InfLocation[] | undefined) => {
      for (const node of nodes ?? []) {
        const value = node.valuation?.directValuation ?? 0;
        if (value > 0) byLocation.push({ label: node.name, value });
        walk(node.children);
      }
    };
    walk(data);
    const total = sumBy(byLocation, (b) => b.value);
    const bars = byLocation.sort((a, b) => b.value - a.value).slice(0, 5);
    return { total, bars };
  }, [data]);

  const inventoryAction = (
    <CardActionLink to="/inventory">Inventory</CardActionLink>
  );

  if (!isAuthenticated || isLoading) {
    return (
      <DashboardCard
        icon={Wallet}
        title="Pantry value"
        action={inventoryAction}
      >
        <Skeleton className="h-7 w-24" />
        <Skeleton className="mt-4 h-24 w-full" />
      </DashboardCard>
    );
  }

  if (isError) {
    return (
      <DashboardCard
        icon={Wallet}
        title="Pantry value"
        action={inventoryAction}
      >
        <p className="text-muted-foreground text-sm">
          Pantry value is unavailable right now.
        </p>
      </DashboardCard>
    );
  }

  if (bars.length === 0) {
    return (
      <DashboardCard
        icon={Wallet}
        title="Pantry value"
        action={inventoryAction}
      >
        <p className="text-muted-foreground text-sm">
          Add inventory to see where its value lives.
        </p>
      </DashboardCard>
    );
  }
  const max = bars[0]!.value;

  return (
    <DashboardCard
      icon={Wallet}
      title="Pantry value"
      description="Current value by location"
      action={inventoryAction}
    >
      <div className="font-mono font-semibold text-xl tabular-nums">
        {formatCurrency(total)}
      </div>
      <Row
        align="end"
        gap="sm"
        className="mt-4 h-24 border-[var(--border)] border-b px-1"
      >
        {bars.map((b, i) => (
          <div
            key={b.label}
            title={`${b.label}: ${formatCurrency(b.value)}`}
            className="min-w-0 flex-1 border border-[var(--border)] border-b-0"
            style={{
              height: `${Math.max(8, (b.value / max) * 100)}%`,
              backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
            }}
          />
        ))}
      </Row>
      <Row gap="sm" className="mt-2 px-1">
        {bars.map((b) => (
          <span
            key={b.label}
            title={`${b.label}: ${formatCurrency(b.value)}`}
            className="min-w-0 flex-1 truncate text-center font-mono text-2xs text-muted-foreground uppercase"
          >
            {b.label}
          </span>
        ))}
      </Row>
    </DashboardCard>
  );
}
