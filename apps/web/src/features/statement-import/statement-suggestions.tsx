import { financialAccountShortcode } from "@cubby/schemas/identifiers";
import type {
  StatementSuggestionFilters,
  StatementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import type { SuggestionGroup } from "@cubby/schemas/suggestion-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { runHref } from "~/entity/routing/purchase-import-links";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { createCurrencyColumn } from "~/entity/table/column-helpers";
import RTable from "~/entity/table/table";
import { rippleFor } from "~/integrations/tanstack-query/cache-tags";
import {
  assessment,
  run,
  statementRow,
  suggestions,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCount } from "~/lib/number-format";
import { Ledger } from "~/ui/common/ledger";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Section, Stack } from "~/ui/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Button } from "~/ui/primitives/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/ui/primitives/empty";
import { Progress } from "~/ui/primitives/progress";

import {
  applyItem,
  dismissItem,
  type ReviewItem,
  type StatementChoice,
} from "./statement-suggestions-review";
import {
  StatementSuggestionRow,
  type RowOutcome,
} from "./statement-suggestions-row";

const route = getRouteApi("/_authenticated/statement-rows/");

type Group = SuggestionGroup;

const PAGE_SIZE = 50;
/** What a statement suggestion review touches; mirrors `assessment.reviewBatch`'s ripple. */
const REVIEW_RIPPLE = rippleFor([
  "statementRow",
  "financialTransaction",
  "settledSuggestions",
  "suggestions",
]);
const REVIEW_BATCH_MAX = 100;
const NO_GROUPS: Group[] = [];
const NO_SUGGESTIONS: StatementSuggestionOut[] = [];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** `2026-05` → `May 2026`, read in UTC so the month never shifts. */
const monthLabel = (month: string) => {
  const [year, index] = month.split("-").map(Number);
  if (!year || !index) return month;
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};

type RefreshState =
  | { state: "idle" }
  | { state: "running"; published: number; unchanged: number }
  | { state: "done"; published: number; unchanged: number; queued: boolean }
  | { state: "failed"; error: string };

type GroupAcceptState = {
  label: string;
  total: number;
  done: number;
  running: boolean;
  failures: { label: string; error: string }[];
};

const groupKey = (group: { accountId: string; month: string }) =>
  `${group.accountId}:${group.month}`;

const columnHelper = createCubbyColumnHelper<Group>();

export function StatementSuggestions() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const groupsQuery = useQuery({
    ...suggestions.list.queryOptions({
      family: "statement_transaction",
      limit: 1,
      groups: "account_month",
    }),
    select: (page) => page.meta.groups ?? NO_GROUPS,
  });
  const groups = groupsQuery.data ?? NO_GROUPS;

  const [refresh, setRefresh] = useState<RefreshState>({ state: "idle" });
  const [groupAccept, setGroupAccept] = useState<GroupAcceptState | null>(null);

  // TODO(#2722 U6): this tab moves onto the Suggestions page.
  const runRefresh = async () => {
    setRefresh({ state: "running", published: 0, unchanged: 0 });
    try {
      const { runId } = await run.sweep.call({
        families: [{ family: "statement_transaction" }],
      });
      window.location.assign(runHref(runId));
    } catch (error) {
      setRefresh({ state: "failed", error: errorText(error) });
    }
  };

  const review = async (items: ReviewItem[]) => {
    const results = await assessment.reviewBatch.call({ items });
    await invalidateOperationTags(
      queryClient,
      assessment.reviewBatch.invalidates({ items }),
    );
    return results;
  };

  const acceptGroup = async (group: Group) => {
    const label = `${group.accountId} · ${monthLabel(group.month)}`;
    setGroupAccept({
      label,
      total: group.clean,
      done: 0,
      running: true,
      failures: [],
    });
    const failures: GroupAcceptState["failures"] = [];
    try {
      // The server re-lists the clean set before every chunk: labels
      // republish a charge's suggestion under a new id while this runs, and
      // accepting shrinks the set, so a single up-front read goes stale.
      // Attempted ids are never retried; failures stay pending for review.
      const attempted = new Set<string>();
      let done = 0;
      let total = group.clean;
      for (;;) {
        const results = await suggestions.acceptClean.call({
          filters: {
            family: "statement_transaction",
            where: {
              account: { in: [group.accountId] },
              month: { in: [group.month] },
            },
          },
          limit: REVIEW_BATCH_MAX,
          skip: [...attempted],
        });
        if (!results.length) break;
        for (const result of results) {
          if (result.assessmentId) attempted.add(result.assessmentId);
          if (result.ok) continue;
          failures.push({
            label: result.assessmentId ?? "Unknown suggestion",
            error: result.error,
          });
        }
        done += results.length;
        total = Math.max(total, done);
        setGroupAccept({
          label,
          total,
          done,
          running: true,
          failures: [...failures],
        });
      }
      setGroupAccept({
        label,
        total: done,
        done,
        running: false,
        failures,
      });
    } catch (error) {
      failures.push({ label, error: errorText(error) });
      setGroupAccept((previous) => ({
        label,
        total: previous?.total ?? group.clean,
        done: previous?.done ?? 0,
        running: false,
        failures,
      }));
    }
    await invalidateOperationTags(queryClient, REVIEW_RIPPLE);
  };

  const [confirming, setConfirming] = useState<Group | null>(null);
  const busy = refresh.state === "running" || groupAccept?.running === true;

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<Group>((add) => {
        add(
          columnHelper.accessor("accountId", {
            id: "accountId",
            header: "Account",
            enableSorting: false,
            meta: { className: "w-48" },
            cell: (info) => (
              <EntityRefLink
                variant="byId"
                entityKind="financialAccount"
                entityId={info.getValue()}
                compact
              />
            ),
          }),
        );
        add(
          columnHelper.accessor("month", {
            id: "month",
            header: "Month",
            enableSorting: false,
            meta: { className: "w-24" },
            cell: (info) => monthLabel(info.getValue()),
          }),
        );
        for (const [key, header] of [
          ["count", "Pending"],
          ["clean", "Clean"],
          ["create", "Create"],
          ["attach", "Attach"],
          ["supersede", "Settle hold"],
          ["void", "Void hold"],
        ] as const)
          add(
            columnHelper.accessor(key, {
              id: key,
              header,
              enableSorting: false,
              meta: { className: "w-20", numeric: true },
              cell: (info) => (
                <span
                  className={
                    info.getValue() === 0
                      ? "text-muted-foreground tabular-nums"
                      : "tabular-nums"
                  }
                >
                  {formatCount(info.getValue())}
                </span>
              ),
            }),
          );
        add(
          createCurrencyColumn(columnHelper, "amount", {
            header: "Amount",
            className: "w-28",
          }),
        );
        add(
          columnHelper.display({
            id: "acceptClean",
            header: "",
            meta: { className: "w-36" },
            cell: (info) => {
              const group = info.row.original;
              return (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="max-md:min-h-11"
                  disabled={group.clean === 0 || busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirming(group);
                  }}
                >
                  Accept {formatCount(group.clean)} clean
                </Button>
              );
            },
          }),
        );
      }),
    [busy],
  );
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: groups,
    columns: tableColumns,
    meta: { defaultLayout },
    getRowId: groupKey,
    enableSorting: false,
    enableFilters: false,
    enableRowSelection: false,
    enableCellSelection: false,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
  });

  const selectGroup = (patch: { account?: string; month?: string }) =>
    void navigate({
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    });

  const refreshButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => void runRefresh()}
    >
      Refresh suggestions
    </Button>
  );
  const totalPending = groups.reduce((sum, group) => sum + group.count, 0);
  const totalClean = groups.reduce((sum, group) => sum + group.clean, 0);
  const currentGroup =
    search.account && search.month
      ? groupKey({ accountId: search.account, month: search.month })
      : undefined;

  return (
    <Stack gap="md">
      <Row align="center" justify="between" wrap gap="sm">
        <p
          className="text-xs text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          {groupsQuery.data
            ? `${formatCount(totalPending)} pending · ${formatCount(totalClean)} clean · ${formatCount(groups.length)} account months`
            : "Loading…"}
          {refresh.state === "running"
            ? ` · Refreshing: ${formatCount(refresh.published)} published, ${formatCount(refresh.unchanged)} unchanged`
            : ""}
          {refresh.state === "done"
            ? ` · Refreshed: ${formatCount(refresh.published)} published, ${formatCount(refresh.unchanged)} unchanged${refresh.queued ? "; the remaining pages continue in the background" : ""}`
            : ""}
        </p>
        {refreshButton}
      </Row>
      {refresh.state === "failed" ? (
        <p
          role="alert"
          className="text-xs whitespace-pre-wrap text-destructive"
        >
          {refresh.error}
        </p>
      ) : null}
      {groupAccept ? <GroupAcceptProgress state={groupAccept} /> : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Accept {formatCount(confirming?.clean ?? 0)} clean suggestions?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? `${confirming.accountId} · ${monthLabel(confirming.month)}. Each creates or settles a transaction from its statement row; there is no undo.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const group = confirming;
                setConfirming(null);
                if (group) void acceptGroup(group);
              }}
            >
              Accept {formatCount(confirming?.clean ?? 0)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {groupsQuery.error ? (
        <ErrorDisplay error={groupsQuery.error} />
      ) : groupsQuery.data && groups.length === 0 ? (
        <Empty variant="minimal" className="py-8">
          <EmptyTitle>No pending suggestions</EmptyTitle>
          <EmptyDescription>
            Refresh to compare unmatched statement rows with recorded
            transactions.
          </EmptyDescription>
          <EmptyActions>{refreshButton}</EmptyActions>
        </Empty>
      ) : (
        <>
          <RTable
            table={table}
            ariaLabel="Suggestion groups"
            isLoading={groupsQuery.isLoading}
            embedded
            onRowClick={(row) =>
              selectGroup({
                account: row.original.accountId,
                month: row.original.month,
              })
            }
            currentRowId={currentGroup}
            emptyState="No pending suggestions."
          />
          <SuggestionList
            filters={{
              // A malformed `account` param reads as no account scope.
              accountId: financialAccountShortcode.safeParse(search.account)
                .data,
              month: search.month,
            }}
            groups={groups}
            onClear={() =>
              selectGroup({ account: undefined, month: undefined })
            }
            review={review}
          />
        </>
      )}
    </Stack>
  );
}

function GroupAcceptProgress({ state }: { state: GroupAcceptState }) {
  return (
    <div className="space-y-1" aria-live="polite">
      <p className="text-xs text-muted-foreground tabular-nums">
        {state.label}: Accepted{" "}
        {formatCount(state.done - state.failures.length)} of{" "}
        {formatCount(state.total)}
        {state.failures.length
          ? ` · ${formatCount(state.failures.length)} failed`
          : ""}
        {state.running ? "…" : ""}
      </p>
      <Progress value={state.done} max={Math.max(state.total, 1)} />
      {state.failures.length ? (
        <ul className="space-y-0.5 text-xs" aria-label="Failed suggestions">
          {state.failures.map((failure, index) => (
            <li
              // Failures have no stable id beyond their order of arrival.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="text-destructive"
            >
              <span className="font-medium">{failure.label}</span>:{" "}
              <span className="whitespace-pre-wrap">{failure.error}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SuggestionList({
  filters,
  groups,
  onClear,
  review,
}: {
  filters: StatementSuggestionFilters;
  groups: Group[];
  onClear: () => void;
  review: (
    items: ReviewItem[],
  ) => Promise<Awaited<ReturnType<typeof assessment.reviewBatch.call>>>;
}) {
  const filterKey = JSON.stringify(filters);
  const [page, setPage] = useState<{ key: string; cursors: string[] }>({
    key: filterKey,
    cursors: [],
  });
  const cursors = page.key === filterKey ? page.cursors : [];
  const cursor = cursors.at(-1);
  const query = useQuery(
    suggestions.list.queryOptions({
      family: "statement_transaction",
      order: [{ by: "date", direction: "desc" }],
      where: {
        ...(filters.accountId ? { account: { in: [filters.accountId] } } : {}),
        ...(filters.month ? { month: { in: [filters.month] } } : {}),
        ...(filters.action ? { action: { in: [filters.action] } } : {}),
        ...(filters.clean === undefined
          ? {}
          : { clean: { in: [filters.clean] } }),
      },
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }),
  );
  const [outcomes, setOutcomes] = useState<Map<string, RowOutcome>>(
    () => new Map(),
  );
  const settle = async (
    suggestion: StatementSuggestionOut,
    item: ReviewItem,
  ) => {
    const id = suggestion.assessmentId;
    setOutcomes((previous) => new Map(previous).set(id, { state: "pending" }));
    let outcome: RowOutcome | undefined;
    try {
      const [result] = await review([item]);
      if (result && !result.ok)
        outcome = { state: "failed", error: result.error };
    } catch (error) {
      outcome = { state: "failed", error: errorText(error) };
    }
    setOutcomes((previous) => {
      const next = new Map(previous);
      if (outcome) next.set(id, outcome);
      else next.delete(id);
      return next;
    });
  };

  const scopeGroup = groups.find(
    (group) =>
      group.accountId === filters.accountId && group.month === filters.month,
  );
  const title = filters.accountId
    ? [filters.accountId, filters.month && monthLabel(filters.month)]
        .filter(Boolean)
        .join(" · ")
    : "All suggestions";
  const count = groups
    .filter(
      (group) =>
        (!filters.accountId || group.accountId === filters.accountId) &&
        (!filters.month || group.month === filters.month),
    )
    .reduce((sum, group) => sum + group.count, 0);
  const rows = useMemo(
    () =>
      query.data?.items.flatMap((row) =>
        row.family === "statement_transaction" ? [row.evidence] : [],
      ) ?? NO_SUGGESTIONS,
    [query.data],
  );
  const next = query.data?.next ?? null;

  return (
    <Section
      title={title}
      meta={
        query.data
          ? `${formatCount(count)} pending${scopeGroup ? ` · ${formatCount(scopeGroup.clean)} clean` : ""}`
          : undefined
      }
      actions={
        filters.accountId || filters.month ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Show all
          </Button>
        ) : null
      }
    >
      {query.error ? (
        <ErrorDisplay error={query.error} />
      ) : query.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading suggestions…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No pending suggestions here.
        </p>
      ) : (
        <Stack gap="sm">
          <Ledger aria-label="Statement suggestions">
            {rows.map((suggestion) => (
              <StatementSuggestionRow
                key={`${suggestion.assessmentId}:${suggestion.fingerprint ?? ""}`}
                suggestion={suggestion}
                outcome={outcomes.get(suggestion.assessmentId)}
                onApply={(choice: StatementChoice) =>
                  void settle(suggestion, applyItem(suggestion, choice))
                }
                onDismiss={() =>
                  void settle(suggestion, dismissItem(suggestion))
                }
              />
            ))}
          </Ledger>
          {cursors.length || next ? (
            <Row
              align="center"
              gap="sm"
              className="text-xs text-muted-foreground"
            >
              <span className="tabular-nums">
                Page {formatCount(cursors.length + 1)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!cursors.length}
                onClick={() =>
                  setPage({ key: filterKey, cursors: cursors.slice(0, -1) })
                }
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!next}
                onClick={() =>
                  next &&
                  setPage({ key: filterKey, cursors: [...cursors, next] })
                }
              >
                Next
              </Button>
            </Row>
          ) : null}
        </Stack>
      )}
    </Section>
  );
}
