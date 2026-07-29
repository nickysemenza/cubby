import type { CostType, PurchaseOut, Trade } from "@cubby/schemas/project";
import { ExternalLink, Info, PackagePlus } from "lucide-react";
import { type FC, useState } from "react";
import {
  WithProductSearch,
  WithProjectSearch,
} from "~/app/_components/combobox/with-search-hook";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { TradeBadge, tradeOptions } from "~/app/projects/shared";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { VendorCell } from "~/components/entity/vendor-cell";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { entityCellClipboard } from "../_components/data-table/inventory-column-helpers";
import { useEntityDelete } from "../_components/hooks/useEntityDelete";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { ProjectSuggestionChips } from "./project-suggestion-chips";
import {
  costTypeBadgeVariant,
  costTypeLabels,
  costTypeOptions,
  futureFilterOptions,
} from "./purchase-options";
import { ReceivePurchaseDialog } from "./receive-purchase-dialog";

interface PurchaseDetailProps {
  purchase: PurchaseOut;
}

export const PurchaseDetail: FC<PurchaseDetailProps> = ({ purchase }) => {
  const api = useTRPC();
  const [receiveOpen, setReceiveOpen] = useState(false);

  const updateMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  // Common sections from entity config (History) — editMode/mappings unused
  // here since Overview is edited via inline EditableCell fields, not a Form.
  const { commonSections } = useEntityDetail<PurchaseOut, never>({
    entity: "purchase",
    data: purchase,
    mutationOptions: api.purchase.update.mutationOptions(),
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  // Record-level delete lives on the detail plate, not in a section header —
  // Overview's headerAction is the constructive "Receive into inventory".
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: purchase.id,
    name: purchase.name,
    entityLabel: "Purchase",
    mutationOptions: (callbacks) =>
      api.purchase.delete.mutationOptions(callbacks),
    invalidateKeys: purchaseMutationInvalidateKeys,
    redirectTo: "/purchases",
  });

  const fields: BasicInfoField[] = [
    {
      label: "Name",
      value: (
        <EditableCell
          value={purchase.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            if (!name) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { name },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Cost",
      value: (
        <EditableCell
          value={purchase.cost}
          config={{ type: "currency" }}
          onSave={async (cost) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { cost },
            });
          }}
          renderValue={(v) =>
            v != null ? formatCurrency(v, 0) : <NoneValue />
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
      label: "Cost Type",
      value: (
        <EditableCell
          value={purchase.costType}
          config={{ type: "select", options: costTypeOptions }}
          onSave={async (costType) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!costType) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { costType: costType as CostType },
            });
          }}
          renderValue={(ct) =>
            ct ? (
              <Badge variant={costTypeBadgeVariant[ct as CostType]}>
                {costTypeLabels[ct as CostType]}
              </Badge>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
    {
      label: "Trade",
      value: (
        <EditableCell
          value={purchase.trade}
          config={{ type: "select", options: tradeOptions }}
          onSave={async (trade) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!trade) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { trade: trade as Trade },
            });
          }}
          renderValue={(v) =>
            v ? <TradeBadge trade={v as Trade} /> : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Planned",
      value: (
        <EditableCell
          value={String(purchase.future)}
          config={{ type: "select", options: futureFilterOptions }}
          onSave={async (value) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { future: value === "true" },
            });
          }}
          renderValue={(v) =>
            v === "true" ? (
              <Badge variant="warning">Planned</Badge>
            ) : (
              <Badge variant="positive">Already made</Badge>
            )
          }
        />
      ),
    },
    {
      label: "URL",
      value: (
        <EditableCell
          value={purchase.url}
          config={{ type: "text", placeholder: "https://…" }}
          onSave={async (url) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { url },
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
    {
      label: "Vendor",
      value: (
        <EditableCell
          value={purchase.vendor}
          config={{ type: "text", placeholder: "Where from?" }}
          onSave={async (vendor) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { vendor },
            });
          }}
          renderValue={(v) => (v ? <VendorCell vendor={v} /> : <NoneValue />)}
        />
      ),
    },
    {
      label: "Order #",
      value: (
        <EditableCell
          value={purchase.orderId}
          config={{ type: "text", placeholder: "Vendor order #" }}
          onSave={async (orderId) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { orderId },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Project",
      value: (
        <EditableEntityCell
          value={
            purchase.projectId && purchase.projectName
              ? { id: purchase.projectId, name: purchase.projectName }
              : null
          }
          label="project"
          clearable
          trigger="pencil"
          onSave={async (newProjectId) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { projectId: newProjectId },
            });
          }}
          clipboard={entityCellClipboard(
            "project",
            purchase.projectId && purchase.projectName
              ? { id: purchase.projectId, name: purchase.projectName }
              : null,
            async (newProjectId) => {
              await updateMutation.mutateAsync({
                id: purchase.id,
                data: { projectId: newProjectId },
              });
            },
          )}
          SearchProvider={WithProjectSearch}
          renderValue={(v) =>
            v ? (
              <EntityInlineLink
                entity="project"
                data={{ id: v.id, name: v.name }}
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
    {
      label: "Product",
      value: (
        <EditableEntityCell
          value={
            purchase.productId && purchase.productName
              ? { id: purchase.productId, name: purchase.productName }
              : null
          }
          label="product"
          clearable
          trigger="pencil"
          onSave={async (newProductId) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { productId: newProductId },
            });
          }}
          clipboard={entityCellClipboard(
            "product",
            purchase.productId && purchase.productName
              ? { id: purchase.productId, name: purchase.productName }
              : null,
            async (newProductId) => {
              await updateMutation.mutateAsync({
                id: purchase.id,
                data: { productId: newProductId },
              });
            },
          )}
          SearchProvider={WithProductSearch}
          renderValue={(v) =>
            v ? (
              <EntityInlineLink
                entity="product"
                data={{ id: v.id, name: v.name }}
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
  ];

  const sections: DetailSection[] = [
    {
      title: "Overview",
      icon: Info,
      content: (
        <BasicInfo
          fields={fields}
          // In the footer, not beside the Project row: InfoRow's value span is
          // right-aligned and capped at 65%, which would crush the chips.
          footer={
            <ProjectSuggestionChips
              purchase={purchase}
              isPending={updateMutation.isPending}
              onAssign={async (projectId) => {
                await updateMutation.mutateAsync({
                  id: purchase.id,
                  data: { projectId },
                });
              }}
            />
          }
        />
      ),
      // Receiving is deliberately a separate, explicit act — linking a product
      // records what was bought, it never moves inventory on its own.
      headerAction: purchase.productId ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReceiveOpen(true)}
        >
          <PackagePlus />
          Receive into inventory
        </Button>
      ) : undefined,
    },
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    {
      label: "Cost",
      value: purchase.cost != null ? formatCurrency(purchase.cost, 0) : "—",
    },
    { label: "Date", value: purchase.date ?? "—" },
    {
      label: "Cost Type",
      value: purchase.costType ? (
        <Badge variant={costTypeBadgeVariant[purchase.costType]}>
          {costTypeLabels[purchase.costType]}
        </Badge>
      ) : (
        "—"
      ),
    },
  ];

  return (
    <Page
      variant="detail"
      entity="purchase"
      title={purchase.name}
      rawData={purchase}
      heroStamp={{
        label: purchase.future ? "Planned" : "Purchased",
        tone: purchase.future ? "ink" : "green",
      }}
      heroStats={heroStats}
      actions={deleteButton}
    >
      <DetailSections sections={sections} rawData={purchase} />
      {purchase.productId ? (
        <ReceivePurchaseDialog
          open={receiveOpen}
          onOpenChange={setReceiveOpen}
          productId={purchase.productId}
          purchaseName={purchase.name}
        />
      ) : null}
      {deleteDialog}
    </Page>
  );
};
