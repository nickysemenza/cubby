import { vendorAccountShortcode } from "@cubby/schemas/identifiers";
import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import type { SectionActionComponent } from "~/entity/entity-detail/section-actions";
import { run } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Button } from "~/ui/primitives/button";
import { TechnicalError } from "~/ui/primitives/technical-error";

export const VendorAccountSync: DetailSlotComponent<"vendorAccount"> = ({
  record,
}) => (
  <EntityReportSlot
    slot="vendorAccount.sync"
    id={record.id}
    record={record}
    entity="vendorAccount"
  />
);

export const SyncAccountAction: SectionActionComponent<"vendorAccount"> = ({
  record,
  action,
}) => {
  const start = useActionMutation({
    mutationFn: run.startSync.mutationOptions,
    success: "Sync submitted",
  });
  return (
    <>
      <Button
        type="button"
        size="sm"
        disabled={start.isPending || action.disabledReason !== null}
        onClick={() =>
          start.mutate({
            vendorAccountId: vendorAccountShortcode.parse(record.id),
          })
        }
      >
        {start.isPending ? "Submitting…" : action.label}
      </Button>
      {start.data ? (
        <Link
          to="/runs/$shortcode"
          params={{ shortcode: start.data.runId }}
          className="text-primary underline underline-offset-4"
        >
          View sync
        </Link>
      ) : null}
      {start.error ? (
        <TechnicalError error={getErrorMessage(start.error)} />
      ) : null}
    </>
  );
};
