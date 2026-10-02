import type { PurchaseProductOut } from "@cubby/schemas/purchase";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { RunSummary } from "~/contracts/run.contract";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { RelationshipSummaryTable } from "~/entity/relationships/relationship-summary-table";
import {
  run as runOperations,
  purchase as purchaseOperations,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { purchaseLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { NoneValue } from "~/ui/primitives/none-value";
import { StatusText } from "~/ui/primitives/status-text";

import { FinancialSettlement } from "./financial-settlement";
import { LinkExpensesDialog } from "./link-expenses-dialog";
import { LinkProductsDialog } from "./link-products-dialog";
import { runHref } from "./purchase-import-links";
import {
  purchaseReconciliationStatus,
  ReconciliationStatus,
  ReconciliationNote,
} from "./purchase-reconciliation";
import { TargetedImportLaunchButton } from "./targeted-import-launch";

const EMPTY_PURCHASE_PRODUCTS: PurchaseProductOut[] = [];

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

/** Runs are linked through their AuditLog rows, so replay-only source claims do not appear here. */
export const Runs: DetailSlotComponent<"purchase"> = ({ record: purchase }) => {
  const runsQuery = useQuery(
    runOperations.history.queryOptions({ purchaseId: purchase.id }),
  );

  const startValidation = (
    <TargetedImportLaunchButton
      targetId={purchase.id}
      targetLabel={purchaseLabel(purchase)}
      purpose="purchase_validation"
    />
  );
  if (runsQuery.isLoading)
    return (
      <Stack gap="sm">
        {startValidation}
        <StatusText>Loading import runs…</StatusText>
      </Stack>
    );
  if (runsQuery.isError)
    return (
      <Stack gap="sm">
        {startValidation}
        <StatusText tone="destructive">{runsQuery.error.message}</StatusText>
      </Stack>
    );
  const runs = runsQuery.data?.runs ?? [];
  if (runs.length === 0) {
    return (
      <Stack gap="sm">
        {startValidation}
        <StatusText>
          No import run has been recorded for this purchase.
        </StatusText>
      </Stack>
    );
  }
  return (
    <Stack gap="sm">
      {startValidation}
      <div className="grid gap-3">
        {runs.map((run) => (
          <RunSummary key={run.publicId} run={run} />
        ))}
      </div>
    </Stack>
  );
};

function RunSummary({ run }: { run: RunSummary }) {
  return (
    <div className="grid gap-1 border-b border-border pb-3 text-sm last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium">
          {run.vendorName ?? run.vendorAccountLabel ?? "Purchase import"}
        </span>
        <span className="text-muted-foreground">
          {run.purpose ? `${run.purpose.replaceAll("_", " ")} · ` : ""}
          {run.status}
        </span>
      </div>
      <div className="text-muted-foreground">
        {formatInstant(run.startedAt, "dateTime")} · {run.trigger} ·{" "}
        {run.ordersSeen} seen · {run.imported} imported · {run.updated} updated
        · {run.skipped} skipped
      </div>
      {run.failureCode ? (
        <div className="text-destructive">{run.failureCode}</div>
      ) : null}
      <a
        className="w-fit text-xs font-medium text-primary hover:underline"
        href={runHref(run.publicId)}
      >
        Open import run
      </a>
    </div>
  );
}

/** Spend on this purchase's lines, rolled up by the project they belong to. */
export const PurchaseProjectAllocation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => (
  <Stack gap="sm">
    <Row align="center" justify="between" gap="sm">
      <span className="text-sm text-muted-foreground">
        Items + shared charges
      </span>
      <span className="font-mono text-sm tabular-nums">
        {formatCurrency(purchase.expenseTotal)}
      </span>
    </Row>
    <p className="text-xs text-muted-foreground">
      Tax, shipping, fees, and discounts follow the purchase’s item project
      shares. The project totals below add up to this expense total.
    </p>
    <RelationshipSummaryTable
      relationKey="purchase.projects"
      sourceId={purchase.id}
      columns={["target", "items", "sharedCharges", "netSpend", "coverage"]}
      defaultSort={{ field: "netSpend", direction: "desc" }}
      emptyCopy="No item or shared-charge allocation is available yet."
      nullLabel="Unassigned"
      expenseHref={(target) =>
        `/expenses?purchaseId=${encodeURIComponent(purchase.id)}&project=${encodeURIComponent(target?.id ?? "__none__")}`
      }
    />
  </Stack>
);

/**
 * What the paperwork said against what the lines add up to. Stated totals
 * are a cue, never spend: the two are compared, not reconciled into each
 * other. The attach dialogs live here because they change what this
 * comparison covers.
 */
export const PurchaseReconciliation: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkProductsOpen, setLinkProductsOpen] = useState(false);
  const productsQuery = useQuery(
    purchaseOperations.products.queryOptions({ purchaseId: purchase.id }),
  );
  const linkedProducts = productsQuery.data ?? EMPTY_PURCHASE_PRODUCTS;
  // Explicitly-linked products only: the picker hides what is already
  // attached, and `purchase.products` also returns products derived from
  // this order's itemized expenses — taking every row would hide exactly
  // the products still worth linking.
  const attachedProductIds = new Set(
    linkedProducts
      .filter((item) => item.linkAttachedAt !== null)
      .map((item) => item.productId),
  );
  const status = purchaseReconciliationStatus(purchase);
  return (
    <Stack gap="sm">
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm text-muted-foreground">Stated</span>
        <span className="font-mono text-sm tabular-nums">
          {purchase.statedTotal != null ? (
            formatCurrency(purchase.statedTotal)
          ) : (
            <NoneValue />
          )}
        </span>
      </Row>
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm text-muted-foreground">Expenses</span>
        <span className="font-mono text-sm tabular-nums">
          {formatCurrency(purchase.expenseTotal)}
        </span>
      </Row>
      <Row
        align="center"
        justify="between"
        gap="sm"
        className="border-t border-border pt-2"
      >
        <ReconciliationStatus purchase={purchase} />
      </Row>
      <ReconciliationNote status={status} />
      <Row gap="sm" wrap>
        <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
          <LinkIcon />
          Attach existing expenses
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLinkProductsOpen(true)}
        >
          <LinkIcon />
          Attach products
        </Button>
      </Row>
      <LinkExpensesDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        purchase={purchase}
      />
      <LinkProductsDialog
        open={linkProductsOpen}
        onOpenChange={setLinkProductsOpen}
        purchase={purchase}
        attachedIds={attachedProductIds}
      />
    </Stack>
  );
};

export const PurchaseFinancialSettlement: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => <FinancialSettlement purchase={purchase} />;
