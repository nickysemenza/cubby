import type { AuditEntityType } from "@cubby/schemas/audit";
import {
  type BackgroundBatchStatus,
  type BackgroundJobStatus,
  backgroundJobPayloadSchema,
} from "@cubby/schemas/background-jobs";
import { Link } from "@tanstack/react-router";
import type { ExpandedState, OnChangeFn } from "@tanstack/react-table";
import {
  AlertTriangle,
  ChevronRight,
  ClipboardCopy,
  Eye,
  MoreHorizontal,
  RotateCcw,
  Square,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { DebugDialog } from "~/app/_components/data-table/DebugDialog";
import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { useTableState } from "~/app/_components/data-table/useTableState";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
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
import { isRecord, parseBackgroundEntityRef } from "./batch-metadata";
import { formatDate, formatMs } from "./format";

const BATCH_STATUS_TONE: Record<BackgroundBatchStatus, BadgeVariant> = {
  queued: "slate",
  running: "default",
  succeeded: "positive",
  partial: "warning",
  failed: "destructive",
  cancelled: "outline",
};
const JOB_STATUS_TONE: Record<BackgroundJobStatus, BadgeVariant> = {
  pending: "slate",
  queued: "slate",
  running: "default",
  succeeded: "positive",
  skipped: "outline",
  failed: "destructive",
  cancelled: "outline",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function EntityTarget({
  entityType,
  entityId,
}: {
  entityType: AuditEntityType;
  entityId: string;
}) {
  if (UUID_PATTERN.test(entityId)) {
    return (
      <span className="text-muted-foreground">
        {entityType} · {entityId.slice(0, 8)}
      </span>
    );
  }
  return (
    <EntityInlineLinkById entityType={entityType} entityId={entityId} compact />
  );
}

function OriginLink({ batch }: { batch: BackgroundBatchRow["batch"] }) {
  const metadata = isRecord(batch.metadata) ? batch.metadata : null;
  const source = typeof metadata?.source === "string" ? metadata.source : null;
  const entity = parseBackgroundEntityRef(metadata?.entity);
  if (entity) {
    return (
      <EntityInlineLinkById
        entityType={entity.entityType}
        entityId={entity.entityId}
        compact
      />
    );
  }
  if (source) return source;
  if (
    batch.source === "backfill" &&
    batch.kind === "entity-embedding.refresh"
  ) {
    return (
      <Link
        to="/search/debug"
        className="underline decoration-dotted underline-offset-2"
      >
        Search debug
      </Link>
    );
  }
  return <span className="text-muted-foreground">{batch.source}</span>;
}

function JobTarget({ row }: { row: BackgroundJobRow }) {
  const parsed = backgroundJobPayloadSchema.safeParse({
    kind: row.job.kind,
    payload: row.job.payload,
  });
  if (!parsed.success)
    return <span className="text-destructive">Invalid payload</span>;
  const value = parsed.data;
  switch (value.kind) {
    case "entity-embedding.refresh":
      return (
        <EntityTarget
          entityType={value.payload.entityType}
          entityId={value.payload.entityId}
        />
      );
    case "location-ai.description.refresh":
    case "location-ai.inventory.refresh":
      return (
        <EntityTarget
          entityType="location"
          entityId={value.payload.locationId}
        />
      );
    case "usda-match.retry":
      return (
        <EntityTarget
          entityType="ingredient"
          entityId={value.payload.ingredientId}
        />
      );
    case "recipe-totals.recompute": {
      const [recipeId] = value.payload.recipeIds;
      return recipeId && value.payload.recipeIds.length === 1 ? (
        <EntityTarget entityType="recipe" entityId={recipeId} />
      ) : (
        `${value.payload.recipeIds.length} recipes`
      );
    }
    case "entity-embedding.backfill.coordinator":
      return "Continue semantic backfill";
    case "search-document.repair.coordinator":
      return "Continue document repair";
    case "location-valuation.recompute":
      return "All locations";
    case "problems.counts.refresh":
      return "Problem counts";
  }
}

async function copyJson(value: unknown, label: string) {
  if (!(await copyText(JSON.stringify(value, null, 2)))) {
    toast.error("Copy failed");
    return;
  }
  toast.success(`Copied ${label}`);
}

function RowActions({
  row,
  selectedBatchId,
  showFailedOnly,
  onFailedOnlyChange,
  onRetryBatch,
  onCancelBatch,
  onRetryJob,
  onPageChange,
}: {
  row: BackgroundJobTableRow;
  selectedBatchId?: string;
  showFailedOnly: boolean;
  onFailedOnlyChange: (batchId: string, failedOnly: boolean) => void;
  onRetryBatch: (batchId: string) => void;
  onCancelBatch: (batchId: string) => void;
  onRetryJob: (jobId: string) => void;
  onPageChange: (pageIndex: number) => void;
}) {
  if (row.rowType === "pager") {
    const last = Math.min((row.pageIndex + 1) * row.pageSize, row.totalCount);
    return (
      <Row gap="xs">
        <Button
          variant="outline"
          size="xs"
          disabled={row.pageIndex === 0}
          onClick={() => onPageChange(row.pageIndex - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={last >= row.totalCount}
          onClick={() => onPageChange(row.pageIndex + 1)}
        >
          Next
        </Button>
      </Row>
    );
  }
  if (row.rowType !== "batch" && row.rowType !== "job") return null;
  const debugValue = row.rowType === "batch" ? row.batch : row.job;
  return (
    <Row gap="tight">
      <DebugDialog
        data={debugValue}
        title={row.rowType === "batch" ? "Batch details" : "Job details"}
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
          <DropdownMenuItem
            onClick={() =>
              void copyJson(
                row.rowType === "batch" ? row.batch.metadata : row.job.payload,
                row.rowType === "batch" ? "batch metadata" : "job payload",
              )
            }
          >
            <ClipboardCopy /> Copy{" "}
            {row.rowType === "batch" ? "metadata" : "payload"}
          </DropdownMenuItem>
          {row.rowType === "batch" ? (
            <>
              <DropdownMenuItem
                onClick={() =>
                  onFailedOnlyChange(
                    row.id,
                    row.id === selectedBatchId ? !showFailedOnly : true,
                  )
                }
              >
                <AlertTriangle />
                {row.id === selectedBatchId && showFailedOnly
                  ? "Show all jobs"
                  : "Show failed jobs"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={row.batch.failedJobs === 0}
                onClick={() => onRetryBatch(row.id)}
              >
                <RotateCcw /> Retry failed
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={row.batch.queuedJobs === 0}
                onClick={() => onCancelBatch(row.id)}
              >
                <Square /> Cancel queued
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {row.job.lastError ? (
                <DropdownMenuItem
                  onClick={() => void copyJson(row.job.lastError, "job error")}
                >
                  <ClipboardCopy /> Copy error
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={row.job.status !== "failed"}
                onClick={() => onRetryJob(row.id)}
              >
                <RotateCcw /> Retry job
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </Row>
  );
}

interface BackgroundJobsTableProps {
  rows: BackgroundJobTableRow[];
  selectedBatchId?: string;
  showFailedOnly: boolean;
  isLoading: boolean;
  error: unknown;
  toolbar: ReactNode;
  actions: ReactNode;
  emptyState: ReactNode;
  onExpandedBatchChange: (batchId?: string) => void;
  onFailedOnlyChange: (batchId: string, failedOnly: boolean) => void;
  onRetryBatch: (batchId: string) => void;
  onCancelBatch: (batchId: string) => void;
  onRetryJob: (jobId: string) => void;
  onPageChange: (pageIndex: number) => void;
}

function BackgroundJobsTable(props: BackgroundJobsTableProps) {
  const {
    rows,
    selectedBatchId,
    showFailedOnly,
    isLoading,
    error,
    toolbar,
    actions,
    emptyState,
    onExpandedBatchChange,
    onFailedOnlyChange,
    onRetryBatch,
    onCancelBatch,
    onRetryJob,
    onPageChange,
  } = props;
  const helper = useMemo(
    () => createCubbyColumnHelper<BackgroundJobTableRow>(),
    [],
  );
  const columns = useMemo(
    () => [
      helper.accessor((row) => row.name, {
        id: "record",
        header: "Record",
        size: 180,
        enableCellSelection: false,
        meta: { mono: true, mobile: { slot: "title", priority: 0 } },
        cell: (info) => {
          const row = info.row.original;
          if (row.rowType === "batch") {
            const expanded = info.row.getIsExpanded();
            return (
              <Row align="center" gap="xs" className="min-w-0">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-expanded={expanded}
                  aria-label={expanded ? "Collapse batch" : "Expand batch"}
                  onClick={(event) => {
                    event.stopPropagation();
                    info.row.getToggleExpandedHandler()();
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
                  {row.id.slice(0, 8)}
                </span>
                {row.selectedOutsideList ? (
                  <Badge variant="outline">Selected</Badge>
                ) : null}
              </Row>
            );
          }
          if (row.rowType === "status") {
            return (
              <Row align="center" gap="xs" className="pl-7">
                {row.status === "loading" ? <Spinner size="sm" /> : null}
                <span
                  className={
                    row.status === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {row.message}
                </span>
              </Row>
            );
          }
          return (
            <span className="block truncate pl-7 font-mono text-xs">
              {row.rowType === "job" ? row.id.slice(0, 8) : row.name}
            </span>
          );
        },
      }),
      helper.accessor(
        (row) =>
          row.rowType === "batch"
            ? row.batch.kind
            : row.rowType === "job"
              ? row.job.kind
              : undefined,
        {
          id: "work",
          header: "Work",
          size: 260,
          sortUndefined: "last",
          enableCellSelection: false,
          meta: { mobile: { slot: "subtitle", priority: 10 } },
          cell: (info) => {
            const row = info.row.original;
            return row.rowType === "batch" ? (
              row.batch.kind
            ) : row.rowType === "job" ? (
              <JobTarget row={row} />
            ) : null;
          },
        },
      ),
      helper.accessor(
        (row) =>
          row.rowType === "batch"
            ? `${row.batch.processor} ${row.batch.source}`
            : row.rowType === "job"
              ? row.job.dedupeKey
              : undefined,
        {
          id: "route",
          header: "Route",
          size: 190,
          sortUndefined: "last",
          enableCellSelection: false,
          meta: { mobile: { slot: "meta", priority: 30 } },
          cell: (info) => {
            const row = info.row.original;
            return row.rowType === "batch" ? (
              <Row gap="xs">
                <span>{row.batch.processor}</span>
                <span>·</span>
                <OriginLink batch={row.batch} />
              </Row>
            ) : row.rowType === "job" ? (
              row.job.dedupeKey
            ) : null;
          },
        },
      ),
      helper.accessor(
        (row) =>
          row.rowType === "batch"
            ? row.batch.status
            : row.rowType === "job"
              ? row.job.status
              : undefined,
        {
          id: "status",
          header: "Status",
          size: 170,
          sortUndefined: "last",
          enableCellSelection: false,
          meta: { mobile: { slot: "trailing", priority: 10 } },
          cell: (info) => {
            const row = info.row.original;
            return row.rowType === "batch" ? (
              <Row gap="xs">
                <Badge variant={BATCH_STATUS_TONE[row.batch.status]}>
                  {row.batch.status}
                </Badge>
                <span className="font-mono text-2xs text-muted-foreground">
                  {row.batch.succeededJobs + row.batch.skippedJobs}/
                  {row.batch.totalJobs}
                  {row.batch.failedJobs
                    ? ` · ${row.batch.failedJobs} failed`
                    : ""}
                </span>
              </Row>
            ) : row.rowType === "job" ? (
              <Row gap="xs">
                <Badge variant={JOB_STATUS_TONE[row.job.status]}>
                  {row.job.status}
                </Badge>
                <span className="font-mono text-2xs text-muted-foreground">
                  {row.job.attempts}/{row.job.maxAttempts}
                </span>
              </Row>
            ) : null;
          },
        },
      ),
      helper.accessor(
        (row) =>
          row.rowType === "batch"
            ? row.batch.wallDurationMs
            : row.rowType === "job"
              ? row.job.durationMs
              : undefined,
        {
          id: "timing",
          header: "Timing",
          size: 150,
          sortUndefined: "last",
          enableCellSelection: false,
          meta: { mono: true, mobile: { slot: "meta", priority: 40 } },
          cell: (info) => {
            const row = info.row.original;
            if (row.rowType === "batch")
              return `${formatMs(row.batch.wallDurationMs) || "—"} · ${formatMs(row.batch.activeDurationMs)} active`;
            if (row.rowType !== "job") return null;
            const wait =
              row.job.queuedAt && row.job.startedAt
                ? formatMs(
                    Math.max(
                      0,
                      row.job.startedAt.getTime() - row.job.queuedAt.getTime(),
                    ),
                  )
                : "";
            return `${formatMs(row.job.durationMs) || "—"}${wait ? ` · ${wait} wait` : ""}`;
          },
        },
      ),
      helper.accessor(
        (row) =>
          row.rowType === "batch"
            ? row.batch.createdAt
            : row.rowType === "job"
              ? row.job.createdAt
              : undefined,
        {
          id: "createdAt",
          header: "Created",
          size: 190,
          sortFn: (left, right, columnId) =>
            String(left.getValue(columnId) ?? "").localeCompare(
              String(right.getValue(columnId) ?? ""),
            ),
          sortUndefined: "last",
          enableCellSelection: false,
          meta: { mono: true, mobile: { slot: "meta", priority: 60 } },
          cell: (info) =>
            info.getValue() ? formatDate(info.getValue()!) : null,
        },
      ),
      helper.accessor(
        (row) => (row.rowType === "job" ? row.job.lastError : undefined),
        {
          id: "error",
          header: "Error",
          size: 260,
          sortUndefined: "last",
          enableCellSelection: false,
          meta: { mobile: { slot: "meta", priority: 70 } },
          cell: (info) =>
            info.getValue() ? (
              <span
                className="block truncate text-destructive"
                title={info.getValue()!}
              >
                {info.getValue()}
              </span>
            ) : null,
        },
      ),
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
        cell: (info) => (
          <RowActions
            row={info.row.original}
            selectedBatchId={selectedBatchId}
            showFailedOnly={showFailedOnly}
            onFailedOnlyChange={onFailedOnlyChange}
            onRetryBatch={onRetryBatch}
            onCancelBatch={onCancelBatch}
            onRetryJob={onRetryJob}
            onPageChange={onPageChange}
          />
        ),
      }),
    ],
    [
      helper,
      onCancelBatch,
      onFailedOnlyChange,
      onPageChange,
      onRetryBatch,
      onRetryJob,
      selectedBatchId,
      showFailedOnly,
    ],
  );
  const layout = useCubbyTableLayout({
    key: "background-jobs",
    columns,
    initialColumnVisibility: { createdAt: false },
  });
  const tableState = useTableState({
    initialSort: "createdAt",
    initialPagination: { pageIndex: 0, pageSize: 25 },
    readUrlState: false,
    urlSync: false,
  });
  const expanded = useMemo<ExpandedState>(
    () => (selectedBatchId ? { [`batch:${selectedBatchId}`]: true } : {}),
    [selectedBatchId],
  );
  const onExpandedChange: OnChangeFn<ExpandedState> = (updater) => {
    const next =
      typeof updater === "function"
        ? (updater as (value: ExpandedState) => ExpandedState)(expanded)
        : updater;
    const nextRows =
      next === true
        ? Object.fromEntries(
            rows
              .filter((row) => row.rowType === "batch")
              .map((row) => [row.rowKey, true]),
          )
        : next;
    const currentKey = selectedBatchId ? `batch:${selectedBatchId}` : undefined;
    const replacement = Object.keys(nextRows).find(
      (key) => nextRows[key] && key !== currentKey && key.startsWith("batch:"),
    );
    if (replacement)
      return onExpandedBatchChange(replacement.slice("batch:".length));
    if (!currentKey || !nextRows[currentKey]) onExpandedBatchChange(undefined);
  };
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    getRowId: backgroundJobRowId,
    getSubRows: backgroundJobSubRows,
    getRowCanExpand: (row) => row.original.rowType === "batch",
    paginateExpandedRows: false,
    autoResetExpanded: false,
    enableRowSelection: false,
    enableCellSelection: false,
    rowCount: rows.length,
    manualPagination: false,
    manualSorting: false,
    manualFiltering: false,
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
    <RTable
      table={table}
      ariaLabel="Background jobs"
      isLoading={isLoading}
      error={error}
      additionalToolbarContent={toolbar}
      actions={actions}
      emptyState={emptyState}
      verticalAlign="top"
    />
  );
}

export { BackgroundJobsTable };
