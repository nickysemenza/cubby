import type { VendorOut } from "@cubby/schemas/vendor";
import { Info, Receipt } from "lucide-react";
import type { FC } from "react";
import { EntityHero } from "~/app/_components/EntityHero";
import { ExternalLinkText } from "~/app/_components/ExternalLink";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { vendorMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { RelationshipSummaryTable } from "../_components/relationships/relationship-summary-table";
import { VendorPurchasesTable } from "./vendor-purchases-table";

interface VendorDetailProps {
  vendor: VendorOut;
}

/**
 * Vendor detail — deliberately thin. A vendor is a ROSTER entry, not a
 * workspace: identity plus the two rollups, and its purchases as a hop to where
 * the money actually lives (`Expense`, one level further down).
 *
 * It exists because every entity in `entities.tsx` has a detail route, so a
 * rendered vendor name is never plain truncated text (see apps/web/CLAUDE.md).
 * The contractor metadata and vendor-level documents sketched in vendor.ts are
 * the natural follow-ons; nothing here anticipates them.
 */
export const VendorDetail: FC<VendorDetailProps> = ({ vendor }) => {
  const api = useTRPC();

  const updateMutation = useUpdateMutation({
    mutationFn: api.vendor.update.mutationOptions,
    entity: "vendor",
    invalidateKeys: vendorMutationInvalidateKeys,
  });

  // Overview is edited through inline EditableCell fields, not a Form, so
  // editMode/mappings go unused — this is only here for the History section.
  const { commonSections } = useEntityDetail<VendorOut, never>({
    entity: "vendor",
    data: vendor,
  });

  // `deleteVendors` refuses while live purchases point at the vendor
  // (VENDOR_HAS_PURCHASES) — the dialog's error toast carries that message, and
  // the re-point path is `mergePurchases`, not a cascade.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: vendor.id,
    name: vendor.name,
    entityLabel: "Vendor",
    entity: "vendor",
    mutationOptions: (callbacks) =>
      api.vendor.delete.mutationOptions(callbacks),
    invalidateKeys: vendorMutationInvalidateKeys,
    redirectTo: "/vendors",
    description:
      "A vendor with purchases still pointing at it can't be deleted — move those purchases first. Otherwise this removes the vendor from the roster.",
  });

  const fields: BasicInfoField[] = [
    {
      label: "Name",
      value: (
        <EditableCell
          value={vendor.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            // Required field — a cleared name is a no-op, not a null write.
            if (!name) return;
            await updateMutation.mutateAsync({
              id: vendor.id,
              data: { name },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Website",
      value: (
        <EditableCell
          value={vendor.website}
          config={{ type: "text", placeholder: "https://…" }}
          onSave={async (website) => {
            await updateMutation.mutateAsync({
              id: vendor.id,
              data: { website },
            });
          }}
          renderValue={(v) =>
            v ? <ExternalLinkText href={v} /> : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Order URL",
      value: (
        <EditableCell
          value={vendor.orderUrlTemplate}
          config={{
            type: "text",
            placeholder: "https://…?orderID={orderId}",
          }}
          onSave={async (orderUrlTemplate) => {
            await updateMutation.mutateAsync({
              id: vendor.id,
              data: { orderUrlTemplate },
            });
          }}
          // A pattern, not a URL — it can't be followed as-is, so it renders as
          // mono text rather than a link. `{orderId}` is substituted per
          // purchase to produce the Order # links on this vendor's charges.
          renderValue={(v) =>
            v ? <span className="font-mono text-xs">{v}</span> : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Notes",
      value: (
        <EditableCell
          value={vendor.notes}
          config={{ type: "text", multiline: true, rows: 4 }}
          onSave={async (notes) => {
            await updateMutation.mutateAsync({
              id: vendor.id,
              data: { notes },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    // Read-only rollups, spelled out here as well as in the hero so the fact
    // sheet is complete. `spend` is SUM(expense.cost) over this vendor's
    // purchases' lines — never a column, and never `purchase.statedTotal`.
    {
      label: "Purchases",
      value: (
        <span className="font-mono tabular-nums">{vendor.purchaseCount}</span>
      ),
    },
    {
      label: "Spend",
      value: (
        <span className="font-mono tabular-nums">
          {formatCurrency(vendor.spend)}
        </span>
      ),
    },
  ];

  const sections: DetailSection[] = [
    {
      id: "overview",
      title: "Overview",
      icon: Info,
      placement: "supporting",
      content: <BasicInfo fields={fields} />,
    },
    {
      id: "purchases",
      title: "Purchases",
      icon: Receipt,
      // The page's primary content — everything else is metadata.
      placement: "primary",
      content: <VendorPurchasesTable vendor={vendor} />,
    },
    {
      id: "purchased-products",
      title: "Purchased products",
      icon: Receipt,
      placement: "primary",
      content: (
        <RelationshipSummaryTable
          relationKey="vendor.products"
          sourceId={vendor.id}
          columns={[
            "target",
            "acquired",
            "purchases",
            "expenses",
            "netSpend",
            "latestActivity",
          ]}
          defaultSort={{ field: "latestActivity", direction: "desc" }}
          emptyCopy="No products have been linked to this vendor's purchases yet."
          note="Expenses without a linked product are excluded."
          expenseHref={(target) =>
            `/expenses?vendor=${encodeURIComponent(vendor.id)}&productId=${encodeURIComponent(target?.id ?? "")}`
          }
        />
      ),
    },
    {
      id: "projects",
      title: "Projects",
      icon: Receipt,
      placement: "primary",
      content: (
        <RelationshipSummaryTable
          relationKey="vendor.projects"
          sourceId={vendor.id}
          columns={[
            "target",
            "purchases",
            "expenses",
            "unpriced",
            "netSpend",
            "latestActivity",
          ]}
          defaultSort={{ field: "netSpend", direction: "desc" }}
          emptyCopy="No expenses from this vendor have been assigned to projects yet."
          nullLabel="Unassigned"
          expenseHref={(target) =>
            `/expenses?vendor=${encodeURIComponent(vendor.id)}&project=${encodeURIComponent(target?.id ?? "__none__")}`
          }
        />
      ),
    },
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    { label: "Purchases", value: vendor.purchaseCount },
    { label: "Spend", value: formatCurrency(vendor.spend, 0) },
  ];
  const heroMedia = vendor.logo ? (
    <EntityHero images={[vendor.logo]} title="Logo" />
  ) : undefined;

  return (
    <Page
      variant="detail"
      entity="vendor"
      title={vendor.name}
      rawData={vendor}
      // Only the unusual state gets a placard: a roster entry no money has gone
      // to yet (the whole point of a vendor table — its free-text predecessor
      // could never hold one), which is also the only state `deleteVendors`
      // accepts. A vendor WITH purchases needs no stamp; the Purchases hero stat
      // already says how many.
      heroStamp={
        vendor.purchaseCount === 0
          ? { label: "No purchases", tone: "ink" }
          : undefined
      }
      heroStats={heroStats}
      heroMedia={heroMedia}
      heroActions={{ secondary: deleteButton }}
    >
      <DetailSections sections={sections} rawData={vendor} />
      {deleteDialog}
    </Page>
  );
};
