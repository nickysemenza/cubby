import type { PurchaseProductOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { useState } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { RelationshipSummaryTable } from "~/app/_components/relationships/relationship-summary-table";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { StatusText } from "~/components/ui/status-text";
import {
  purchaseImportRunsError,
  purchaseImportRunsResponse,
  type PurchaseImportRunSummary,
} from "~/lib/purchase-import-run-detail";
import { purchaseLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";

import { FinancialSettlement } from "./financial-settlement";
import { LinkExpensesDialog } from "./link-expenses-dialog";
import { LinkProductsDialog } from "./link-products-dialog";
import { purchaseImportRunHref } from "./purchase-import-links";
import {
  purchaseReconciliationStatus,
  ReconciliationStatus,
  ReconciliationNote,
} from "./purchase-reconciliation";
import { purchase as purchaseOperations } from "./purchase.functions";
import { TargetedImportLaunchButton } from "./targeted-import-launch";

const EMPTY_PURCHASE_PRODUCTS: PurchaseProductOut[] = [];

/** Runs are linked through ImportRunMutation, so replay-only source claims do not appear here. */
export const PurchaseImportRuns: DetailSlotComponent<"purchase"> = ({
  record: purchase,
}) => {
  const runs = useQuery({
    queryKey: ["purchase-import", "purchase-runs", purchase.id],
    queryFn: async () => {
      const response = await fetch(
        `/api/import/runs?purchaseId=${encodeURIComponent(purchase.id)}`,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = purchaseImportRunsError.safeParse(body);
        throw new Error(
          parsed.success
            ? parsed.data.error
            : "Purchase import runs could not load.",
        );
      }
      return purchaseImportRunsResponse.parse(body).runs;
    },
  });

  const startValidation = (
    <TargetedImportLaunchButton
      targetId={purchase.id}
      targetLabel={purchaseLabel(purchase)}
      purpose="purchase_validation"
    />
  );
  if (runs.isLoading)
    return (
      <Stack gap="sm">
        {startValidation}
        <StatusText>Loading import runs…</StatusText>
      </Stack>
    );
  if (runs.isError)
    return (
      <Stack gap="sm">
        {startValidation}
        <StatusText tone="destructive">{runs.error.message}</StatusText>
      </Stack>
    );
  const importRuns = runs.data ?? [];
  if (importRuns.length === 0) {
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
        {importRuns.map((run) => (
          <PurchaseImportRunSummary key={run.publicId} run={run} />
        ))}
      </div>
    </Stack>
  );
};

function PurchaseImportRunSummary({ run }: { run: PurchaseImportRunSummary }) {
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
        {new Date(run.startedAt).toLocaleString()} · {run.trigger} ·{" "}
        {run.ordersSeen} seen · {run.imported} imported · {run.updated} updated
        · {run.skipped} skipped
      </div>
      {run.failureCode ? (
        <div className="text-destructive">{run.failureCode}</div>
      ) : null}
      <a
        className="w-fit text-xs font-medium text-primary hover:underline"
        href={purchaseImportRunHref(run.publicId)}
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
  <RelationshipSummaryTable
    relationKey="purchase.projects"
    sourceId={purchase.id}
    columns={["target", "expenses", "unpriced", "netSpend"]}
    defaultSort={{ field: "netSpend", direction: "desc" }}
    emptyCopy="No expenses on this purchase have been assigned to projects yet."
    nullLabel="Unassigned"
    expenseHref={(target) =>
      `/expenses?purchaseId=${encodeURIComponent(purchase.id)}&project=${encodeURIComponent(target?.id ?? "__none__")}`
    }
  />
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
          <Link2 />
          Attach existing expenses
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLinkProductsOpen(true)}
        >
          <Link2 />
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
