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
import {
  ListWorkbench,
  useBoundedListWorkbench,
} from "~/app/_components/data-table/ListWorkbench";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
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
import { entityListFor } from "~/entities/entity-list.functions";
import { purchaseLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";

import { purchase as purchaseOperations } from "./purchase.functions";

const NO_CANDIDATES: ExpenseOut[] = [];
const CANDIDATE_PAGE_SIZE = 100;
type CandidateScope = "vendorOrUnattached" | "unattached" | "any";
const candidateScopeValues = [
  "vendorOrUnattached",
  "unattached",
  "any",
] as const satisfies readonly CandidateScope[];
const isCandidateScope = (value: string): value is CandidateScope =>
  candidateScopeValues.some((candidate) => candidate === value);
const isUpdater = (
  updater: Updater<RowSelectionState>,
): updater is (previous: RowSelectionState) => RowSelectionState =>
  typeof updater === "function";
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
    ...entityListFor("expense").queryOptions({
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
  const projectRefs = useMemo(
    () =>
      candidates.flatMap((row) =>
        row.projectId
          ? [{ entityType: "project" as const, entityId: row.projectId }]
          : [],
      ),
    [candidates],
  );
  const projectImages = useEntityDisplayImages(projectRefs);
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
    mutationFn: purchaseOperations.link.mutationOptions,
    success: "Expenses attached to this purchase",
    onSuccess: () => resetAndClose(false),
  });

  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries(selected.map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next = isUpdater(updater) ? updater(rowSelection) : updater;
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
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ExpenseOut>((add) => {
        add(buildSelectColumn<ExpenseOut>());
        add(createNameColumn(helper, "expense", "name", { header: "Expense" }));
        add(
          helper.accessor((row) => row.date, {
            id: "date",
            header: "Date",
            meta: { className: "w-28", mono: true, mobile: { slot: "meta" } },
            cell: (info) => info.getValue() ?? <NoneValue />,
          }),
        );
        add(
          createCurrencyColumn(helper, "cost", {
            header: "Cost",
            className: "w-28",
            mobile: { slot: "trailing" },
          }),
        );
        add(
          helper.accessor((row) => row.trade, {
            id: "trade",
            header: "Trade",
            meta: {
              className: "w-36",
              mobile: { slot: "meta", priority: 20 },
            },
            cell: (info) => {
              const trade = info.getValue();
              return trade ? <TradeBadge trade={trade} /> : <NoneValue />;
            },
          }),
        );
        add(
          helper.accessor((row) => row.projectName, {
            id: "project",
            header: "Project",
            meta: {
              className: "w-36",
              mobile: { slot: "meta", priority: 30 },
            },
            cell: (info) => {
              const row = info.row.original;
              return row.projectId && row.projectName ? (
                <EntityInlineLink
                  displayImage={
                    projectImages[
                      entityDisplayImageKey({
                        entityType: "project",
                        entityId: row.projectId,
                      })
                    ] ?? null
                  }
                  entity="project"
                  data={{ id: row.projectId, name: row.projectName }}
                  truncate
                />
              ) : (
                <NoneValue />
              );
            },
          }),
        );
        add(
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
                <span className="font-mono text-2xs tracking-wider text-slate uppercase">
                  unattached
                </span>
              ),
          }),
        );
      }),
    [helper, projectImages],
  );
  const workbench = useBoundedListWorkbench({
    entity: "expense",
    data: candidates,
    columns,
    isLoading: candidatesQuery.isPending,
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
              if (next && isCandidateScope(next)) setScope(next);
            }}
            className="w-56 shrink-0"
          />
        </Row>
        <div className="max-h-72 overflow-y-auto">
          <ListWorkbench
            model={workbench}
            mode="embedded"
            ariaLabel="Expenses available to attach"
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
