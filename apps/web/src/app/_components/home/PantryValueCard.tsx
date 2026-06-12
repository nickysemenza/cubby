import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { useMemo } from "react";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import type { InventoryItem } from "../locations/calculate-inventory-valuation";

const BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-8)",
];

/**
 * Home-page ledger chart: total pantry value with a bordered bar per top
 * location (the mockup's "spend by category" treatment, fed by real data).
 * Uses precomputed item valuations — no WASM, one inventory.list query.
 */
export function PantryValueCard() {
  const api = useTRPC();
  const session = authClient.useSession();
  // Hydration-gated auth (see useHydrated): keeps SSR and first client
  // render identical, and stops the query from firing Unauthorized on the
  // public home page.
  const isAuthenticated = useHydrated() && !!session.data?.user;
  const { data } = useQuery({
    ...api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 1000 },
      filters: {},
    }),
    enabled: isAuthenticated,
  });

  const { total, bars } = useMemo(() => {
    const items = (data?.items ?? []) as InventoryItem[];
    const byLocation = new Map<string, number>();
    let total = 0;
    for (const item of items) {
      const v = item.valuation;
      if (v == null || v <= 0) continue;
      total += v;
      const key = item.location?.name ?? "Unplaced";
      byLocation.set(key, (byLocation.get(key) ?? 0) + v);
    }
    const bars = Array.from(byLocation, ([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
    return { total, bars };
  }, [data]);

  if (bars.length === 0) return null;
  const max = bars[0]!.value;

  return (
    <DashboardCard icon={Wallet} title="Pantry value by location">
      <div className="font-mono font-semibold text-xl tabular-nums">
        {formatCurrency(total)}
      </div>
      <div className="mt-3 flex h-24 items-end gap-3 border-[var(--border-chunky)] border-b px-1">
        {bars.map((b, i) => (
          <div
            key={b.label}
            title={`${b.label}: ${formatCurrency(b.value)}`}
            className="min-w-0 flex-1 rounded-t border border-[var(--border-chunky)] border-b-0"
            style={{
              height: `${Math.max(8, (b.value / max) * 100)}%`,
              backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex gap-3 px-1">
        {bars.map((b) => (
          <span
            key={b.label}
            title={`${b.label}: ${formatCurrency(b.value)}`}
            className="min-w-0 flex-1 truncate text-center font-mono text-2xs text-muted-foreground uppercase"
          >
            {b.label}
          </span>
        ))}
      </div>
    </DashboardCard>
  );
}
