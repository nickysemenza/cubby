import {
  type SuggestionGroup,
  type SuggestionListFamily,
  type SuggestionListFilters,
  type SuggestionListOut,
  type SuggestionListRow,
  suggestionListInput,
} from "@cubby/schemas/suggestion-list";
import { humanize } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { z } from "zod";

import { useDeferredEntityRosters } from "~/entity/hooks/use-deferred-reference-filter-options";
import { useInfiniteTableList } from "~/entity/hooks/use-infinite-table-list";
import { Page, usePageCount } from "~/entity/page/page";
import { FindSuggestionsDialog } from "~/entity/suggestions/find-suggestions-dialog";
import RTable from "~/entity/table/table";
import {
  useTableState,
  type TableStateReturn,
} from "~/entity/table/use-table-state";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { suggestions } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCount, formatCurrency } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { BulkActionBar } from "~/ui/data-table/bulk-action-bar";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import type { CubbyRow } from "~/ui/data-table/table-features";
import type { FilterConfig } from "~/ui/data-table/table-meta";
import { useBulkActions } from "~/ui/data-table/use-bulk-actions";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { useTableConfig } from "~/ui/data-table/use-table-config";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";
import { Button } from "~/ui/primitives/button";
import { Tabs, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

import { useAcceptClean, type CleanTarget } from "./accept-clean";
import { AutomaticRulesSection } from "./automatic-rules";
import { MobileEvidenceDisclosure } from "./suggestion-actions";
import { SuggestionEvidence } from "./suggestion-evidence";
import { acceptItem, dismissItem, neverSuggestItem } from "./suggestion-review";
import {
  SuggestionReviewProvider,
  useSuggestionReview,
} from "./suggestion-review-context";
import { FAMILY_CHIPS, RecordLink } from "./suggestion-values";
import {
  REFERENCE_ROSTERS,
  VIEW_HIDDEN_COLUMNS,
  buildWhere,
  viewColumns,
  viewFilterSpecs,
  type SuggestionView,
} from "./suggestion-views";
import { parseRecordParam, type SuggestionsSearch } from "./suggestions-search";
import { SweepStatusLine, useRunningSweep } from "./sweep-status";

type Row = SuggestionListRow;
const NO_GROUPS: SuggestionGroup[] = [];

type ScopeFilters = Omit<
  z.input<typeof suggestionListInput>,
  "order" | "cursor" | "offset" | "limit" | "groups"
>;

/**
 * The route scope as list filters. A financial account's statement
 * Suggestions belong to its StatementRows, so an account record filters the
 * statement family's account column; any other record lists by `recordIds`.
 */
function scopeFilters(search: SuggestionsSearch): ScopeFilters {
  const record = parseRecordParam(search.record);
  const recordScope: ScopeFilters = record
    ? record.entity === "financialAccount"
      ? {
          family: "statement_transaction",
          where: { account: { in: [record.code] } },
        }
      : { entity: record.entity, recordIds: [record.code] }
    : {};
  return {
    ...recordScope,
    ...(search.family ? { family: search.family } : {}),
    ...(search.runId ? { runId: search.runId } : {}),
    ...(search.status === "applied_automatically"
      ? { appliedAutomatically: true }
      : {}),
  };
}

/** The chosen family, or the one a record scope implies. */
const familyOf = (search: SuggestionsSearch) =>
  search.family ?? scopeFilters(search).family ?? "all";

/** The table's view: what rules applied, else the family's own. */
const viewOf = (search: SuggestionsSearch): SuggestionView =>
  search.status === "applied_automatically" ? "applied" : familyOf(search);

/** A count as a segment's trailing hint; "…" while it loads. */
const countHint = (count: number | undefined) =>
  count === undefined ? "…" : formatCount(count);

/**
 * The page's three tabs: pending Suggestions, the changes Automatic rules
 * applied without review, and the rules themselves with their switches.
 */
function StatusTabs({
  search,
  onSearch,
}: {
  search: SuggestionsSearch;
  onSearch: (patch: Partial<SuggestionsSearch>) => void;
}) {
  const { appliedAutomatically: _applied, ...scope } = scopeFilters({
    ...search,
    status: undefined,
  });
  const counts = useQuery(
    suggestions.counts.queryOptions({ ...scope, where: scope.where ?? {} }),
  );
  // Counts read pending outcomes; the applied view's total comes from its list.
  const applied = useQuery(
    suggestions.list.queryOptions({
      ...scope,
      appliedAutomatically: true,
      limit: 1,
    }),
  );
  const pending = counts.data?.families.reduce(
    (sum, row) => sum + row.pending,
    0,
  );
  const rules = useQuery(suggestions.rules.queryOptions({}));
  const rulesOn = rules.data?.rules.filter((rule) => rule.enabled).length;
  const tab = (label: string, hint: string | undefined) => (
    <>
      {label}
      {hint === undefined ? null : (
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {hint}
        </span>
      )}
    </>
  );
  return (
    <Tabs
      value={search.status ?? "pending"}
      onValueChange={(value) =>
        onSearch(
          value === "applied_automatically" || value === "rules"
            ? { status: value, group: undefined }
            : { status: undefined },
        )
      }
    >
      <TabsList
        variant="line"
        aria-label="Suggestion status"
        className="h-auto max-w-full flex-wrap justify-start gap-2 [&>[data-slot=tabs-trigger]]:flex-none"
      >
        <TabsTrigger value="pending">
          {tab("Pending", countHint(pending))}
        </TabsTrigger>
        <TabsTrigger value="applied_automatically">
          {tab(
            "Applied automatically",
            countHint(applied.data?.meta.totalCount),
          )}
        </TabsTrigger>
        <TabsTrigger value="rules">
          {tab(
            "Automatic rules",
            rules.data ? `${rulesOn} of ${rules.data.rules.length} on` : "…",
          )}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

type QueryFilters = {
  scope: ScopeFilters;
  view: SuggestionView;
  grouped: boolean;
  where: SuggestionListFilters["where"];
};

const ORDER_OPTIONS: PickerOption[] = [
  { value: "ready", label: "Clean first · strongest · newest" },
  { value: "impact", label: "Most impact" },
];

const queryPlan: ListQueryOptionsFn<QueryFilters, Row, SuggestionListOut> = ({
  filters,
  pagination,
  sort,
}) => {
  const input = suggestionListInput.parse({
    ...filters.scope,
    where: { ...filters.scope.where, ...filters.where },
    order: sort?.length
      ? sort.map((term) => ({ by: term.orderBy, direction: term.direction }))
      : undefined,
    offset: pagination.pageIndex * pagination.pageSize,
    limit: pagination.pageSize,
    ...(filters.grouped ? { groups: "account_month" } : {}),
  });
  const options = suggestions.list.queryOptions(input);
  return {
    queryKey: options.queryKey,
    meta: options.meta,
    execute: (signal) => suggestions.list.call(input, { signal }),
  };
};

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

const ACCOUNT_MONTH_CHOICE: GroupConfig["choice"] = {
  key: "account_month",
  label: "Account × month",
  noValueLabel: "No account",
  reason: null,
  value: { kind: "derived", options: null },
  filter: null,
  levels: 0,
  levelReason: "Account × month is a statement section, not a hierarchy.",
};

/**
 * Focus that owns the arrow keys: text entry, a picker, a menu, a dialog,
 * or a segmented group. Review shortcuts never steal keys from them.
 */
const ownsKeys = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest(
      "[role=combobox],[role=listbox],[role=menu],[role=menubar],[role=menuitem],[role=option],[role=dialog],[role=alertdialog],[role=group][aria-label],[aria-haspopup]:not([aria-haspopup=false])",
    ) !== null);

/** Brings the keyboard-current row into view without moving focus. */
const revealRow = (container: HTMLElement | null) =>
  requestAnimationFrame(() =>
    container
      ?.querySelector("[data-current=true]")
      ?.scrollIntoView({ block: "nearest" }),
  );

/** The Suggestions page: one table over every family's pending Suggestions. */
export function SuggestionsPage({
  search,
  onSearch,
}: {
  search: SuggestionsSearch;
  onSearch: (patch: Partial<SuggestionsSearch>, replace?: boolean) => void;
}) {
  const [finding, setFinding] = useState(false);
  const queryClient = useQueryClient();
  const refreshSuggestions = useCallback(
    () => void invalidateOperationTags(queryClient, ripple.suggestions),
    [queryClient],
  );
  const runningSweep = useRunningSweep(!search.sweep);
  const sweep = search.sweep ?? runningSweep;
  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Suggestions"
      layout="full"
      bodyGutter="none"
      actions={
        <Button onClick={() => setFinding(true)}>Find suggestions…</Button>
      }
    >
      <FindSuggestionsDialog
        open={finding}
        onOpenChange={setFinding}
        preset={search.family ? { families: [search.family] } : undefined}
        onStarted={(runId) => onSearch({ sweep: runId })}
      />
      <div className="flex flex-col gap-2 px-2 pt-2 md:px-4">
        {sweep ? (
          <SweepStatusLine
            key={sweep}
            runId={sweep}
            // A finished Sweep published new Suggestions: refresh rows and counts.
            onSettled={refreshSuggestions}
          />
        ) : null}
        <StatusTabs search={search} onSearch={onSearch} />
        {search.status === "rules" ? null : (
          <>
            <FamilyChips search={search} onSearch={onSearch} />
            <ScopeChips search={search} onSearch={onSearch} />
          </>
        )}
      </div>
      {search.status === "rules" ? (
        <div className="px-2 py-2 md:px-4">
          <AutomaticRulesSection />
        </div>
      ) : (
        <SuggestionsTable
          // Each view owns its own columns, filter URL keys and selection.
          key={viewOf(search)}
          search={search}
          onSearch={onSearch}
        />
      )}
    </Page>
  );
}

function FamilyChips({
  search,
  onSearch,
}: {
  search: SuggestionsSearch;
  onSearch: (patch: Partial<SuggestionsSearch>) => void;
}) {
  const {
    family: _family,
    appliedAutomatically,
    ...scope
  } = scopeFilters({
    ...search,
    family: undefined,
  });
  const counts = useQuery({
    ...suggestions.counts.queryOptions({ ...scope, where: scope.where ?? {} }),
    enabled: !appliedAutomatically,
  });
  // The applied view counts each family from its own list total.
  const applied = useQuery({
    ...suggestions.list.queryOptions({
      ...scope,
      appliedAutomatically: true,
      limit: 1,
    }),
    enabled: Boolean(appliedAutomatically),
  });
  const appliedFacet = applied.data?.facets.family;
  const count = (family?: SuggestionListFamily) => {
    if (appliedAutomatically) {
      if (!applied.data) return undefined;
      return family
        ? (appliedFacet?.find((facet) => facet.value === family)?.count ?? 0)
        : applied.data.meta.totalCount;
    }
    if (!counts.data) return undefined;
    return counts.data.families
      .filter((row) => !family || row.family === family)
      .reduce((sum, row) => sum + row.pending, 0);
  };
  return (
    <Picker
      mode="segmented"
      label="Suggestion families"
      options={[
        { value: "all", label: "All", hint: countHint(count()) },
        ...FAMILY_CHIPS.map((chip) => ({
          value: chip.family,
          label: chip.label,
          hint: countHint(count(chip.family)),
        })),
      ]}
      value={familyOf(search)}
      onValueChange={(value) =>
        onSearch({
          family: FAMILY_CHIPS.find((chip) => chip.family === value)?.family,
          group: undefined,
        })
      }
    />
  );
}

/** The route's record and Run scopes as removable chips, named by their records. */
function ScopeChips({
  search,
  onSearch,
}: {
  search: SuggestionsSearch;
  onSearch: (patch: Partial<SuggestionsSearch>) => void;
}) {
  const record = parseRecordParam(search.record);
  if (!record && !search.runId) return null;
  const chip = (label: string, link: ReactNode, clear: () => void) => (
    <span className="inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {link}
      <button
        type="button"
        aria-label={`Clear ${label.toLowerCase()} scope`}
        onClick={clear}
        className="rounded-sm text-muted-foreground hover:text-foreground"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {record
        ? chip(
            "Record",
            <RecordLink record={{ entity: record.entity, id: record.code }} />,
            () => onSearch({ record: undefined }),
          )
        : null}
      {search.runId
        ? chip(
            "Run",
            <RecordLink record={{ entity: "run", id: search.runId }} />,
            () => onSearch({ runId: undefined }),
          )
        : null}
    </div>
  );
}

/** The quick filters a view keeps outside the Filters disclosure. */
const QUICK_FILTERS = {
  all: ["strength"],
  field: ["entity", "field", "kind"],
  statement_transaction: ["clean", "action", "kind", "account", "owner"],
  recommendation: ["relation", "entityKind"],
  transfer_pair: ["clean", "strength", "owner"],
  applied: [],
} satisfies Record<SuggestionView, readonly string[]>;

function QuickFilters({
  table,
  view,
  tableState,
  hints,
}: {
  table: ReturnType<typeof useTableConfig<Row>>;
  view: SuggestionView;
  tableState: TableStateReturn;
  hints: Record<string, Record<string, string>>;
}) {
  return (
    <>
      {QUICK_FILTERS[view].map((columnId) => {
        const column = table.getColumn(columnId);
        const config: FilterConfig | undefined =
          column?.columnDef.meta?.filterConfig;
        if (!config?.options || config.freeText) return null;
        const label =
          config.label ??
          (typeof column?.columnDef.header === "string"
            ? column.columnDef.header
            : humanize(columnId));
        const options = config.options.map((option) => ({
          ...option,
          hint: hints[columnId]?.[option.value],
        }));
        return (
          <Picker
            key={columnId}
            multiple
            compact
            label={label}
            placeholder={`Any ${label.toLowerCase()}`}
            className="w-44"
            options={options}
            isLoading={config.isLoading}
            onSearchChange={config.onSearchChange}
            records={config.records}
            onOpenChange={(open) => {
              if (open)
                config.onActivate?.(tableState.getColumnFilterValues(columnId));
            }}
            values={tableState.getColumnFilterValues(columnId) ?? []}
            onValuesChange={(values) =>
              tableState.setColumnFilters((previous) => [
                ...previous.filter((filter) => filter.id !== columnId),
                ...(values.length ? [{ id: columnId, value: values }] : []),
              ])
            }
          />
        );
      })}
    </>
  );
}

function SuggestionsTable({
  search,
  onSearch,
}: {
  search: SuggestionsSearch;
  onSearch: (patch: Partial<SuggestionsSearch>, replace?: boolean) => void;
}) {
  const view = viewOf(search);
  const grouped =
    view === "statement_transaction" && search.group === "account_month";
  const tableState = useTableState({
    initialSort: "ready",
    initialSortDesc: true,
    filterSpecs: viewFilterSpecs(view),
    urlSync: true,
    syncPaginationToUrl: false,
  });
  const scope = useMemo(() => scopeFilters(search), [search]);
  const buildFilters = useCallback(
    (state: TableStateReturn): QueryFilters => ({
      scope,
      view,
      grouped,
      where: buildWhere(view, state),
    }),
    [scope, view, grouped],
  );
  const list = useInfiniteTableList({
    queryOptions: queryPlan,
    buildFilters,
    tableState,
  });
  usePageCount(list.isLoading ? undefined : list.totalCount);
  const filters = buildFilters(tableState);
  const reviewScope = JSON.stringify([filters, tableState.sorting]);
  return (
    <SuggestionReviewProvider scope={reviewScope}>
      <SuggestionsTableBody
        view={view}
        grouped={grouped}
        onSearch={onSearch}
        list={list}
        tableState={tableState}
        cleanFilters={{
          ...filters.scope,
          where: { ...filters.scope.where, ...filters.where },
        }}
      />
    </SuggestionReviewProvider>
  );
}

function SuggestionsTableBody({
  view,
  grouped,
  onSearch,
  list,
  tableState,
  cleanFilters,
}: {
  view: SuggestionView;
  grouped: boolean;
  onSearch: (patch: Partial<SuggestionsSearch>, replace?: boolean) => void;
  list: ReturnType<
    typeof useInfiniteTableList<QueryFilters, Row, SuggestionListOut>
  >;
  tableState: TableStateReturn;
  cleanFilters: NonNullable<CleanTarget["filters"]>;
}) {
  const review = useSuggestionReview();
  const rowsById = useMemo(
    () => new Map(list.data.map((row) => [row.id, row.record])),
    [list.data],
  );
  const accept = useAcceptClean((id) => rowsById.get(id));
  const rosters = useDeferredEntityRosters(REFERENCE_ROSTERS);
  const firstPage = list.pages?.[0];
  const sources = useMemo(
    () =>
      new Set(
        list.data.flatMap((row) =>
          row.family === "statement_transaction" ? [row.evidence.source] : [],
        ),
      ),
    [list.data],
  );
  // Verbatim provider evidence, never "Category": it sets no spending category.
  const providerCategoryLabel =
    sources.size === 1
      ? `${humanize([...sources][0] ?? "")} category`
      : "Provider category";
  const columns = useMemo(
    () => viewColumns(view, rosters, providerCategoryLabel),
    [view, rosters, providerCategoryLabel],
  );
  const hints = useMemo(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const [column, counts] of Object.entries(firstPage?.facets ?? {}))
      out[column] = Object.fromEntries(
        counts.map(({ value, count }) => [String(value), formatCount(count)]),
      );
    return out;
  }, [firstPage?.facets]);
  const cleanCount =
    firstPage?.facets.clean?.find((facet) => facet.value === true)?.count ?? 0;

  const bulk: BulkActionsConfig<Row> = {
    actions: [
      {
        id: "dismiss",
        label: "Dismiss",
        icon: <EyeSlashIcon />,
        onExecute: async (rows) => {
          const failures = await review.review(
            rows.map((row) => row.original),
            dismissItem,
          );
          return { success: failures.length === 0 };
        },
      },
      {
        id: "never-suggest",
        label: "Never suggest",
        icon: <ProhibitIcon />,
        tone: "destructive",
        availability: (rows) =>
          rows.every((row) => neverSuggestItem(row.original) !== null)
            ? { status: "available" }
            : {
                status: "disabled",
                reason:
                  "Field suggestions have no lasting suppression; dismiss them instead.",
              },
        onExecute: async (rows) => {
          const failures = await review.review(
            rows.map((row) => row.original),
            neverSuggestItem,
          );
          return { success: failures.length === 0 };
        },
      },
    ],
  };
  const selection = useBulkActions({ config: bulk });
  const table = useTableConfig({
    data: list.data,
    columns,
    tableState,
    totalCount: list.data.length,
    getRowId: (row) => row.id,
    rowSelection: selection.rowSelection,
    onRowSelectionChange: selection.onRowSelectionChange,
    initialColumnVisibility: VIEW_HIDDEN_COLUMNS[view],
    scrollRestorationId: `suggestions-${view}`,
    rowContentVersion: review,
  });

  const groups = firstPage?.meta.groups ?? NO_GROUPS;
  const groupConfig = useMemo<GroupConfig | undefined>(
    () =>
      grouped
        ? {
            choice: ACCOUNT_MONTH_CHOICE,
            groups: groups.map((group) => ({
              ...group,
              label: monthLabel(group.month),
            })),
            header: (summary) => {
              const group = groups.find((item) => item.key === summary.key);
              if (!group) return {};
              return {
                aside: (
                  <>
                    <RecordLink
                      record={{
                        entity: "financialAccount",
                        id: group.accountId,
                      }}
                    />
                    {group.ownerId ? (
                      <RecordLink
                        record={{ entity: "ledgerParty", id: group.ownerId }}
                      />
                    ) : null}
                    <span className="text-muted-foreground tabular-nums">
                      {formatCurrency(group.amount)}
                    </span>
                  </>
                ),
                actions: (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={group.clean === 0 || accept.running}
                    onClick={() =>
                      accept.confirm({
                        label: `${monthLabel(group.month)} account group`,
                        count: group.clean,
                        filters: {
                          ...cleanFilters,
                          family: "statement_transaction",
                          where: {
                            ...cleanFilters.where,
                            account: { in: [group.accountId] },
                            month: { in: [group.month] },
                          },
                        },
                      })
                    }
                  >
                    Accept {formatCount(group.clean)} clean
                  </Button>
                ),
              };
            },
          }
        : undefined,
    [grouped, groups, accept, cleanFilters],
  );

  // Keyboard review: ↑/↓ move, → open evidence, ← close, A accept, D dismiss.
  const [current, setCurrent] = useState<string | undefined>();
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      ownsKeys(event.target)
    )
      return;
    const rows = list.data;
    const index = rows.findIndex((row) => row.id === current);
    const row = rows[index];
    // Applied rows are already settled: A and D have nothing to review.
    const reviewable = view === "applied" ? undefined : row;
    // A settled row leaves the list: the next row (else the previous) stays current.
    const advance = () => {
      const next = rows[index + 1] ?? rows[index - 1];
      setCurrent(next?.id);
    };
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          const next =
            rows[
              Math.min(
                rows.length - 1,
                Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
              )
            ];
          if (next) setCurrent(next.id);
          revealRow(event.currentTarget);
          return true;
        }
        case "ArrowRight":
          if (row) review.toggleOpen(row.id, true);
          return Boolean(row);
        case "ArrowLeft":
          if (row) review.toggleOpen(row.id, false);
          return Boolean(row);
        case "a":
        case "A":
          if (reviewable) {
            void review.review([reviewable], (target) =>
              acceptItem(target, review.statementChoice(target)),
            );
            advance();
            revealRow(event.currentTarget);
          }
          return Boolean(reviewable);
        case "d":
        case "D":
          if (reviewable) {
            void review.review([reviewable], dismissItem);
            advance();
            revealRow(event.currentTarget);
          }
          return Boolean(reviewable);
        default:
          return false;
      }
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const order =
    tableState.sorting[0]?.id === "impact" && tableState.sorting.length === 1
      ? "impact"
      : tableState.sorting.length === 1 && tableState.sorting[0]?.id === "ready"
        ? "ready"
        : null;
  const isLoading = useHydratedLoading(list.isLoading);
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const renderDetail = useCallback(
    (row: CubbyRow<Row>) => <SuggestionEvidence row={row.original} />,
    [],
  );
  return (
    <div className="flex min-w-0 flex-col" onKeyDownCapture={onKeyDownCapture}>
      <div className="flex flex-col gap-2 px-2 py-2 md:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <QuickFilters
            table={table}
            view={view}
            tableState={tableState}
            hints={hints}
          />
          <Picker
            mode="choose"
            compact
            label="Sort"
            className="w-60"
            options={
              order
                ? ORDER_OPTIONS
                : [...ORDER_OPTIONS, { value: "custom", label: "Column sort" }]
            }
            value={order ?? "custom"}
            onValueChange={(value) => {
              if (value === "ready" || value === "impact")
                tableState.setSorting([{ id: value, desc: true }]);
            }}
          />
          {view === "statement_transaction" ? (
            <Picker
              mode="segmented"
              label="Group"
              options={[
                { value: "none", label: "No groups" },
                { value: "account_month", label: "Account × month" },
              ]}
              value={grouped ? "account_month" : "none"}
              onValueChange={(value) =>
                onSearch(
                  {
                    group:
                      value === "account_month" ? "account_month" : undefined,
                  },
                  true,
                )
              }
            />
          ) : null}
        </div>
        {cleanCount > 0 && !grouped && view !== "applied" ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-positive/30 bg-positive/5 px-2.5 py-1.5 text-xs">
            <span className="font-medium text-positive">Clean</span>
            <span>
              {countLabel(cleanCount, "suggestion", { formatted: true })} can be
              accepted together
            </span>
            <span className="text-muted-foreground">
              deterministic evidence, no competing candidate
            </span>
            <span className="ml-auto flex gap-1">
              <Button
                size="xs"
                disabled={accept.running}
                onClick={() =>
                  accept.confirm({
                    label: "Every clean suggestion in this view",
                    count: cleanCount,
                    filters: cleanFilters,
                  })
                }
              >
                Accept {formatCount(cleanCount)} clean
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  tableState.setColumnFilters((previous) => [
                    ...previous.filter((filter) => filter.id !== "clean"),
                    { id: "clean", value: ["true"] },
                  ])
                }
              >
                Review first
              </Button>
            </span>
          </div>
        ) : null}
        {accept.dialogs}
        {review.failures.length ? (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-destructive">
                {countLabel(review.failures.length, "suggestion")} could not be
                settled
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={review.clearFailures}
              >
                Clear
              </Button>
            </div>
            <ul aria-label="Review failures" className="flex flex-col gap-0.5">
              {review.failures.map((failure) => (
                <li key={failure.row.id} className="flex min-w-0 gap-1.5">
                  <RecordLink record={failure.row.record} />
                  <span className="font-mono whitespace-pre-wrap text-destructive">
                    {failure.error}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <RTable
        table={table}
        ariaLabel="Suggestions"
        isLoading={isLoading}
        error={list.error}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
        groupConfig={groupConfig}
        rowDetail={{ openIds: review.openIds, render: renderDetail }}
        filterOptionHints={hints}
        currentRowId={current}
        onRowClick={(row) => setCurrent(row.id)}
        getMobileDetailsHref={() => undefined}
        disableMobileDetailsHref
        renderMobileRowFooter={(row) => (
          <MobileEvidenceDisclosure row={row}>
            <SuggestionEvidence row={row} />
          </MobileEvidenceDisclosure>
        )}
        bulkActionBar={
          <BulkActionBar
            selectedCount={selection.selectedCount}
            selectedRows={selectedRows}
            actions={selection.getAvailableActions(selectedRows)}
            onExecute={selection.executeAction}
            onClearSelection={selection.clearSelection}
            isExecuting={selection.isExecuting}
            currentAction={selection.currentAction}
            disabled={list.infiniteScroll.isTransitioning}
          />
        }
        showColumnMenu
        emptyState={
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {view === "applied"
              ? "No Automatic rule has applied a change here."
              : "No pending suggestions here. Find suggestions to look again."}
          </p>
        }
      />
    </div>
  );
}
