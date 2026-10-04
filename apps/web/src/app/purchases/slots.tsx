import { useQuery } from "@tanstack/react-query";
import type { FunctionComponent } from "react";

import type { CollectionActionProps } from "~/entity/entity-detail/collection-actions";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { purchaseLabel } from "~/lib/purchase-label";
import { Row, Stack } from "~/ui/layout";
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
    <Stack gap="sm">
      {mailQuery.data.items.map((mail) => (
        <article
          key={mail.messageId}
          className="border-b border-border pb-2 text-sm last:border-0"
        >
          <Row align="center" justify="between" gap="sm" className="flex-wrap">
            <span className="font-medium">{mail.subject}</span>
            <span className="text-xs text-muted-foreground">
              {formatInstant(mail.receivedAt, "dateTime")}
            </span>
          </Row>
          <div className="text-xs text-muted-foreground">{mail.sender}</div>
          {mail.events.map((event) => (
            <div key={event.id} className="mt-1 text-xs">
              {event.event} · {event.orderId ?? "Order unknown"} ·{" "}
              {event.candidates[0]?.decision ?? "Exact order evidence"}
            </div>
          ))}
          {mail.threadId ? (
            <a
              href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.threadId)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
            >
              Open Gmail conversation
            </a>
          ) : null}
          <details className="mt-1 text-xs text-muted-foreground">
            <summary>Technical details</summary>
            <div>Message ID: {mail.messageId}</div>
            {mail.threadId ? <div>Thread ID: {mail.threadId}</div> : null}
          </details>
        </article>
      ))}
    </Stack>
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
