import type { InfLocation } from "@cubby/schemas/location-responses";
import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { Row } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

const BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-8)",
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
  const { data } = useQuery({
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
    const total = byLocation.reduce((sum, b) => sum + b.value, 0);
    const bars = byLocation.sort((a, b) => b.value - a.value).slice(0, 5);
    return { total, bars };
  }, [data]);

  if (bars.length === 0) return null;
  const max = bars[0]!.value;

  return (
    <DashboardCard icon={Wallet} title="Pantry value by location">
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
