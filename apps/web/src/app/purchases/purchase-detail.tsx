import type { ExpenseOut } from "@cubby/schemas/project";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { reconcilePurchase } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import {
  Clock,
  FileText,
  Info,
  Link2,
  Merge,
  ReceiptText,
  Scale,
} from "lucide-react";
import { type FC, useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ExpenseList } from "~/app/projects/shared";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { WithVendorShortcodeSearch } from "../_components/combobox/with-vendor-search";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { LinkExpensesDialog } from "./link-expenses-dialog";
import { MergePurchasesDialog } from "./merge-purchases-dialog";
import { PurchaseDocuments } from "./purchase-documents";
import {
  ReconciliationBadge,
  ReconciliationNote,
  reconciliationDelta,
} from "./purchase-reconciliation";

const NO_EXPENSES: ExpenseOut[] = [];

/**
 * One vendor transaction: what the paperwork said (`statedTotal`, documents) and
 * what it actually cost (its expense lines). The two are compared but never
 * reconciled INTO each other — stated totals are a cue, spend is always the
 * lines.
 */
export const PurchaseDetail: FC<{ purchase: PurchaseOut }> = ({ purchase }) => {
  const api = useTRPC();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const { data: expenses = NO_EXPENSES } = useQuery(
    api.purchase.expenses.queryOptions(purchase.id),
  );

  const updateMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  // `deletePurchases` NULLs `purchaseId` on the purchase's expenses rather than
  // deleting them — the lines survive as unattached ledger rows — so this needs
  // no dependency guard, but the copy should say where the money goes.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: purchase.id,
    name: purchaseLabel(purchase),
    entityLabel: "Purchase",
    entity: "purchase",
    mutationOptions: (callbacks) =>
      // Purchase's delete is hand-rolled and returns void rather than the crud
      // factory's side-effect summary, so there's nothing to forward into the
      // hook's "saved with background work" toast.
      api.purchase.delete.mutationOptions({
        onSuccess: () => callbacks.onSuccess({}),
        onError: callbacks.onError,
      }),
    invalidateKeys: purchaseMutationInvalidateKeys,
    redirectTo: "/purchases",
    description:
      "The purchase and its documents go; its expenses stay in the ledger, unattached to any purchase.",
  });

  const status = reconcilePurchase(purchase);
  const delta = reconciliationDelta(purchase);

  const fields: BasicInfoField[] = [
    {
      label: "Vendor",
      value: (
        <EditableEntityCell
          value={
            purchase.vendorId && purchase.vendorName
              ? {
                  id: purchase.vendorId,
                  shortcode: purchase.vendorId,
                  name: purchase.vendorName,
                }
              : null
          }
          label="vendor"
          trigger="pencil"
          onSave={async (vendorId) => {
            if (!vendorId) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { vendorId },
            });
          }}
          SearchProvider={WithVendorShortcodeSearch}
          renderValue={(value) =>
            value ? (
              <EntityInlineLink
                entity="vendor"
                data={{
                  id: value.id,
                  name: value.name,
                }}
                compact
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
    {
      label: "Order #",
      value: (
        <EditableCell
          value={purchase.orderId}
          config={{ type: "text", placeholder: "Vendor order / receipt #" }}
          onSave={async (orderId) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { orderId },
            });
          }}
          // Opaque identifier, not prose — mono so it reads exactly as stored.
          renderValue={(v) =>
            v ? <span className="font-mono">{v}</span> : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Date",
      value: (
        <EditableCell
          value={purchase.date}
          config={{ type: "date" }}
          onSave={async (date) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { date },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Stated total",
      value: (
        <EditableCell
          value={purchase.statedTotal}
          config={{ type: "currency" }}
          onSave={async (statedTotal) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { statedTotal },
            });
          }}
          renderValue={(v) => (v != null ? formatCurrency(v) : <NoneValue />)}
        />
      ),
    },
    {
      label: "Notes",
      value: (
        <EditableCell
          value={purchase.notes}
          config={{ type: "text", multiline: true, rows: 4 }}
          onSave={async (notes) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { notes },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
  ];

  const sections: DetailSection[] = [
    // The lines ARE the purchase's money, so they lead the wide column.
    {
      title: "Expenses",
      icon: ReceiptText,
      zone: "main",
      headerAction: (
        <Row align="center" gap="sm">
          {purchase.expenseCount > 0 && (
            <Badge variant="outline">{purchase.expenseCount}</Badge>
          )}
          <span className="font-mono text-sm tabular-nums">
            {formatCurrency(purchase.expenseTotal)}
          </span>
          {/* Sits with the lines rather than in the page actions: it edits THIS
              section's contents, unlike Merge (which consumes other purchases). */}
          <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
            <Link2 />
            Attach existing expenses
          </Button>
        </Row>
      ),
      content: (
        <Stack gap="sm">
          <Description>
            Expenses are this purchase&apos;s categorized spend lines. Every
            dollar lives on them, not on the stated total.
          </Description>
          <ExpenseList expenses={expenses} />
        </Stack>
      ),
    },
    {
      title: "Documents",
      icon: FileText,
      zone: "main",
      content: <PurchaseDocuments purchase={purchase} />,
    },
    {
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    {
      title: "Reconciliation",
      icon: Scale,
      content: (
        <Stack gap="sm">
          <Row align="center" justify="between" gap="sm">
            <span className="text-muted-foreground text-sm">Stated</span>
            <span className="font-mono text-sm tabular-nums">
              {purchase.statedTotal != null ? (
                formatCurrency(purchase.statedTotal)
              ) : (
                <NoneValue />
              )}
            </span>
          </Row>
          <Row align="center" justify="between" gap="sm">
            <span className="text-muted-foreground text-sm">Expenses</span>
            <span className="font-mono text-sm tabular-nums">
              {formatCurrency(purchase.expenseTotal)}
            </span>
          </Row>
          <Row
            align="center"
            justify="between"
            gap="sm"
            className="border-[var(--border)] border-t pt-2"
          >
            <ReconciliationBadge purchase={purchase} />
            {delta !== null && delta !== 0 && (
              <span className="font-mono text-sm tabular-nums">
                {formatCurrency(delta)}
              </span>
            )}
          </Row>
          <ReconciliationNote status={status} />
        </Stack>
      ),
    },
    {
      // Rendered inline rather than through `useEntityDetail`'s commonSections.
      // `purchase.images` would now satisfy that hook's `images` section, but
      // that section hands the WHOLE list to `EntityImageList` unpartitioned —
      // so a filed PDF invoice would render as a broken thumbnail, in a second
      // card duplicating Documents above. This is the same content the helper
      // produces for `history`, minus that.
      title: "History",
      icon: Clock,
      content: (
        <AuditLogList
          entityType="purchase"
          entityId={purchase.id}
          showEntityLink={false}
        />
      ),
    },
  ];

  const heroStats: DetailHeroStat[] = [
    {
      label: "Vendor",
      value:
        purchase.vendorName && purchase.vendorId ? (
          <EntityInlineLink
            entity="vendor"
            data={{
              id: purchase.vendorId,
              name: purchase.vendorName,
            }}
            truncate
          />
        ) : (
          "—"
        ),
    },
    { label: "Date", value: purchase.date ?? "—" },
    { label: "Expenses", value: purchase.expenseCount },
    {
      label: "Expense total",
      value: formatCurrency(purchase.expenseTotal, 0),
    },
    {
      label: "Stated",
      value:
        purchase.statedTotal != null
          ? formatCurrency(purchase.statedTotal, 0)
          : "—",
    },
  ];

  return (
    <Page
      variant="detail"
      entity="purchase"
      title={purchaseLabel(purchase)}
      rawData={purchase}
      // Never a "red"/error tone: a purchase whose lines disagree with its stated
      // total is frequently correct (a partial refund), so the strongest signal
      // this page gives is the warning-toned badge in the Reconciliation card.
      heroStamp={
        status === "unknown"
          ? undefined
          : status === "match"
            ? { label: "Reconciles", tone: "green" }
            : { label: "Check total", tone: "ink" }
      }
      heroStats={heroStats}
      actions={
        <Row align="center" gap="sm">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMergeOpen(true)}
          >
            <Merge />
            Merge purchases
          </Button>
          {deleteButton}
        </Row>
      }
    >
      <DetailSections sections={sections} rawData={purchase} />
      <MergePurchasesDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        purchase={purchase}
      />
      <LinkExpensesDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        purchase={purchase}
      />
      {deleteDialog}
    </Page>
  );
};
