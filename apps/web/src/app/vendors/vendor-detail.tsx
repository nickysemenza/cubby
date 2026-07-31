import type { VendorOut } from "@cubby/schemas/vendor";
import { ExternalLink, Info, Receipt } from "lucide-react";
import type { FC } from "react";
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
import { VendorChargesTable } from "./vendor-charges-table";

interface VendorDetailProps {
  vendor: VendorOut;
}

/**
 * Vendor detail — deliberately thin. A vendor is a ROSTER entry, not a
 * workspace: identity plus the two rollups, and its charges as a hop to where
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
    mutationOptions: api.vendor.update.mutationOptions(),
    invalidateKeys: vendorMutationInvalidateKeys,
  });

  // `deleteVendors` refuses while live charges point at the vendor
  // (VENDOR_HAS_PURCHASES) — the dialog's error toast carries that message, and
  // the re-point path is `mergePurchases`, not a cascade.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: vendor.id,
    name: vendor.name,
    entityLabel: "Vendor",
    entity: "vendor",
    mutationOptions: (callbacks) =>
      api.vendor.delete.mutationOptions({
        ...callbacks,
        // `vendor.delete` resolves to `void` — a vendor is out of the embedding
        // pipeline and owns no rollups to recompute, so there are no background
        // batches to report. `useEntityDelete` threads the mutation's data into
        // its side-effect summary, so hand it an empty one rather than `void`.
        onSuccess: () => callbacks.onSuccess({}),
      }),
    invalidateKeys: vendorMutationInvalidateKeys,
    redirectTo: "/vendors",
    description:
      "A vendor with charges still pointing at it can't be deleted — move those charges first. Otherwise this removes the vendor from the roster.",
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
            v ? (
              <a
                href={v}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 hover:underline"
              >
                {v}
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <NoneValue />
            )
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
    // charges' lines — never a column, and never `purchase.statedTotal`.
    {
      label: "Charges",
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
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    {
      title: "Charges",
      icon: Receipt,
      // The page's primary content — everything else is metadata.
      zone: "main",
      content: <VendorChargesTable vendor={vendor} />,
    },
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    { label: "Charges", value: vendor.purchaseCount },
    { label: "Spend", value: formatCurrency(vendor.spend, 0) },
  ];

  return (
    <Page
      variant="detail"
      entity="vendor"
      title={vendor.name}
      rawData={vendor}
      // Only the unusual state gets a placard: a roster entry no money has gone
      // to yet (the whole point of a vendor table — its free-text predecessor
      // could never hold one), which is also the only state `deleteVendors`
      // accepts. A vendor WITH charges needs no stamp; the Charges hero stat
      // already says how many.
      heroStamp={
        vendor.purchaseCount === 0
          ? { label: "No charges", tone: "ink" }
          : undefined
      }
      heroStats={heroStats}
      actions={deleteButton}
    >
      <DetailSections sections={sections} rawData={vendor} />
      {deleteDialog}
    </Page>
  );
};
