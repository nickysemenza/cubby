import type { ExpenseVendorAggregate } from "@cubby/schemas/project";
import { StorefrontIcon } from "@phosphor-icons/react/dist/csr/Storefront";

import { RankedBarBreakdown } from "~/app/_components/charts/kit";

/**
 * Net spend by vendor — sourced from `expense.analytics`'s `byVendor`
 * aggregate. The twin of `ProjectBreakdown`, down to the top-12-by-absolute-net
 * cut, so a roster of ~114 vendors doesn't produce an unreadably tall bar list.
 *
 * Expenses with no Purchase attached (no Vendor recorded) are excluded
 * server-side by the inner join, so these bars deliberately do NOT sum to the
 * Net stat tile above — see `repo/expense/analytics.ts`.
 */
export function VendorBreakdown({
  byVendor,
}: {
  byVendor: ExpenseVendorAggregate[];
}) {
  return (
    <RankedBarBreakdown
      data={byVendor}
      valueKey="net"
      labelKey="vendorName"
      emptyIcon={StorefrontIcon}
      emptyTitle="No vendor-linked expenses."
    />
  );
}
