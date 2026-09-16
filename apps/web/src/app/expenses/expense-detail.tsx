import type { ExpenseOut, ExpenseUpdateInput } from "@cubby/schemas/project";
import { Info, PackagePlus, Receipt, Split } from "lucide-react";
import { type FC, useState } from "react";

import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { WithVendorSearch } from "~/app/_components/combobox/with-vendor-search";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ExternalLinkText } from "~/app/_components/ExternalLink";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { tradeOptions } from "~/app/projects/shared";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Row } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { EntityBasicInfo } from "~/entities/entity-display";
import { formatCurrency } from "~/lib/utils";
import { persistedVendorId } from "~/lib/vendor-logo";

import {
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { EditableEntityCell } from "../_components/data-table/editable-entity-cell";
import { entityCellClipboard } from "../_components/data-table/inventory-column-helpers";
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
  record: ExpenseOut;
}

const expenseHeroStats = (expense: ExpenseOut): DetailHeroStat[] => [
  {
    label: "Cost",
    value: expense.cost != null ? formatCurrency(expense.cost, 0) : "—",
  },
  { label: "Date", value: expense.date ?? "—" },
  {
    label: "Line kind",
    value: (
      <Badge variant={expenseLineKindBadgeVariant[expense.lineKind]}>
        {expenseLineKindLabels[expense.lineKind]}
      </Badge>
    ),
  },
];

function ExpenseHeroActions({
  purchaseId,
  onSplit,
}: {
  purchaseId: ExpenseOut["purchaseId"];
  onSplit: () => void;
}) {
  return (
    <span
      title={
        purchaseId
          ? undefined
          : "Record this expense's vendor first — a split files its parts under the same purchase."
      }
    >
      <Button
        variant="outline"
        size="sm"
        disabled={!purchaseId}
        onClick={onSplit}
      >
        <Split />
        Split
      </Button>
    </span>
  );
}

function ExpenseDetailDialogs({
  expense,
  splitOpen,
  receiveOpen,
  onSplitOpenChange,
  onReceiveOpenChange,
}: {
  expense: ExpenseOut;
  splitOpen: boolean;
  receiveOpen: boolean;
  onSplitOpenChange: (open: boolean) => void;
  onReceiveOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      {expense.purchaseId && (
        <SplitExpenseDialog
          open={splitOpen}
          onOpenChange={onSplitOpenChange}
          expense={expense}
          purchaseShortcode={expense.purchaseId}
        />
      )}
      {expense.productId && (
        <ReceiveExpenseDialog
          open={receiveOpen}
          onOpenChange={onReceiveOpenChange}
          productId={expense.productId}
          expenseName={expense.name}
        />
      )}
    </>
  );
}

function expenseProductRenderers(
  expense: ExpenseOut,
  updateExpense: (input: ExpenseUpdateInput) => Promise<void>,
) {
  const linkedProduct =
    expense.productId && expense.productName
      ? { id: expense.productId, name: expense.productName }
      : null;
  return {
    productId: () => ({
      value:
        expense.lineKind === "principal" ? (
          <EditableEntityCell
            value={linkedProduct}
            label="product"
            clearable
            trigger="pencil"
            onSave={async (productId) => {
              await updateExpense({
                id: expense.id,
                data: { productId },
              });
            }}
            clipboard={entityCellClipboard(
              "product",
              linkedProduct,
              async (productId) => {
                await updateExpense({
                  id: expense.id,
                  data: { productId },
                });
              },
            )}
            SearchProvider={(props) => (
              <WithEntitySearch entity="product" {...props} />
            )}
            renderValue={(value) =>
              value && expense.productId && value.id === expense.productId ? (
                <EntityInlineLink
                  displayImage={undefined}
                  entity="product"
                  data={{ id: expense.productId, name: value.name }}
                />
              ) : value ? (
                <span>{value.name}</span>
              ) : (
                <NoneValue />
              )
            }
          />
        ) : undefined,
      filterAction:
        expense.lineKind === "principal" && expense.productId ? (
          <EntityFilterLink
            to="/expenses"
            search={{ productId: expense.productId }}
            label={`Show all expenses for ${expense.productName ?? "this product"}`}
          />
        ) : undefined,
    }),
    lineBasis: () => ({
      value:
        expense.lineKind === "principal" ? (
          <EditableCell
            value={expense.lineBasis}
            config={{ type: "select", options: expenseLineBasisOptions }}
            onSave={async (lineBasis) => {
              if (!lineBasis) return;
              await updateExpense({ id: expense.id, data: { lineBasis } });
            }}
            renderValue={(lineBasis) =>
              lineBasis ? (
                <Badge variant={expenseLineBasisBadgeVariant[lineBasis]}>
                  {expenseLineBasisLabels[lineBasis]}
                </Badge>
              ) : (
                <NoneValue />
              )
            }
          />
        ) : undefined,
      filterAction:
        expense.lineKind === "principal" ? (
          <EntityFilterLink
            to="/expenses"
            search={{ lineBasis: expense.lineBasis }}
            label={`Show all ${expenseLineBasisLabels[expense.lineBasis].toLowerCase()} expenses`}
          />
        ) : undefined,
    }),
    productQuantity: () => ({
      value:
        expense.lineKind === "principal" && expense.productId ? (
          <EditableCell
            value={expense.productQuantity}
            config={{ type: "number", step: "any", placeholder: "Unknown" }}
            onSave={async (productQuantity) => {
              await updateExpense({
                id: expense.id,
                data: { productQuantity },
              });
            }}
            renderValue={(value) => value ?? <NoneValue />}
          />
        ) : undefined,
    }),
  };
}

export const ExpenseDetail: FC<ExpenseDetailProps> = ({ record: expense }) => {
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });

  // Common sections from entity config (History) — editMode/mappings unused
  // here since Overview is edited via inline EditableCell fields, not a Form.
  const { commonSections } = useEntityDetail<"expense", ExpenseOut, never>({
    entity: "expense",
    data: expense,
  });

  const overrides = {
    name: () => ({
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
    }),
    cost: () => ({
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
    }),
    date: () => ({
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
    }),
    lineKind: () => ({
      value: (
        <EditableCell
          value={expense.lineKind}
          config={{ type: "select", options: expenseLineKindOptions }}
          onSave={async (lineKind) => {
            if (!lineKind) return;
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { lineKind },
            });
          }}
          renderValue={(lineKind) =>
            lineKind ? (
              <Badge variant={expenseLineKindBadgeVariant[lineKind]}>
                {expenseLineKindLabels[lineKind]}
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
    }),
    costType: () => ({
      value: (
        <EditableCell
          value={expense.costType}
          config={{ type: "select", options: costTypeOptions }}
          onSave={async (costType) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!costType) return;
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { costType },
            });
          }}
          renderValue={(ct) =>
            ct ? (
              <Badge variant={costTypeBadgeVariant[ct]}>
                {costTypeLabels[ct]}
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
    }),
    trade: () => ({
      value: (
        <EditableCell
          value={expense.trade}
          config={{ type: "select", options: tradeOptions }}
          onSave={async (trade) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!trade) return;
            await updateMutation.mutateAsync({
              id: expense.id,
              data: { trade },
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
    }),
    future: () => ({
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
    }),
    url: () => ({
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
    }),
    notes: () => ({
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
    }),
    vendor: () => ({
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
    }),
    orderId: () => ({
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
    }),
    projectId: () => ({
      value: (
        <div className="min-w-0 space-y-2">
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
            SearchProvider={(props) => (
              <WithEntitySearch entity="project" {...props} />
            )}
            renderValue={(v) =>
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
        </div>
      ),
      filterAction: expense.projectId ? (
        <EntityFilterLink
          to="/expenses"
          search={{ project: expense.projectId }}
          label={`Show all expenses for ${expense.projectName ?? "this project"}`}
        />
      ) : undefined,
    }),
    ...expenseProductRenderers(expense, async (input) => {
      await updateMutation.mutateAsync(input);
    }),
  };

  const sections: DetailSection[] = [
    {
      id: "overview",
      title: "Overview",
      icon: Info,
      placement: "primary",
      content: (
        <EntityBasicInfo
          entity="expense"
          record={expense}
          overrides={overrides}
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

  const heroStats = expenseHeroStats(expense);

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
          <ExpenseHeroActions
            purchaseId={expense.purchaseId}
            onSplit={() => setSplitOpen(true)}
          />
        ),
      }}
    >
      <DetailSections sections={sections} rawData={expense} />
      <ExpenseDetailDialogs
        expense={expense}
        splitOpen={splitOpen}
        receiveOpen={receiveOpen}
        onSplitOpenChange={setSplitOpen}
        onReceiveOpenChange={setReceiveOpen}
      />
    </Page>
  );
};
