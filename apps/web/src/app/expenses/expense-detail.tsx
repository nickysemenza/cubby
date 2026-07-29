import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import { ExternalLink, Info, PackagePlus, Receipt } from "lucide-react";
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
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
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
import { ExpenseChargeSection } from "./expense-charge-section";
import {
  costTypeBadgeVariant,
  costTypeLabels,
  costTypeOptions,
  futureFilterOptions,
} from "./expense-options";
import { ProjectSuggestionChips } from "./project-suggestion-chips";
import { ReceiveExpenseDialog } from "./receive-expense-dialog";

interface ExpenseDetailProps {
  expense: ExpenseOut;
}

export const ExpenseDetail: FC<ExpenseDetailProps> = ({ expense }) => {
  const api = useTRPC();
  const [receiveOpen, setReceiveOpen] = useState(false);

  const updateMutation = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });

  // Common sections from entity config (History) — editMode/mappings unused
  // here since Overview is edited via inline EditableCell fields, not a Form.
  const { commonSections } = useEntityDetail<ExpenseOut, never>({
    entity: "expense",
    data: expense,
    mutationOptions: api.expense.update.mutationOptions(),
    invalidateKeys: expenseMutationInvalidateKeys,
  });

  // Record-level delete lives on the detail plate, not in a section header —
  // Overview's headerAction is the constructive "Receive into inventory".
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: expense.id,
    name: expense.name,
    entityLabel: "Expense",
    mutationOptions: (callbacks) =>
      api.expense.delete.mutationOptions(callbacks),
    invalidateKeys: expenseMutationInvalidateKeys,
    redirectTo: "/expenses",
  });

  const fields: BasicInfoField[] = [
    {
      label: "Name",
      value: (
        <EditableCell
          value={expense.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            if (!name) return;
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.cost}
          config={{ type: "currency" }}
          onSave={async (cost) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.date}
          config={{ type: "date" }}
          onSave={async (date) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.costType}
          config={{ type: "select", options: costTypeOptions }}
          onSave={async (costType) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!costType) return;
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.trade}
          config={{ type: "select", options: tradeOptions }}
          onSave={async (trade) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!trade) return;
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={String(expense.future)}
          config={{ type: "select", options: futureFilterOptions }}
          onSave={async (value) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.url}
          config={{ type: "text", placeholder: "https://…" }}
          onSave={async (url) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.notes}
          config={{ type: "text", multiline: true, rows: 4 }}
          onSave={async (notes) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.vendor}
          config={{ type: "text", placeholder: "Where from?" }}
          onSave={async (vendor) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
          value={expense.orderId}
          config={{ type: "text", placeholder: "Vendor order #" }}
          onSave={async (orderId) => {
            await updateMutation.mutateAsync({
              id: expense.id,
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
            expense.projectId && expense.projectName
              ? { id: expense.projectId, name: expense.projectName }
              : null
          }
          label="project"
          clearable
          trigger="pencil"
          onSave={async (newProjectId) => {
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { projectId: newProjectId },
            });
          }}
          clipboard={entityCellClipboard(
            "project",
            expense.projectId && expense.projectName
              ? { id: expense.projectId, name: expense.projectName }
              : null,
            async (newProjectId) => {
              await updateMutation.mutateAsync({
                id: expense.id,
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
            expense.productId && expense.productName
              ? { id: expense.productId, name: expense.productName }
              : null
          }
          label="product"
          clearable
          trigger="pencil"
          onSave={async (newProductId) => {
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { productId: newProductId },
            });
          }}
          clipboard={entityCellClipboard(
            "product",
            expense.productId && expense.productName
              ? { id: expense.productId, name: expense.productName }
              : null,
            async (newProductId) => {
              await updateMutation.mutateAsync({
                id: expense.id,
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
              expense={expense}
              isPending={updateMutation.isPending}
              onAssign={async (projectId) => {
                await updateMutation.mutateAsync({
                  id: expense.id,
                  data: { projectId },
                });
              }}
            />
          }
        />
      ),
      // Receiving is deliberately a separate, explicit act — linking a product
      // records what was bought, it never moves inventory on its own.
      headerAction: expense.productId ? (
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
    // Gated on having a CHARGE, not an order id: the charge is the parent link,
    // and a third of vendor-bearing lines belong to one without the vendor ever
    // giving us an order id. Lines with no vendor recorded have no transaction to
    // show, which is the only case that leaves the panel off.
    ...(expense.purchaseId
      ? [
          {
            title: "This Charge",
            icon: Receipt,
            content: <ExpenseChargeSection expense={expense} />,
          },
        ]
      : []),
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    {
      label: "Cost",
      value: expense.cost != null ? formatCurrency(expense.cost, 0) : "—",
    },
    { label: "Date", value: expense.date ?? "—" },
    {
      label: "Cost Type",
      value: expense.costType ? (
        <Badge variant={costTypeBadgeVariant[expense.costType]}>
          {costTypeLabels[expense.costType]}
        </Badge>
      ) : (
        "—"
      ),
    },
  ];

  return (
    <Page
      variant="detail"
      entity="expense"
      title={expense.name}
      rawData={expense}
      heroStamp={{
        label: expense.future ? "Planned" : "Purchased",
        tone: expense.future ? "ink" : "green",
      }}
      heroStats={heroStats}
      actions={deleteButton}
    >
      <DetailSections sections={sections} rawData={expense} />
      {expense.productId ? (
        <ReceiveExpenseDialog
          open={receiveOpen}
          onOpenChange={setReceiveOpen}
          productId={expense.productId}
          expenseName={expense.name}
        />
      ) : null}
      {deleteDialog}
    </Page>
  );
};
