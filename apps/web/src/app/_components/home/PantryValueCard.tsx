import { WalletIcon } from "@phosphor-icons/react/dist/csr/Wallet";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { location } from "~/app/locations/location.functions";
import { Row } from "~/components/layout";
import {
  CardActionLink,
  DashboardCard,
} from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
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
 * location. The summary procedure reads only persisted direct valuations; tree
 * structure, inventory relations, products, and images stay off this path.
 */
export function PantryValueCard() {
  const questionId = useId();
  const { data, isLoading, isError, refetch } = useQuery({
    ...location.valuationSummary.queryOptions(),
  });
  const total = data?.total ?? 0;
  const bars = data?.locations ?? [];

  const inventoryAction = (
    <CardActionLink to="/inventory">Inventory</CardActionLink>
  );

  if (isLoading) {
    return (
      <DashboardCard
        icon={WalletIcon}
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
        icon={WalletIcon}
        title="Pantry value"
        action={inventoryAction}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Pantry value is unavailable right now.
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-7"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </div>
      </DashboardCard>
    );
  }

  if (bars.length === 0) {
    return (
      <DashboardCard
        icon={WalletIcon}
        title="Pantry value"
        action={inventoryAction}
      >
        <p className="text-sm text-muted-foreground">
          Add inventory to see where its value lives.
        </p>
      </DashboardCard>
    );
  }
  const max = bars[0]!.value;

  return (
    <DashboardCard
      icon={WalletIcon}
      title="Pantry value"
      description="Where is pantry value stored?"
      action={inventoryAction}
    >
      <div className="font-mono text-xl font-semibold tabular-nums">
        {formatCurrency(total)}
      </div>
      <figure className="mt-4" aria-labelledby={questionId}>
        <figcaption id={questionId} className="sr-only">
          Where is pantry value stored? Total value is {formatCurrency(total)}
          across {bars.length} locations.
          {bars.map((b) => ` ${b.name}: ${formatCurrency(b.value)}.`)}
        </figcaption>
        <Row
          align="end"
          gap="sm"
          className="h-24 border-b border-[var(--border)] px-1"
        >
          {bars.map((b, i) => (
            <div
              key={b.id}
              title={`${b.name}: ${formatCurrency(b.value)}`}
              aria-hidden="true"
              className="min-w-0 flex-1 border border-b-0 border-[var(--border)]"
              style={{
                height: `${Math.max(8, (b.value / max) * 100)}%`,
                backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
              }}
            />
          ))}
        </Row>
        <Row gap="sm" className="mt-2 px-1">
          {bars.map((b) => (
            <Link
              key={b.id}
              to="/locations/$shortcode"
              params={{ shortcode: b.id }}
              title={`${b.name}: ${formatCurrency(b.value)}`}
              className="flex min-h-11 min-w-0 flex-1 items-center justify-center truncate text-center font-mono text-2xs text-muted-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7"
            >
              {b.name}
            </Link>
          ))}
        </Row>
        <ul className="sr-only">
          {bars.map((b) => (
            <li key={b.id}>
              {b.name}: {formatCurrency(b.value)}
            </li>
          ))}
        </ul>
      </figure>
    </DashboardCard>
  );
}
