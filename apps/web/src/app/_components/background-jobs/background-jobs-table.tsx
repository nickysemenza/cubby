import type { AuditEntityType } from "@cubby/schemas/audit";
import {
  type BackgroundBatchStatus,
  type BackgroundJobKind,
  type BackgroundJobStatus,
  backgroundBatchProcessors,
  backgroundBatchSources,
  backgroundBatchStatuses,
  backgroundJobKinds,
  backgroundJobPayloadSchema,
} from "@cubby/schemas/background-jobs";
import { parseShortcode } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import type { ExpandedState, OnChangeFn } from "@tanstack/react-table";
import {
  AlertTriangle,
  ChevronRight,
  ClipboardCopy,
  Eye,
  type LucideIcon,
  MoreHorizontal,
  RotateCcw,
  Square,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { toast } from "sonner";

import { DebugDialog } from "~/app/_components/data-table/DebugDialog";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyCellContext,
  type CubbyFilterFn,
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { useTableState } from "~/app/_components/data-table/useTableState";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row } from "~/components/layout";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Spinner } from "~/components/ui/spinner";
import { copyText } from "~/lib/clipboard";

import type {
  BackgroundBatchRow,
  BackgroundJobRow,
  BackgroundJobTableRow,
} from "./background-job-rows";
import {
  backgroundJobRowId,
  backgroundJobSubRows,
} from "./background-job-rows";
import {
  batchFilterText,
  parseBackgroundEntityRef,
  parseBackgroundMetadata,
} from "./batch-metadata";
import { formatDate } from "./format";

type QueueStatus = BackgroundBatchStatus | BackgroundJobStatus;
const STATUS_TONE = {
  pending: "slate",
  queued: "slate",
  running: "default",
  succeeded: "positive",
  skipped: "outline",
  partial: "warning",
  failed: "destructive",
  cancelled: "outline",
} satisfies Record<QueueStatus, BadgeVariant>;
const COLUMN_DEFAULTS = {
  sortUndefined: "last" as const,
  enableCellSelection: false,
};
const SELECT_FILTERS = [
  ["batchKind", "kind", "Kind", backgroundJobKinds],
  ["batchSource", "source", "Source", backgroundBatchSources],
  ["batchProcessor", "processor", "Processor", backgroundBatchProcessors],
  ["batchStatus", "status", "Status", backgroundBatchStatuses],
] as const;
const JOB_LABEL = {
  "entity-embedding.backfill.coordinator": "Continue semantic backfill",
  "search-document.repair.coordinator": "Continue document repair",
  "location-valuation.recompute": "All locations",
  "problems.counts.refresh": "Problem counts",
} satisfies Partial<Record<BackgroundJobKind, string>>;

const isExpandedUpdater = (
  value: ExpandedState | ((previous: ExpandedState) => ExpandedState),
): value is (previous: ExpandedState) => ExpandedState =>
  typeof value === "function";

interface BackgroundJobsTableProps {
  rows: BackgroundJobTableRow[];
  selectedBatchId?: string;
  showFailedOnly: boolean;
  isLoading: boolean;
  error: unknown;
  onRetry?: () => void;
  actions: ReactNode;
  onExpandedBatchChange: (batchId?: string) => void;
  onFailedOnlyChange: (batchId: string, failedOnly: boolean) => void;
  onRetryBatch: (batchId: string) => void;
  onCancelBatch: (batchId: string) => void;
  onRetryJob: (jobId: string) => void;
  onPageChange: (pageIndex: number) => void;
}
type ActionProps = Pick<
  BackgroundJobsTableProps,
  | "selectedBatchId"
  | "showFailedOnly"
  | "onFailedOnlyChange"
  | "onRetryBatch"
  | "onCancelBatch"
  | "onRetryJob"
  | "onPageChange"
>;
type MenuAction = {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  run: () => void;
};

function EntityTarget({
  entityType,
  entityId,
}: {
  entityType: AuditEntityType;
  entityId: string;
}) {
  // Queue payloads use private uuids, while detail routes and getByID now
  // accept public shortcodes. Never send a uuid into that public-id boundary.
  return parseShortcode(entityId)?.type === entityType ? (
    <EntityInlineLinkById entityType={entityType} entityId={entityId} compact />
  ) : (
    <span className="text-muted-foreground">
      {entityType} · {entityId.slice(0, 8)}
    </span>
  );
}

function OriginLink({ batch }: { batch: BackgroundBatchRow["batch"] }) {
  const metadata = parseBackgroundMetadata(batch.metadata);
  const source = metadata?.source ?? null;
  const entity = parseBackgroundEntityRef(metadata?.entity);
  if (entity) return <EntityTarget {...entity} />;
  if (source) return source;
  if (batch.source === "backfill" && batch.kind === "entity-embedding.refresh")
    return (
      <Link
        to="/search/debug"
        className="underline decoration-dotted underline-offset-2"
      >
        Search debug
      </Link>
    );
  return <span className="text-muted-foreground">{batch.source}</span>;
}

function JobTarget({ row }: { row: BackgroundJobRow }) {
  const result = backgroundJobPayloadSchema.safeParse({
    kind: row.job.kind,
    payload: row.job.payload,
  });
  if (!result.success)
    return <span className="text-destructive">Invalid payload</span>;
  const { kind, payload } = result.data;
  if ("entityType" in payload) return <EntityTarget {...payload} />;
  if ("locationId" in payload)
    return <EntityTarget entityType="location" entityId={payload.locationId} />;
  if ("ingredientId" in payload)
    return (
      <EntityTarget entityType="ingredient" entityId={payload.ingredientId} />
    );
  if ("recipeIds" in payload) {
    const [id] = payload.recipeIds;
    return id && payload.recipeIds.length === 1 ? (
      <EntityTarget entityType="recipe" entityId={id} />
    ) : (
      `${payload.recipeIds.length} recipes`
    );
  }
  return Object.entries(JOB_LABEL).find(([label]) => label === kind)?.[1];
}

async function copyJson(serialized: string, label: string) {
  if (!(await copyText(serialized))) return toast.error("Copy failed");
  toast.success(`Copied ${label}`);
}

function RowActions({
  row,
  ...props
}: { row: BackgroundJobTableRow } & ActionProps) {
  if (row.rowType === "pager") {
    const hasNext = (row.pageIndex + 1) * row.pageSize < row.totalCount;
    return (
      <Row gap="xs">
        <Button
          variant="outline"
          size="xs"
          disabled={!row.pageIndex}
          onClick={() => props.onPageChange(row.pageIndex - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!hasNext}
          onClick={() => props.onPageChange(row.pageIndex + 1)}
        >
          Next
        </Button>
      </Row>
    );
  }
  if (row.rowType !== "batch" && row.rowType !== "job") return null;
  const batch = row.rowType === "batch" ? row.batch : null;
  const job = row.rowType === "job" ? row.job : null;
  const copyLabel = batch ? "metadata" : "payload";
  const actions: MenuAction[] = [];
  const add = (
    label: string,
    icon: LucideIcon,
    run: () => void,
    disabled?: boolean,
  ) => actions.push({ label, icon, run, disabled });
  add(
    `Copy ${copyLabel}`,
    ClipboardCopy,
    () =>
      void copyJson(
        JSON.stringify(batch?.metadata ?? job?.payload, null, 2) ?? "null",
        copyLabel,
      ),
  );
  if (batch) {
    const failedOnly = row.id === props.selectedBatchId && props.showFailedOnly;
    add(failedOnly ? "Show all jobs" : "Show failed jobs", AlertTriangle, () =>
      props.onFailedOnlyChange(row.id, !failedOnly),
    );
    add(
      "Retry failed",
      RotateCcw,
      () => props.onRetryBatch(row.id),
      !batch.failedJobs,
    );
    add(
      "Cancel queued",
      Square,
      () => props.onCancelBatch(row.id),
      !batch.queuedJobs,
    );
  } else {
    if (job?.lastError)
      add(
        "Copy error",
        ClipboardCopy,
        () =>
          void copyJson(JSON.stringify(job.lastError, null, 2), "job error"),
      );
    add(
      "Retry job",
      RotateCcw,
      () => props.onRetryJob(row.id),
      job?.status !== "failed",
    );
  }
  return (
    <Row gap="tight">
      <DebugDialog
        data={batch ?? job}
        title={batch ? "Batch details" : "Job details"}
        trigger={
          <Button variant="ghost" size="icon-sm">
            <Eye />
            <span className="sr-only">Inspect {row.rowType}</span>
          </Button>
        }
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
          <span className="sr-only">Open menu</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(event) => event.stopPropagation()}
        >
          {actions.map(({ label, icon: Icon, disabled, run }) => (
            <DropdownMenuItem key={label} disabled={disabled} onClick={run}>
              <Icon /> {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Row>
  );
}

function RecordCell({ row }: CubbyCellContext<BackgroundJobTableRow, string>) {
  const value = row.original;
  if (value.rowType === "batch") {
    const expanded = row.getIsExpanded();
    return (
      <Row align="center" gap="xs" className="min-w-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse batch" : "Expand batch"}
          onClick={(event) => {
            event.stopPropagation();
            row.getToggleExpandedHandler()();
          }}
        >
          <ChevronRight
            className={
              expanded
                ? "rotate-90 transition-transform"
                : "transition-transform"
            }
          />
        </Button>
        <span className="truncate font-mono text-xs">
          {value.id.slice(0, 8)}
        </span>
      </Row>
    );
  }
  if (value.rowType === "status")
    return (
      <Row align="center" gap="xs" className="min-h-11 pl-6 md:min-h-7">
        {value.loadState === "loading" ? <Spinner size="sm" /> : null}
        <span
          className={
            value.loadState === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {value.name}
        </span>
        {value.retry ? (
          <Button
            variant="outline"
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              value.retry?.();
            }}
          >
            Retry
          </Button>
        ) : null}
      </Row>
    );
  return (
    <span className="block truncate pl-6 font-mono text-xs">
      {value.rowType === "job" ? value.id.slice(0, 8) : value.name}
    </span>
  );
}

function BackgroundJobsTable(props: BackgroundJobsTableProps) {
  const helper = useMemo(
    () => createCubbyColumnHelper<BackgroundJobTableRow>(),
    [],
  );
  const batchFilter = useCallback<CubbyFilterFn<BackgroundJobTableRow>>(
    (row, id, value) => {
      if (row.original.rowType !== "batch") return true;
      if (row.original.id === props.selectedBatchId) return true;
      const actual = String(row.getValue(id) ?? "").toLowerCase();
      return Array.isArray(value)
        ? value.includes(row.getValue(id))
        : actual.includes(String(value).toLowerCase());
    },
    [props.selectedBatchId],
  );
  const columns = createCubbyColumnCollection<BackgroundJobTableRow>((add) => {
    add(
      helper.accessor(
        (row) =>
          row.rowType === "batch" ? batchFilterText(row.batch) : undefined,
        {
          id: "search",
          header: "Search",
          filterFn: batchFilter,
          enableSorting: false,
          enableHiding: false,
          meta: {
            mobile: { slot: "hidden" },
            filterConfig: { placeholder: "Filter source, entity, or id" },
          },
        },
      ),
    );
    for (const [id, field, header, values] of SELECT_FILTERS) {
      add(
        helper.accessor(
          (row) => (row.rowType === "batch" ? row.batch[field] : undefined),
          {
            id,
            header,
            filterFn: batchFilter,
            enableSorting: false,
            enableHiding: false,
            meta: {
              mobile: { slot: "hidden" },
              filterConfig: {
                placeholder: `All ${header.toLowerCase()}s`,
                filterType: "select",
                options: values.map((value) => ({ label: value, value })),
              },
            },
          },
        ),
      );
    }
    add(
      helper.accessor("name", {
        id: "record",
        header: "Record",
        size: 180,
        enableCellSelection: false,
        meta: { mono: true, mobile: { slot: "title", priority: 0 } },
        cell: RecordCell,
      }),
    );
    add(
      helper.accessor("work", {
        ...COLUMN_DEFAULTS,
        header: "Work",
        size: 260,
        meta: { mobile: { slot: "subtitle", priority: 10 } },
        cell: ({ row, getValue }) =>
          row.original.rowType === "job" ? (
            <JobTarget row={row.original} />
          ) : (
            getValue()
          ),
      }),
    );
    add(
      helper.accessor("route", {
        ...COLUMN_DEFAULTS,
        header: "Route",
        size: 190,
        meta: { mobile: { slot: "meta", priority: 30 } },
        cell: ({ row, getValue }) =>
          row.original.rowType === "batch" ? (
            <Row gap="xs">
              <span>{row.original.batch.processor}</span>
              <span>·</span>
              <OriginLink batch={row.original.batch} />
            </Row>
          ) : (
            getValue()
          ),
      }),
    );
    add(
      helper.accessor("status", {
        ...COLUMN_DEFAULTS,
        header: "Status",
        size: 170,
        meta: { mobile: { slot: "trailing", priority: 10 } },
        cell: ({ row, getValue }) => {
          const status = getValue();
          return status ? (
            <Row gap="xs">
              <Badge variant={STATUS_TONE[status]}>{status}</Badge>
              <span className="font-mono text-2xs text-muted-foreground">
                {row.original.progress}
              </span>
            </Row>
          ) : null;
        },
      }),
    );
    add(
      helper.accessor("timing", {
        ...COLUMN_DEFAULTS,
        header: "Timing",
        size: 150,
        meta: { mono: true, mobile: { slot: "meta", priority: 40 } },
      }),
    );
    add(
      helper.accessor("createdAt", {
        ...COLUMN_DEFAULTS,
        header: "Created",
        size: 190,
        sortFn: (left, right, id) =>
          (left.getValue<Date | null>(id)?.getTime() ?? 0) -
          (right.getValue<Date | null>(id)?.getTime() ?? 0),
        meta: { mono: true, mobile: { slot: "meta", priority: 60 } },
        cell: ({ getValue }) => {
          const createdAt = getValue();
          return createdAt ? formatDate(createdAt) : null;
        },
      }),
    );
    add(
      helper.display({
        id: "actions",
        header: "",
        size: 96,
        minSize: 40,
        maxSize: 160,
        enableSorting: false,
        enableHiding: false,
        enableCellSelection: false,
        meta: { mobile: { slot: "actions", priority: 100 } },
        cell: ({ row }) => <RowActions row={row.original} {...props} />,
      }),
    );
  });
  const layout = useCubbyTableLayout({
    key: "background-jobs",
    columns,
    initialColumnVisibility: {
      search: false,
      batchKind: false,
      batchSource: false,
      batchProcessor: false,
      batchStatus: false,
      createdAt: false,
    },
  });
  const tableState = useTableState({
    initialSort: "createdAt",
    initialPagination: { pageIndex: 0, pageSize: 25 },
    readUrlState: false,
    urlSync: false,
  });
  const expanded = useMemo<ExpandedState>(
    () =>
      props.selectedBatchId ? { [`batch:${props.selectedBatchId}`]: true } : {},
    [props.selectedBatchId],
  );
  const onExpandedChange: OnChangeFn<ExpandedState> = (updater) => {
    const next = isExpandedUpdater(updater) ? updater(expanded) : updater;
    if (next === true) return;
    const current = props.selectedBatchId
      ? `batch:${props.selectedBatchId}`
      : undefined;
    const key = Object.keys(next).find(
      (candidate) => next[candidate] && candidate !== current,
    );
    props.onExpandedBatchChange(key?.slice("batch:".length));
  };
  const table = useCubbyTable({
    data: props.rows,
    columns: layout.columns,
    atoms: layout.atoms,
    getRowId: backgroundJobRowId,
    getSubRows: backgroundJobSubRows,
    getRowCanExpand: (row) => row.original.rowType === "batch",
    filterFromLeafRows: false,
    paginateExpandedRows: false,
    autoResetExpanded: false,
    enableRowSelection: false,
    enableCellSelection: false,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    onColumnFiltersChange: tableState.setColumnFilters,
    onExpandedChange,
    state: {
      pagination: tableState.pagination,
      sorting: tableState.sorting,
      columnFilters: tableState.columnFilters,
      expanded,
    },
    meta: { defaultLayout: layout.defaultLayout },
  });
  return (
    <div className="space-y-2">
      {props.error ? (
        <div className="space-y-2">
          <ErrorDisplay error={props.error} />
          <Button variant="outline" onClick={() => props.onRetry?.()}>
            Retry background jobs
          </Button>
        </div>
      ) : null}
      <RTable
        table={table}
        ariaLabel="Background jobs"
        isLoading={props.isLoading}
        // RTable's generic error contract is read-only. Keep this operational
        // list recoverable without changing the shared table primitive.
        error={undefined}
        emptyState={undefined}
        actions={props.actions}
        verticalAlign="top"
      />
    </div>
  );
}

export { BackgroundJobsTable };
