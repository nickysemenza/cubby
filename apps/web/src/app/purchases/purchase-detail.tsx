import type { PurchaseOut, PurchaseProductOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  Info,
  Link2,
  Package,
  ReceiptText,
  Scale,
} from "lucide-react";
import { type FC, useState } from "react";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  editableFieldOverrides,
  EntityBasicInfo,
} from "~/entities/entity-display";
import { purchaseLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";

import { WithVendorShortcodeSearch } from "../_components/combobox/with-vendor-search";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { RelationshipSummaryTable } from "../_components/relationships/relationship-summary-table";
import { FinancialSettlement } from "./financial-settlement";
import { LinkExpensesDialog } from "./link-expenses-dialog";
import { LinkProductsDialog } from "./link-products-dialog";
import { PurchaseDocuments } from "./purchase-documents";
import { PurchaseExpensesTable } from "./purchase-expenses-table";
import { PurchaseProductsTable } from "./purchase-products-table";
import {
  purchaseReconciliationStatus,
  ReconciliationBadge,
  ReconciliationNote,
} from "./purchase-reconciliation";
import { purchase as purchaseOperations } from "./purchase.functions";

const EMPTY_PURCHASE_PRODUCTS: PurchaseProductOut[] = [];

/**
 * One vendor order/receipt event: what the paperwork said (`statedTotal`, documents) and
 * what it actually cost (its expense lines). The two are compared but never
 * reconciled INTO each other — stated totals are a cue, spend is always the
 * lines.
 */
export const PurchaseDetail: FC<{ record: PurchaseOut }> = ({
  record: purchase,
}) => {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkProductsOpen, setLinkProductsOpen] = useState(false);

  const productsQuery = useQuery(
    purchaseOperations.products.queryOptions({ purchaseId: purchase.id }),
  );
  const linkedProducts = productsQuery.data ?? EMPTY_PURCHASE_PRODUCTS;
  // Explicitly-linked products only. This list feeds the link dialog's picker,
  // which hides what is already attached — and since `purchase.products` now
  // also returns products derived from this order's itemized expenses, taking
  // every row would hide exactly the products you might still want to link,
  // making an expense-derived pair impossible to promote to a real link.
  const attachedProductIds = new Set(
    linkedProducts
      .filter((item) => item.linkAttachedAt !== null)
      .map((item) => item.productId),
  );

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("purchase", "update"),
    entity: "purchase",
  });

  const status = purchaseReconciliationStatus(purchase);

  // `displayLabel`, `statedTotal` (`currency`, via `control.renderer:
  // "money"`) and `notes` are plain scalar → update {key} — generic.
  // `vendorId` is an entity-reference picker with a `filterAction`;
  // `orderId` adds a vendor order-page link beside the value; `date` keeps
  // its required-field guard (a cleared date is a no-op). All three stay
  // hand-written.
  const overrides = {
    ...editableFieldOverrides(
      "purchase",
      purchase,
      ["displayLabel", "statedTotal", "notes"],
      updateMutation.mutateAsync,
    ),
    vendorId: (record: PurchaseOut) => ({
      value: (
        <EditableEntityCell
          value={
            record.vendorId && record.vendorName
              ? {
                  id: record.vendorId,
                  shortcode: record.vendorId,
                  name: record.vendorName,
                }
              : null
          }
          label="vendor"
          trigger="pencil"
          onSave={async (vendorId) => {
            if (!vendorId) return;
            await updateMutation.mutateAsync({
              id: record.id,
              data: { vendorId },
            });
          }}
          SearchProvider={WithVendorShortcodeSearch}
          renderValue={(value) =>
            value ? (
              <EntityInlineLink
                displayImage={undefined}
                entity="vendor"
                data={{ id: value.id, name: value.name }}
                compact
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
      filterAction: record.vendorId ? (
        <EntityFilterLink
          to="/purchases"
          search={{ vendor: record.vendorId }}
          label={`Show all purchases from ${record.vendorName ?? "this vendor"}`}
        />
      ) : undefined,
    }),
    orderId: (record: PurchaseOut) => ({
      value: (
        <EditableCell
          value={record.orderId}
          config={{ type: "text", placeholder: "Vendor order / receipt #" }}
          onSave={async (orderId) => {
            await updateMutation.mutateAsync({
              id: record.id,
              data: { orderId },
            });
          }}
          // Opaque identifier, not prose — mono so it reads exactly as stored.
          // The link out to the vendor's order page is a separate icon beside
          // the value, so clicking the id itself still opens the editor.
          renderValue={(v) =>
            v ? (
              <Row align="center" gap="xs">
                <span className="font-mono">{v}</span>
                <OrderIdLink
                  orderUrl={record.orderUrl}
                  orderId={v}
                  vendorName={record.vendorName}
                />
              </Row>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    }),
    date: (record: PurchaseOut) => ({
      value: (
        <EditableCell
          value={record.date}
          config={{ type: "date" }}
          onSave={async (date) => {
            if (date === null) return;
            await updateMutation.mutateAsync({
              id: record.id,
              data: { date },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    }),
  };

  const sections: DetailSection[] = [
    // The lines ARE the purchase's money, so they lead the wide column.
    {
      id: "expenses",
      title: "Expenses",
      icon: ReceiptText,
      placement: "primary",
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
          <PurchaseExpensesTable purchaseId={purchase.id} />
        </Stack>
      ),
    },
    {
      id: "products",
      title: "Products",
      icon: Package,
      placement: "primary",
      headerAction: (
        <Row align="center" gap="sm">
          {linkedProducts.length > 0 && (
            <Badge variant="outline">{linkedProducts.length}</Badge>
          )}
          {/* Sits with the lines rather than in the page actions: it edits
              THIS section's contents, unlike Merge (which consumes other
              purchases). */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinkProductsOpen(true)}
          >
            <Link2 />
            Attach products
          </Button>
        </Row>
      ),
      content: (
        <Stack gap="sm">
          <Description>
            Which products this order acquired — from its own itemized expenses,
            plus any attached directly. Attaching is for a lump-sum or
            installment order whose expenses can&apos;t carry a product; that
            link carries no money or quantity of its own.
          </Description>
          <PurchaseProductsTable purchaseId={purchase.id} />
        </Stack>
      ),
    },
    {
      id: "project-allocation",
      title: "Project allocation",
      icon: ReceiptText,
      placement: "primary",
      content: (
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
      ),
    },
    {
      id: "documents",
      title: "Documents",
      icon: FileText,
      placement: "primary",
      content: <PurchaseDocuments purchase={purchase} />,
    },
    {
      id: "overview",
      title: "Overview",
      icon: Info,
      placement: "supporting",
      content: (
        <EntityBasicInfo
          entity="purchase"
          record={purchase}
          overrides={overrides}
        />
      ),
    },
    {
      id: "reconciliation",
      title: "Reconciliation",
      icon: Scale,
      placement: "supporting",
      content: (
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
            className="border-t border-[var(--border)] pt-2"
          >
            <ReconciliationBadge purchase={purchase} />
          </Row>
          <ReconciliationNote status={status} />
        </Stack>
      ),
    },
    {
      id: "financial-settlement",
      title: "Financial settlement",
      icon: Scale,
      placement: "supporting",
      content: <FinancialSettlement purchase={purchase} />,
    },
    // History is appended automatically by `DetailSections` for every
    // auditable entity — see `ACTIVITY_SECTION_ID` there. Not hand-wired here
    // (previously duplicated `useEntityDetail`'s `history` commonSection,
    // which this page can't use wholesale: `purchase.images` would satisfy
    // that hook's `images` section too, but that section hands the WHOLE
    // list to `EntityImageList` unpartitioned — a filed PDF invoice would
    // render as a broken thumbnail, duplicating Documents above).
  ];

  const heroStats: DetailHeroStat[] = [
    {
      label: "Vendor",
      value:
        purchase.vendorName && purchase.vendorId ? (
          <EntityInlineLink
            displayImage={undefined}
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
      // Never a "red"/error tone: posted refunds produce a neutral status, while
      // an unexplained difference stays an advisory warning rather than a blocker.
      heroStamp={
        status === "unknown"
          ? undefined
          : status === "match"
            ? { label: "Reconciles", tone: "green" }
            : status === "refund_adjusted"
              ? { label: "Refund-adjusted", tone: "ink" }
              : { label: "Needs review", tone: "ink" }
      }
      heroStats={heroStats}
      heroActions={{}}
    >
      <DetailSections sections={sections} rawData={purchase} />
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
    </Page>
  );
};
