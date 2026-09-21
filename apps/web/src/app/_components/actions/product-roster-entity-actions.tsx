import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import { TargetedProductBulkEnrichmentDialog } from "~/app/purchases/targeted-import-launch";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { booleanCellOptions } from "~/lib/select-options";

import { useActionMutation } from "../hooks/useActionMutation";
import { SetFieldDialog } from "../tracker/set-field-dialog";
import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

interface ProductRosterActionRow extends EntityActionRow {
  name: string;
  stockTracked?: boolean | null;
}

const UNDECIDED_STOCK_TRACKING = "undecided";
const STOCK_TRACKED_BULK_OPTIONS = [
  ...booleanCellOptions({ true: "Tracked", false: "Not tracked" }),
  { value: UNDECIDED_STOCK_TRACKING, label: "Undecided" },
];
const parseStockTracked = (value: string): boolean | null =>
  value === UNDECIDED_STOCK_TRACKING ? null : value === "true";
const productBulkUpdate = entityMutationOptionsFactory("product", "bulkUpdate");

function asProductRow(row: EntityActionRow): ProductRosterActionRow {
  return {
    ...row,
    name: row.name || row.id,
    stockTracked: isProductRosterActionRow(row) ? row.stockTracked : undefined,
  };
}

function isProductRosterActionRow(
  row: EntityActionRow,
): row is ProductRosterActionRow {
  return (
    "stockTracked" in row &&
    (row.stockTracked === undefined ||
      row.stockTracked === null ||
      typeof row.stockTracked === "boolean")
  );
}

function usePrintProductLabelsAction(): EntityActionHandles {
  const navigate = useNavigate();
  const run = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      await navigate({
        to: "/labels",
        search: { codes: rows.map((row) => row.id).join(",") },
      });
      return { success: true };
    },
    [navigate],
  );
  return {
    run,
    rowMenuItem: (row) => (
      <VerbMenuItem verb="printLabels" onSelect={() => void run([row])} />
    ),
    dialog: null,
  };
}

function useSetProductStockTrackingAction(): EntityActionHandles {
  const [rows, setRows] = useState<ProductRosterActionRow[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const finish = useCallback((success: boolean) => {
    setRows([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);
  const mutation = useActionMutation({
    mutationFn: productBulkUpdate,
    success: (data) =>
      `Updated ${data.updated} product${data.updated !== 1 ? "s" : ""}`,
  });
  const stage = useCallback((next: readonly EntityActionRow[]) => {
    setRows(next.map(asProductRow));
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  return {
    run: stage,
    rowMenuItem: () => null,
    availability: () =>
      mutation.isPending
        ? {
            status: "disabled",
            reason: "Stock tracking is already being updated.",
          }
        : { status: "available" },
    dialog: (
      <SetFieldDialog
        open={rows.length > 0}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        items={rows}
        isPending={mutation.isPending}
        currentValue={(product) =>
          product.stockTracked == null
            ? UNDECIDED_STOCK_TRACKING
            : String(product.stockTracked)
        }
        options={STOCK_TRACKED_BULK_OPTIONS}
        fieldLabel="Stock tracking"
        itemNoun="Product"
        onConfirm={async (value) => {
          await mutation.mutateAsync({
            ids: rows.map((product) => product.id),
            data: { stockTracked: parseStockTracked(value) },
          });
          finish(true);
        }}
      />
    ),
  };
}

function useEnrichProductsAction(): EntityActionHandles {
  const [rows, setRows] = useState<ProductRosterActionRow[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const finish = useCallback((success: boolean) => {
    setRows([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);
  return {
    run: (next) => {
      setRows(next.map(asProductRow));
      return new Promise((resolve) => {
        resolveRef.current = resolve;
      });
    },
    rowMenuItem: () => null,
    dialog: (
      <TargetedProductBulkEnrichmentDialog
        open={rows.length > 0}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        products={rows.map((row) => ({ id: row.id, name: row.name }))}
        onFinished={finish}
      />
    ),
  };
}

export const productRosterEntityActionDefinitions = [
  defineEntityAction({
    verb: "enrichProducts",
    entities: ["product"],
    arity: "both",
    surfaces: ["selection"],
    group: "organize",
    priority: 150,
    preserveSelection: true,
    use: useEnrichProductsAction,
  }),
  defineEntityAction({
    id: "print-labels",
    verb: "printLabels",
    entities: ["product"],
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "organize",
    priority: 200,
    placement: { inspector: "overflow", detail: "overflow" },
    preserveSelection: true,
    use: usePrintProductLabelsAction,
  }),
  defineEntityAction({
    verb: "setStockTracking",
    entities: ["product"],
    arity: "both",
    surfaces: ["selection"],
    group: "organize",
    priority: 300,
    preserveSelection: true,
    use: useSetProductStockTrackingAction,
  }),
] as const;
