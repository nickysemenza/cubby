import type { ExpenseShortcode } from "@cubby/schemas/identifiers";
import {
  type LinkExpenseScope,
  type PurchaseOut,
  type purchaseLinkExpenseCandidate,
} from "@cubby/schemas/purchase";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import type { z } from "zod";

import { TradeBadge } from "~/app/projects/trade-options";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { purchaseLabel } from "~/lib/purchase-label";
import {
  createCurrencyColumn,
  createNameColumn,
} from "~/ui/data-table/columnHelpers";
import {
  ListWorkbench,
  useBoundedListWorkbench,
} from "~/ui/data-table/ListWorkbench";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { WorkflowDialog } from "~/ui/dialogs/workflow-dialog";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { FilterableCombobox } from "~/ui/primitives/combobox";
import { Description } from "~/ui/primitives/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/ui/primitives/empty";
import { Input } from "~/ui/primitives/input";
import { NoneValue } from "~/ui/primitives/none-value";
import { StatusText } from "~/ui/primitives/status-text";

/** The table shows every candidate the server returns (it caps the list at 100). */
const CANDIDATE_PAGE_SIZE = 100;
type Candidate = z.output<typeof purchaseLinkExpenseCandidate>;
const NO_CANDIDATES: Candidate[] = [];
const NO_SCOPES: { value: LinkExpenseScope; label: string }[] = [];
const isUpdater = (
  updater: Updater<RowSelectionState>,
): updater is (previous: RowSelectionState) => RowSelectionState =>
  typeof updater === "function";

/** What the selection amounts to, in the server's words, and why it cannot be attached. */
function AttachSummary({
  count,
  note,
  confirmation,
  problem,
}: {
  count: number;
  note: string | null | undefined;
  confirmation: string | null;
  problem: string | null | undefined;
}) {
  return (
    <Stack gap="tight" className="mr-auto text-left">
      <span className="font-mono text-xs tabular-nums">
        {count === 0 ? "0 selected" : (note ?? `${count} selected`)}
      </span>
      {confirmation ? (
        <StatusText tone="warning" className="text-xs">
          {confirmation}
        </StatusText>
      ) : null}
      {problem ? <Description size="2xs">{problem}</Description> : null}
    </Stack>
  );
}

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
    Map<ExpenseShortcode, Candidate>
  >(new Map());
  const [scope, setScope] = useState<LinkExpenseScope>("vendorOrUnattached");
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput, { wait: 300 });

  // Which expenses are candidates, how each is worded and where it is filed now are the
  // server's (`purchase.linkExpenseCandidates`); this dialog only holds the choice.
  const candidatesQuery = useQuery({
    ...purchaseOperations.linkExpenseCandidates.queryOptions({
      purchaseId: purchase.id,
      scope,
      search,
    }),
    enabled: open,
    // Candidates are what attaching just changed: never trust a cached list across a reopen.
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  const candidates = candidatesQuery.data?.candidates ?? NO_CANDIDATES;
  const projectRefs = useMemo(
    () =>
      candidates.flatMap((row) =>
        row.projectId
          ? [{ entityKind: "project" as const, entityId: row.projectId }]
          : [],
      ),
    [candidates],
  );
  const projectImages = useEntityDisplayImages(projectRefs);
  const selected = useMemo(() => [...selectedRows.keys()], [selectedRows]);
  // What the selection does to the purchase, and whether it can be attached, is the server's.
  const check = useQuery({
    ...purchaseOperations.checkLinkExpenses.queryOptions({
      purchaseId: purchase.id,
      expenseIds: selected,
    }),
    enabled: open && selected.length > 0,
    placeholderData: keepPreviousData,
  });

  const queryClient = useQueryClient();
  // The sentence a person has been shown for the selection they are about to attach; it only
  // counts for that exact selection.
  const [shown, setShown] = useState<{ key: string; text: string } | null>(
    null,
  );
  const [attachError, setAttachError] = useState<string | null>(null);
  const selectionKey = selected.join(",");
  const confirmation = shown?.key === selectionKey ? shown.text : null;

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setShown(null);
      setAttachError(null);
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

  // The live check may describe an earlier selection (it keeps the previous answer while the
  // next loads), so attaching asks again for exactly the selection as it is now, and sends only
  // what that answer returns. Expenses that would move off another purchase wait for a second,
  // explicit tap.
  const attach = async () => {
    const latest = await queryClient.fetchQuery({
      ...purchaseOperations.checkLinkExpenses.queryOptions({
        purchaseId: purchase.id,
        expenseIds: selected,
      }),
      staleTime: 0,
    });
    if (!latest.expenseIds) {
      setAttachError(latest.reason ?? "These expenses cannot be attached.");
      return;
    }
    setAttachError(null);
    if (latest.confirm && confirmation !== latest.confirm) {
      setShown({ key: selectionKey, text: latest.confirm });
      return;
    }
    linkMutation.mutate({
      purchaseId: purchase.id,
      expenseIds: latest.expenseIds,
    });
  };

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

  const helper = useMemo(() => createCubbyColumnHelper<Candidate>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<Candidate>((add) => {
        add(buildSelectColumn<Candidate>());
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
                <EntityRefLink
                  displayImage={
                    projectImages[
                      entityDisplayImageKey({
                        entityKind: "project",
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
          helper.accessor((row) => row.current, {
            id: "currentPurchase",
            header: "Current purchase",
            meta: {
              className: "w-36",
              mobile: { slot: "meta", priority: 40, label: "Purchase" },
            },
            cell: (info) =>
              info.row.original.filed ? (
                <span className="text-muted-foreground">{info.getValue()}</span>
              ) : (
                <span className="font-mono text-2xs tracking-wider text-slate uppercase">
                  {info.getValue()}
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
    <WorkflowDialog
      open={open}
      onOpenChange={resetAndClose}
      size="xl"
      title={`Attach expenses to ${purchaseLabel(purchase)}`}
      description="One purchase can span trades. Attaching moves each expense onto this purchase and off its current purchase."
      summary={
        <AttachSummary
          count={selected.length}
          note={check.data?.note}
          confirmation={confirmation}
          problem={attachError ?? check.data?.reason}
        />
      }
      onCancel={() => resetAndClose(false)}
      primary={{
        label: confirmation
          ? `Confirm: attach ${selected.length}`
          : `Attach ${selected.length}`,
        pendingLabel: "Attaching...",
        pending: linkMutation.isPending,
        disabled:
          selected.length === 0 ||
          check.isPlaceholderData ||
          !check.data?.expenseIds,
        onClick: attach,
      }}
    >
      <Row align="center" gap="sm">
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search expense names…"
          className="flex-1"
        />
        <FilterableCombobox
          items={candidatesQuery.data?.scopes ?? NO_SCOPES}
          value={scope}
          onValueChange={(next) => {
            const chosen = candidatesQuery.data?.scopes.find(
              (option) => option.value === next,
            );
            if (chosen) setScope(chosen.value);
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
                {candidatesQuery.data?.message ?? "Nothing to attach."}
              </EmptyDescription>
            </Empty>
          }
        />
      </div>
      <Description size="xs">{candidatesQuery.data?.caution}</Description>
    </WorkflowDialog>
  );
}
