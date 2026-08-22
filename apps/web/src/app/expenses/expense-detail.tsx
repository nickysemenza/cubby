import type {
  ExpenseLineBasis,
  ExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import type { CostType, ExpenseOut, Trade } from "@cubby/schemas/project";
import { Info, PackagePlus, Receipt, Split } from "lucide-react";
import { type FC, useState } from "react";
import {
  WithProductSearch,
  WithProjectSearch,
} from "~/app/_components/combobox/with-search-hook";
import { WithVendorSearch } from "~/app/_components/combobox/with-vendor-search";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ExternalLinkText } from "~/app/_components/ExternalLink";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { tradeOptions } from "~/app/projects/shared";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { persistedVendorId } from "~/lib/vendor-logo";
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
import {
  costTypeBadgeVariant,
  costTypeLabels,
  costTypeOptions,
  expenseLineBasisBadgeVariant,
  expenseLineBasisLabels,
  expenseLineBasisOptions,
  expenseLineKindBadgeVariant,
  expenseLineKindLabels,
  expenseLineKindOptions,
  futureFilterOptions,
} from "./expense-options";
import { ExpensePurchaseSection } from "./expense-purchase-section";
import { ProjectSuggestionChips } from "./project-suggestion-chips";
import { ReceiveExpenseDialog } from "./receive-expense-dialog";
import { SplitExpenseDialog } from "./split-expense-dialog";

interface ExpenseDetailProps {
  expense: ExpenseOut;
}

export const ExpenseDetail: FC<ExpenseDetailProps> = ({ expense }) => {
  const api = useTRPC();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

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
  });

  // Record-level delete lives on the detail plate, not in a section header —
  // Overview's headerAction is the constructive "Receive into inventory".
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: expense.id,
    name: expense.name,
    entityLabel: "Expense",
    entity: "expense",
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
            if (date === null) return;
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
      label: "Line kind",
      value: (
        <EditableCell
          value={expense.lineKind}
          config={{ type: "select", options: expenseLineKindOptions }}
          onSave={async (lineKind) => {
            if (!lineKind) return;
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { lineKind: lineKind as ExpenseLineKind },
            });
          }}
          renderValue={(lineKind) =>
            lineKind ? (
              <Badge
                variant={
                  expenseLineKindBadgeVariant[lineKind as ExpenseLineKind]
                }
              >
                {expenseLineKindLabels[lineKind as ExpenseLineKind]}
              </Badge>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
      filterAction: (
        <EntityFilterLink
          to="/expenses"
          search={{ lineKind: expense.lineKind }}
          label={`Show all ${expenseLineKindLabels[expense.lineKind].toLowerCase()} expenses`}
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
      filterAction: (
        <EntityFilterLink
          to="/expenses"
          search={{ costType: expense.costType }}
          label={`Show all ${costTypeLabels[expense.costType].toLowerCase()} expenses`}
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
          renderValue={(v) => renderOptionCell(v, tradeOptions)}
        />
      ),
      filterAction: (
        <EntityFilterLink
          to="/expenses"
          search={{ trade: expense.trade }}
          label={`Show all expenses for trade ${expense.trade}`}
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
      filterAction: (
        <EntityFilterLink
          to="/expenses"
          search={{ future: String(expense.future) }}
          label={
            expense.future
              ? "Show all planned expenses"
              : "Show all completed expenses"
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
            v ? <ExternalLinkText href={v} /> : <NoneValue />
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
        // A roster picker, not a text box. Free text here minted a duplicate
        // `Vendor` row on any typo — `findOrCreateVendor` matches names EXACTLY
        // (deliberately), so "amazon" beside an existing "Amazon" becomes a second
        // row with nothing to detect it. Same `EditableEntityCell` +
        // `WithVendorSearch` pairing as the ledger's Vendor column; `id === name`
        // because the server contract stays name-based.
        <EditableEntityCell<string>
          value={
            expense.vendor ? { id: expense.vendor, name: expense.vendor } : null
          }
          label="vendor"
          // A purchase's vendor is optional — clearing detaches the line from its
          // purchase, exactly as emptying the old text input did.
          clearable
          trigger="pencil"
          onSave={async (vendor) => {
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { vendor },
            });
          }}
          SearchProvider={WithVendorSearch}
          renderValue={(v) =>
            v ? (
              <VendorCell
                vendor={v.name}
                vendorId={persistedVendorId(v.name, expense)}
                logo={expense.vendorLogo}
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
      filterAction: expense.vendorId ? (
        <EntityFilterLink
          to="/expenses"
          search={{ vendor: expense.vendorId }}
          label={`Show all expenses from ${expense.vendor ?? "this vendor"}`}
        />
      ) : undefined,
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
          // Mono to match every other Order # surface — it's an opaque
          // identifier, not prose — with the vendor's order page beside it.
          renderValue={(v) =>
            v ? (
              <Row align="center" gap="xs">
                <span className="font-mono">{v}</span>
                <OrderIdLink
                  orderUrl={expense.orderUrl}
                  orderId={v}
                  vendorName={expense.vendor}
                />
              </Row>
            ) : (
              <NoneValue />
            )
          }
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
            // `expense.projectId` is the project's shortcode (per the
            // project shortcode cutover), the same value the combobox
            // carries — so both EntityInlineLink id slots read from it.
            v && expense.projectId ? (
              <EntityInlineLink
                displayImage={undefined}
                entity="project"
                data={{
                  id: expense.projectId,
                  name: v.name,
                }}
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
      filterAction: expense.projectId ? (
        <EntityFilterLink
          to="/expenses"
          search={{ project: expense.projectId }}
          label={`Show all expenses for ${expense.projectName ?? "this project"}`}
        />
      ) : undefined,
    },
    ...(expense.lineKind === "principal"
      ? [
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
                  v && expense.productId && v.id === expense.productId ? (
                    <EntityInlineLink
                      displayImage={undefined}
                      entity="product"
                      data={{
                        id: expense.productId,
                        name: v.name,
                      }}
                    />
                  ) : v ? (
                    <span>{v.name}</span>
                  ) : (
                    <NoneValue />
                  )
                }
              />
            ),
            filterAction: expense.productId ? (
              <EntityFilterLink
                to="/expenses"
                search={{ productId: expense.productId }}
                label={`Show all expenses for ${expense.productName ?? "this product"}`}
              />
            ) : undefined,
          },
          {
            // Sits beside Product, deliberately not beside Line kind: its whole
            // job is answering "why is there no product here?", and next to an
            // empty Product field "Share of a lump sum" reads as the answer.
            label: "Itemization",
            value: (
              <EditableCell
                value={expense.lineBasis}
                config={{ type: "select", options: expenseLineBasisOptions }}
                onSave={async (lineBasis) => {
                  if (!lineBasis) return;
                  await updateMutation.mutateAsync({
                    id: expense.id,
                    data: { lineBasis: lineBasis as ExpenseLineBasis },
                  });
                }}
                renderValue={(lineBasis) =>
                  lineBasis ? (
                    <Badge
                      variant={
                        expenseLineBasisBadgeVariant[
                          lineBasis as ExpenseLineBasis
                        ]
                      }
                    >
                      {expenseLineBasisLabels[lineBasis as ExpenseLineBasis]}
                    </Badge>
                  ) : (
                    <NoneValue />
                  )
                }
              />
            ),
            filterAction: (
              <EntityFilterLink
                to="/expenses"
                search={{ lineBasis: expense.lineBasis }}
                label={`Show all ${expenseLineBasisLabels[expense.lineBasis].toLowerCase()} expenses`}
              />
            ),
          },
          ...(expense.productId
            ? [
                {
                  label: "Product quantity",
                  value: (
                    <EditableCell
                      value={expense.productQuantity}
                      config={{
                        type: "number",
                        step: "any",
                        placeholder: "Unknown",
                      }}
                      onSave={async (productQuantity) => {
                        await updateMutation.mutateAsync({
                          id: expense.id,
                          data: { productQuantity },
                        });
                      }}
                      renderValue={(value) => value ?? <NoneValue />}
                    />
                  ),
                },
              ]
            : []),
        ]
      : []),
  ];

  const sections: DetailSection[] = [
    {
      id: "overview",
      title: "Overview",
      icon: Info,
      placement: "primary",
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
    // Gated on having a PURCHASE, not an order id: the purchase is the parent link,
    // and a third of vendor-bearing lines belong to one without the vendor ever
    // giving us an order id. Lines with no vendor recorded have no transaction to
    // show, which is the only case that leaves the panel off.
    ...(expense.purchaseId
      ? [
          {
            id: "purchase",
            title: "Purchase",
            icon: Receipt,
            placement: "primary" as const,
            content: <ExpensePurchaseSection expense={expense} />,
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
      label: "Line kind",
      value: expense.lineKind ? (
        <Badge variant={expenseLineKindBadgeVariant[expense.lineKind]}>
          {expenseLineKindLabels[expense.lineKind]}
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
      heroActions={{
        primary: (
          <>
            {/* A split files its parts under this line's PURCHASE, so a line with no
              purchase has nothing to file them under — `splitExpense` refuses with
              "record its vendor first". Disabled with that explanation rather
              than surfaced as an error toast: the fix is a field on this page. */}
            <span
              title={
                expense.purchaseId
                  ? undefined
                  : "Record this expense's vendor first — a split files its parts under the same purchase."
              }
            >
              <Button
                variant="outline"
                size="sm"
                disabled={!expense.purchaseId}
                onClick={() => setSplitOpen(true)}
              >
                <Split />
                Split
              </Button>
            </span>
          </>
        ),
        secondary: deleteButton,
      }}
    >
      <DetailSections sections={sections} rawData={expense} />
      {expense.purchaseId ? (
        <SplitExpenseDialog
          open={splitOpen}
          onOpenChange={setSplitOpen}
          expense={expense}
          purchaseShortcode={expense.purchaseId}
        />
      ) : null}
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
