import type { ExpenseShortcode } from "@cubby/schemas/identifiers";
import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { sumBy } from "es-toolkit";
import { useMemo, useState } from "react";
import { match } from "ts-pattern";
import {
  createCurrencyColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { TradeBadge } from "~/app/projects/trade-options";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  FilterableCombobox,
  type FilterableComboboxItem,
} from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { NoneValue } from "~/components/ui/none-value";
import { entityListQueryOptions } from "~/entities/entity-list.functions";
import { purchaseLabel } from "~/lib/purchase-label";
import { invalidatesFor } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { linkPurchaseMutationOptions } from "./purchase.functions";

const NO_CANDIDATES: ExpenseOut[] = [];
const CANDIDATE_PAGE_SIZE = 100;
type CandidateScope = "vendorOrUnattached" | "unattached" | "any";
const SCOPE_OPTIONS: FilterableComboboxItem[] = [
  { value: "vendorOrUnattached", label: "This vendor or unattached" },
  { value: "unattached", label: "Unattached expenses only" },
  { value: "any", label: "Any expense" },
];

export function LinkExpensesDialog({
  open,
  onOpenChange,
  purchase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PurchaseOut;
}) {
  const [selectedRows, setSelectedRows] = useState<
    Map<ExpenseShortcode, ExpenseOut>
  >(new Map());
  const [scope, setScope] = useState<CandidateScope>("vendorOrUnattached");
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput, { wait: 300 });

  const filters = useMemo<ExpenseFilters>(() => {
    const term = search.trim() || undefined;
    return match(scope)
      .with("vendorOrUnattached", () => ({
        vendorId: purchase.vendorId,
        vendorPresenceFilter: "none" as const,
        search: term,
      }))
      .with("unattached", () => ({
        vendorPresenceFilter: "none" as const,
        search: term,
      }))
      .with("any", () => ({ search: term }))
      .exhaustive();
  }, [scope, purchase.vendorId, search]);
  const candidatesQuery = useQuery({
    ...entityListQueryOptions("expense", {
      filters,
      pagination: { pageIndex: 0, pageSize: CANDIDATE_PAGE_SIZE },
    }),
    enabled: open,
  });
  const candidates = useMemo(
    () =>
      candidatesQuery.data?.items.filter(
        (row) => row.purchaseId !== purchase.id,
      ) ?? NO_CANDIDATES,
    [candidatesQuery.data, purchase.id],
  );
  const selected = useMemo(() => [...selectedRows.keys()], [selectedRows]);
  const selectedTotal = useMemo(
    () => sumBy([...selectedRows.values()], (row) => row.cost ?? 0),
    [selectedRows],
  );

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelectedRows(new Map());
      setSearchInput("");
      setScope("vendorOrUnattached");
    }
    onOpenChange(next);
  };
  const linkMutation = useActionMutation({
    mutationFn: linkPurchaseMutationOptions,
    success: "Expenses attached to this purchase",
    invalidateKeys: invalidatesFor("purchase"),
    onSuccess: () => resetAndClose(false),
  });

  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries(selected.map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next =
      typeof updater === "function" ? updater(rowSelection) : updater;
    setSelectedRows((previous) => {
      const rows = new Map(previous);
      for (const id of rows.keys()) {
        if (!next[id]) rows.delete(id);
      }
      for (const candidate of candidates) {
        if (next[candidate.id]) rows.set(candidate.id, candidate);
      }
      return rows;
    });
  };

  const helper = useMemo(() => createCubbyColumnHelper<ExpenseOut>(), []);
  const columns = useMemo<CubbyColumnDef<ExpenseOut>[]>(
    () => [
      buildSelectColumn<ExpenseOut>(),
      createNameColumn(helper, "expense", "name", { header: "Expense" }),
      helper.accessor((row) => row.date, {
        id: "date",
        header: "Date",
        meta: { className: "w-28", mono: true, mobile: { slot: "meta" } },
        cell: (info) => info.getValue() ?? <NoneValue />,
      }),
      createCurrencyColumn(helper, "cost", {
        header: "Cost",
        className: "w-28",
        mobile: { slot: "trailing" },
      }),
      helper.accessor((row) => row.trade, {
        id: "trade",
        header: "Trade",
        meta: { className: "w-36", mobile: { slot: "meta", priority: 20 } },
        cell: (info) => <TradeBadge trade={info.getValue()} />,
      }),
      helper.accessor((row) => row.projectName, {
        id: "project",
        header: "Project",
        meta: { className: "w-36", mobile: { slot: "meta", priority: 30 } },
        cell: (info) => {
          const row = info.row.original;
          return row.projectId && row.projectName ? (
            <EntityInlineLink
              displayImage={undefined}
              entity="project"
              data={{ id: row.projectId, name: row.projectName }}
              truncate
            />
          ) : (
            <NoneValue />
          );
        },
      }),
      helper.accessor((row) => row.purchaseId, {
        id: "currentPurchase",
        header: "Current purchase",
        meta: {
          className: "w-36",
          mobile: { slot: "meta", priority: 40, label: "Purchase" },
        },
        cell: (info) =>
          info.getValue() ? (
            <span className="text-muted-foreground">
              {info.row.original.vendor ?? "another purchase"}
            </span>
          ) : (
            <span className="font-mono text-2xs text-slate uppercase tracking-wider">
              unattached
            </span>
          ),
      }),
    ],
    [helper],
  );
  const layout = useCubbyTableLayout({
    key: "purchase:expense-picker",
    columns,
  });
  const table = useCubbyTable({
    data: candidates,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange,
    initialState: {
      pagination: { pageIndex: 0, pageSize: CANDIDATE_PAGE_SIZE },
    },
  });

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            Attach expenses to {purchaseLabel(purchase)}
          </DialogTitle>
          <DialogDescription>
            One purchase can span trades. Attaching moves each expense onto this
            purchase and off its current purchase.
          </DialogDescription>
        </DialogHeader>
        <Row align="center" gap="sm">
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search expense names…"
            className="flex-1"
          />
          <FilterableCombobox
            items={SCOPE_OPTIONS}
            value={scope}
            onValueChange={(next) => {
              if (next) setScope(next as CandidateScope);
            }}
            className="w-56 shrink-0"
          />
        </Row>
        <div className="max-h-72 overflow-y-auto">
          <RTable
            table={table}
            entity="expense"
            ariaLabel="Expenses available to attach"
            embedded
            isLoading={candidatesQuery.isPending}
            emptyState={
              <Empty variant="minimal" className="py-6">
                <EmptyTitle>No expenses to attach</EmptyTitle>
                <EmptyDescription>
                  Nothing matches this scope. Widen it to any expense, or clear
                  the search.
                </EmptyDescription>
              </Empty>
            }
          />
        </div>
        <Description size="xs">
          A payment schedule is not one Purchase — separate transactions stay
          separate Purchases. Attaching an already-filed expense moves it off
          its current purchase.
        </Description>
        <DialogFooter>
          <Stack gap="tight" className="mr-auto text-left">
            <span className="font-mono text-xs tabular-nums">
              {selected.length} selected · {formatCurrency(selectedTotal)}
            </span>
            {selected.length > 0 && (
              <Description size="2xs">
                Purchase expense total would go to{" "}
                {formatCurrency(purchase.expenseTotal + selectedTotal)}
              </Description>
            )}
          </Stack>
          <Button variant="outline" onClick={() => resetAndClose(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.length === 0 || linkMutation.isPending}
            onClick={() =>
              linkMutation.mutate({
                purchaseId: purchase.id,
                expenseIds: selected,
              })
            }
          >
            {linkMutation.isPending
              ? "Attaching..."
              : `Attach ${selected.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
