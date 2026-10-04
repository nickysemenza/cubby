import {
  financialTransactionShortcode,
  vendorAccountShortcode,
} from "@cubby/schemas/identifiers";
import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import type { SectionActionComponent } from "~/entity/entity-detail/section-actions";
import { vendor } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Button } from "~/ui/primitives/button";
import { TechnicalError } from "~/ui/primitives/technical-error";

/**
 * A member's statement charges still waiting for an order on this Vendor account, as the
 * report's rows; checking some and starting a search is the one verb below.
 */
export const VendorAccountChargeSearch: DetailSlotComponent<
  "vendorAccount"
> = ({ record }) => (
  <EntityReportSlot
    slot="vendorAccount.charge-search"
    id={record.id}
    record={record}
    entity="vendorAccount"
  />
);

/**
 * Start one browser run for exactly the statement charges checked in the list. Which charges
 * can be checked is the section read's call (`disabledReason` per row); the server refuses the
 * whole selection again if any charge is no longer searchable, so nothing partial starts.
 */
export const SearchChargesAction: SectionActionComponent<"vendorAccount"> = ({
  record,
  action,
  selection,
  clearSelection,
}) => {
  const start = useActionMutation({
    mutationFn: vendor.startChargeRun.mutationOptions,
    success: "Charge search started",
    onSuccess: clearSelection,
  });
  return (
    <>
      <Button
        type="button"
        size="sm"
        disabled={
          selection.length === 0 ||
          start.isPending ||
          action.disabledReason !== null
        }
        onClick={() =>
          start.mutate({
            vendorAccountId: vendorAccountShortcode.parse(record.id),
            transactionIds: selection.map((id) =>
              financialTransactionShortcode.parse(id),
            ),
          })
        }
      >
        {start.isPending
          ? "Starting search…"
          : `${action.label} (${selection.length})`}
      </Button>
      {selection.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={clearSelection}
        >
          Clear selection
        </Button>
      ) : null}
      {start.data ? (
        <Link
          to="/runs/$shortcode"
          params={{ shortcode: start.data.runId }}
          className="text-primary underline underline-offset-4"
        >
          View charge search
        </Link>
      ) : null}
      {start.error ? (
        <TechnicalError error={getErrorMessage(start.error)} />
      ) : null}
    </>
  );
};
