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
import { useInfiniteTableListScope } from "~/entity/hooks/use-infinite-table-list";
import { Page, usePageCount } from "~/entity/page/page";
import { FindSuggestionsDialog } from "~/entity/suggestions/find-suggestions-dialog";
import { ListWorkbench } from "~/entity/table/list-workbench";
import { useChildListWorkbench } from "~/entity/table/use-child-list-workbench";
import {
  useTableState,
  type TableStateReturn,
} from "~/entity/table/use-table-state";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { suggestions } from "~/integrations/tanstack-query/generated/catalog/suggestions.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCount, formatCurrency } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import { countedGroupPage } from "~/ui/data-table/counted-group-page";
import type { CubbyTable, CubbyRow } from "~/ui/data-table/table-features";
import type { FilterConfig } from "~/ui/data-table/table-meta";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import type {
  ListQueryOptionsFn,
  ListQueryResponse,
} from "~/ui/hooks/use-paginated-table-core";
import { Panel } from "~/ui/layout/panel";
import { Alert } from "~/ui/primitives/alert";
import { Button } from "~/ui/primitives/button";
import { Tabs, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

import { useAcceptClean, type CleanTarget } from "./accept-clean";
import { AutomaticDecisions } from "./automatic-decisions";
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
  viewSetting,
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

/** Record scoping expands each family's declared affected records. */
function scopeFilters(search: SuggestionsSearch): ScopeFilters {
  const record = parseRecordParam(search.record);
  const recordScope: ScopeFilters = record
    ? { entity: record.entity, recordIds: [record.code] }
    : {};
  return {
    ...recordScope,
    ...(search.family ? { family: search.family } : {}),
    ...(search.runId ? { runId: search.runId } : {}),
  };
}

/** The chosen family, or the one a record scope implies. */
const familyOf = (search: SuggestionsSearch) =>
  search.family ?? scopeFilters(search).family ?? "all";

/** Legacy automatic-application URLs redirect before rendering this page. */
const viewOf = (search: SuggestionsSearch): SuggestionView => familyOf(search);

/** A count as a segment's trailing hint; "…" while it loads. */
const countHint = (count: number | undefined) =>
  count === undefined ? "…" : formatCount(count);

/** Pending work, optional audit and automation controls share one workspace. */
function StatusTabs({
  search,
  onSearch,
}: {
  search: SuggestionsSearch;
  onSearch: (patch: Partial<SuggestionsSearch>) => void;
}) {
  return (
    <Tabs
      value={search.status ?? "pending"}
      onValueChange={(value) =>
        onSearch({
          status:
            value === "rules" || value === "automatic" ? value : undefined,
        })
      }
    >
      <TabsList variant="line" aria-label="Suggestion status">
        <TabsTrigger value="pending">Pending</TabsTrigger>
        <TabsTrigger value="automatic">Automatic decisions</TabsTrigger>
        <TabsTrigger value="rules">Automatic rules</TabsTrigger>
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

type SuggestionTablePage = Omit<SuggestionListOut, "meta"> & {
  meta: ListQueryResponse<Row>["meta"];
  statementGroups?: SuggestionGroup[];
};
const queryPlan: ListQueryOptionsFn<QueryFilters, Row, SuggestionTablePage> = ({
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
    execute: async (signal) => {
      const result = await suggestions.list.call(input, { signal });
      const grouping = result.meta.groups
        ? countedGroupPage({
            groups: result.meta.groups,
            ids: result.items.map((row) => row.id),
            offset: result.meta.pageIndex * result.meta.pageSize,
            totalCount: result.meta.totalCount,
          })
        : {};
      return {
        ...result,
        statementGroups: result.meta.groups,
        meta: { ...result.meta, groups: undefined, ...grouping },
      };
    },
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
  multiple: false,
  dateKind: null,
  buckets: [],
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
        preset={
          search.family === "product_pair"
            ? { families: ["recommendation"] }
            : search.family && search.family !== "image_description"
              ? { families: [search.family] }
              : undefined
        }
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
        {!search.status ? (
          <FamilyChips search={search} onSearch={onSearch} />
        ) : null}
        {search.status !== "rules" ? (
          <ScopeChips
            search={
              search.status === "automatic"
                ? { ...search, runId: undefined }
                : search
            }
            onSearch={onSearch}
          />
        ) : null}
      </div>
      {search.status === "rules" ? (
        <div className="px-2 py-2 md:px-4">
          <AutomaticRulesSection />
        </div>
      ) : search.status === "automatic" ? (
        <div className="px-2 py-2 md:px-4">
          <AutomaticDecisions
            key={`${search.record}:${search.auditFamily ?? search.family}`}
            id={parseRecordParam(search.record)?.code}
            initialFamily={search.auditFamily ?? search.family}
          />
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
  const { family: _family, ...scope } = scopeFilters({
    ...search,
    family: undefined,
  });
  const counts = useQuery({
    ...suggestions.counts.queryOptions({ ...scope, where: scope.where ?? {} }),
  });
  const count = (family?: SuggestionListFamily) => {
    if (!counts.data) return undefined;
    return counts.data.families
      .filter((row) => !family || row.family === family)
      .reduce((sum, row) => sum + row.pending, 0);
  };
  return (
    <div className="max-w-full overflow-x-auto">
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
    </div>
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
} satisfies Partial<Record<SuggestionView, readonly string[]>>;

function QuickFilters({
  table,
  view,
  tableState,
  hints,
}: {
  table: CubbyTable<Row>;
  view: SuggestionView;
  tableState: TableStateReturn;
  hints: Record<string, Record<string, string>>;
}) {
  return (
    <>
      {(viewSetting(QUICK_FILTERS, view) ?? QUICK_FILTERS.all).map(
        (columnId) => {
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
              className="w-full md:w-44"
              options={options}
              isLoading={config.isLoading}
              onSearchChange={config.onSearchChange}
              records={config.records}
              onOpenChange={(open) => {
                if (open)
                  config.onActivate?.(
                    tableState.getColumnFilterValues(columnId),
                  );
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
        },
      )}
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
  const reviewScope = useInfiniteTableListScope({
    queryOptions: queryPlan,
    buildFilters,
    tableState,
  });
  const filters = useMemo(
    () => buildFilters(tableState),
    [buildFilters, tableState],
  );
  return (
    <SuggestionReviewProvider scope={reviewScope}>
      <SuggestionsTableBody
        view={view}
        grouped={grouped}
        onSearch={onSearch}
        filters={filters}
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
  filters,
  tableState,
  cleanFilters,
}: {
  view: SuggestionView;
  grouped: boolean;
  onSearch: (patch: Partial<SuggestionsSearch>, replace?: boolean) => void;
  filters: QueryFilters;
  tableState: TableStateReturn;
  cleanFilters: NonNullable<CleanTarget["filters"]>;
}) {
  const review = useSuggestionReview();
  const rosters = useDeferredEntityRosters(REFERENCE_ROSTERS);
  const providerCategoryLabel = "Provider category";
  const columns = useMemo(
    () => viewColumns(view, rosters, providerCategoryLabel),
    [view, rosters, providerCategoryLabel],
  );
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
  const list = useChildListWorkbench({
    read: queryPlan,
    filters,
    columns,
    tableState,
    navigation: { kind: "none" },
    selection: bulk,
    initialColumnVisibility: viewSetting<Record<string, false>>(
      VIEW_HIDDEN_COLUMNS,
      view,
    ),
    scrollRestorationId: `suggestions-${view}`,
    rowContentVersion: review,
  });
  const table = list.model.table;
  usePageCount(list.isLoading ? undefined : list.totalCount);
  const rowsById = useMemo(
    () => new Map(list.data.map((row) => [row.id, row.record])),
    [list.data],
  );
  const accept = useAcceptClean((id) => rowsById.get(id));
  const firstPage = list.pages?.[0];
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

  const groups = firstPage?.statementGroups ?? NO_GROUPS;
  const groupConfig = useMemo<GroupConfig | undefined>(
    () =>
      grouped
        ? {
            choice: ACCOUNT_MONTH_CHOICE,
            memberships: list.memberships ?? [],
            groups: (firstPage?.meta.groups ?? []).map((group) => ({
              ...group,
              label: monthLabel(
                groups.find((source) => source.key === group.path[0])?.month ??
                  group.label,
              ),
            })),
            header: (summary) => {
              const group = groups.find((item) => item.key === summary.path[0]);
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
                    disabled={
                      group.clean === 0 ||
                      accept.running ||
                      list.infiniteScroll.isTransitioning
                    }
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
    [
      grouped,
      groups,
      firstPage?.meta.groups,
      list.memberships,
      accept,
      cleanFilters,
      list.infiniteScroll.isTransitioning,
    ],
  );

  // Keyboard review: ↑/↓ move, → open evidence, ← close, A accept, D dismiss.
  const [current, setCurrent] = useState<string | undefined>();
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      ownsKeys(event.target) ||
      list.infiniteScroll.isTransitioning
    )
      return;
    const rows = list.data;
    const index = rows.findIndex((row) => row.id === current);
    const row = rows[index];
    const reviewable = row;
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
            className="w-full md:w-60"
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
        {cleanCount > 0 && !grouped ? (
          <Panel
            tone="default"
            className="flex flex-wrap items-center gap-2 py-1.5 text-xs"
          >
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
                disabled={accept.running || list.infiniteScroll.isTransitioning}
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
          </Panel>
        ) : null}
        {accept.dialogs}
        {review.failures.length ? (
          <Alert variant="destructive" className="flex flex-col gap-1">
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
          </Alert>
        ) : null}
      </div>
      <ListWorkbench
        model={{ ...list.model, groupConfig }}
        ariaLabel="Suggestions"
        rowDetail={{ openIds: review.openIds, render: renderDetail }}
        filterOptionHints={hints}
        currentRowId={current}
        onRowClick={(row) => setCurrent(row.id)}
        renderMobileRowFooter={(row) => (
          <MobileEvidenceDisclosure row={row}>
            <SuggestionEvidence row={row} />
          </MobileEvidenceDisclosure>
        )}
        showColumnMenu
        emptyState={
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No pending suggestions here. Find suggestions to look again.
          </p>
        }
      />
    </div>
  );
}
