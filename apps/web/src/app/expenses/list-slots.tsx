import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { lazy, Suspense } from "react";

import type { ListSlotComponent } from "~/app/_components/entity-list/list-slot-types";
import { Skeleton } from "~/components/ui/skeleton";

// The analytics view is entirely Nivo charts and its tab is unmounted until
// selected — lazy so the chart stack stays out of the default Ledger view.
const ExpenseAnalyticsView = lazy(() =>
  import("./expense-analytics-view").then((m) => ({
    default: m.ExpenseAnalyticsView,
  })),
);

const ExpenseAnalyticsSlot: ListSlotComponent = () => (
  <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
    <ExpenseAnalyticsView />
  </Suspense>
);

export const expenseListSlots = {
  analytics: ExpenseAnalyticsSlot,
} satisfies Record<ListSlotId<"expense">, ListSlotComponent>;
