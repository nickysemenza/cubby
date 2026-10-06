import { useQuery } from "@tanstack/react-query";
import type { FunctionComponent } from "react";

import { gmailThreadUrl } from "~/app/vendors/order-mail-worklist";
import type { CollectionActionProps } from "~/entity/entity-detail/collection-actions";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { purchaseLabel } from "~/lib/purchase-label";
import { StatusText } from "~/ui/primitives/status-text";

import { TargetedImportLaunchButton } from "./targeted-import-launch";

export const PurchaseOrderMail: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => {
  const mailQuery = useQuery(
    purchaseOperations.orderMail.queryOptions({ purchaseId: purchase.id }),
  );
  if (mailQuery.isPending) return <StatusText>Loading order email…</StatusText>;
  if (mailQuery.isError)
    return (
      <StatusText tone="destructive">{mailQuery.error.message}</StatusText>
    );
  if (mailQuery.data.items.length === 0)
    return <StatusText>No order email is linked to this Purchase.</StatusText>;
  return (
    <div className="text-sm">
      <ul className="divide-y divide-border">
        {mailQuery.data.items.map((mail) => (
          <li
            key={mail.messageId}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1"
          >
            <span className="shrink-0 text-xs font-medium">
              {mail.events
                .map(
                  (event) =>
                    `${event.event} · ${event.orderId ?? "Order unknown"} · ${
                      event.candidates[0]?.decision ?? "Exact order evidence"
                    }`,
                )
                .join("; ")}
            </span>
            <span className="min-w-0 truncate" title={mail.sender}>
              {mail.subject}
            </span>
            <span
              className="font-mono text-xs text-muted-foreground tabular-nums"
              title={formatInstant(mail.receivedAt, "dateTime")}
            >
              {formatInstant(mail.receivedAt, "monthDay")}
            </span>
            {mail.threadId ? (
              <a
                href={gmailThreadUrl(mail.threadId)}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-primary hover:underline"
              >
                Open Gmail conversation
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Technical details</summary>
        {mailQuery.data.items.map((mail) => (
          <div key={mail.messageId} className="font-mono">
            Message ID: {mail.messageId}
            {mail.threadId ? ` · Thread ID: ${mail.threadId}` : null}
          </div>
        ))}
      </details>
    </div>
  );
};

/** Import runs are linked through their AuditLog rows; the server's report lists them. */
export const Runs: DetailSlotComponent<"purchase"> = ({ record: purchase }) => (
  <EntityReportSlot slot="purchase.runs" id={purchase.id} record={purchase} />
);

/** Launch action of the runs report. */
export const ValidatePurchaseAction: FunctionComponent<
  CollectionActionProps<"purchase">
> = ({ record: purchase }) => (
  <TargetedImportLaunchButton
    targetId={purchase.id}
    targetLabel={purchaseLabel(purchase)}
    purpose="purchase_validation"
  />
);

/**
 * What the paperwork said against what the lines add up to. Stated totals are a cue, never spend:
 * the stated and expense figures, the verdict (the shared `reconciliation`) and its note are the
 * report's. The attach verbs sit here because they change what this comparison covers.
 */
export const PurchaseReconciliation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => (
  <EntityReportSlot
    slot="purchase.reconciliation"
    id={purchase.id}
    record={purchase}
    entity="purchase"
  />
);
