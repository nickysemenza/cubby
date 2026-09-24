/**
 * `/projects/tools` — the projects x tools grid.
 *
 * Its job is backfill throughput, not analysis: `ProjectToolUsage` only becomes
 * useful once tools carry several edges, and attaching one project at a time
 * through a dialog is what kept the ledger ~96% empty. Here you scan for holes.
 *
 * Cells render more states than the server emits: `attached` is recorded
 * history, `empty` is the absence of a cell, and the server's single
 * `suggested` splits by lane into `purchased` and `trade` because those carry
 * very different confidence. Ghosts exist so the common motion is confirming
 * rather than authoring — a blank checkbox grid invites completionism, and a
 * hammer marked on forty projects makes cost-per-use meaningless.
 *
 * Every membership decision (which rows, which columns, group order, cell
 * state) is made by `project.toolMatrix` — with ONE exception, the ownership
 * gate. `toolTimelineConflict` runs here over `row.ownership` and the column's
 * window because a dense per-cell conflict state would be thousands of objects
 * (for a pre-2023 column, 80-99% of the tool shelf did not exist yet). It is
 * the same pure predicate the suggestion engine filters with and the write path
 * rejects with, so this is re-running a shared function, not re-deciding
 * membership — and a cell that slips through is still refused by the server.
 */
import type { ProjectKind, ProjectStatus } from "@cubby/schemas/project";
import {
  isLiveProjectStatus,
  type ProjectToolMatrixCellOut,
  type ProjectToolMatrixOut,
  projectKindValues,
  projectStatusValues,
} from "@cubby/schemas/project";
import { CaretLeftIcon as ChevronLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { ProhibitIcon as Slash } from "@phosphor-icons/react/dist/csr/Prohibit";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { match } from "ts-pattern";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { EntityPreviewLink } from "~/app/_components/EntityPreviewLink";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "~/app/_components/products/product-image-summaries";
import { ProjectMark } from "~/app/projects/project-mark";
import type { ToolMatrixSearch } from "~/app/tools/tool-search";
import { Row, Stack } from "~/components/layout";
import {
  cellMonoDense,
  stickyRowHeaderPage,
} from "~/components/matrix/matrix-chrome";
import { Badge } from "~/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { toolTimelineConflict } from "~/lib/tool-timeline";
import { cn, formatCurrency } from "~/lib/utils";

import { PROJECT_STATUS_LABELS } from "./project-formatting";
import { project } from "./project.functions";

/**
 * How long a cell waits before it commits. A click-and-revert inside this
 * window never reaches the server, which is the only honest way to stop
 * click-then-click-back writing two audit entries — the endpoint itself must
 * report both, because both really happened.
 */
const CELL_SETTLE_MS = 400;

const COST_FLOORS = [0, 100, 250, 500] as const;

const KIND_LABELS = {
  furniture: "Furniture",
  workshop: "Workshop",
  household: "Household",
  renovation: "Renovation",
  garden: "Garden",
  trip: "Trip",
} satisfies Record<ProjectKind, string>;

const MATRIX_PAGE_SIZE = 16;
const PROJECT_COLUMN_WIDTH = 44;
const EMPTY_TOOL_PRODUCT_IDS: readonly string[] = [];

const cellKey = (projectId: string, productId: string) =>
  `${projectId}:${productId}`;

/** Sticky row-header column; the header corner has to outrank it. */
const STICKY = stickyRowHeaderPage;
const NUMERIC = cellMonoDense;
const STICKY_USES = "sticky right-40 z-20 bg-background";
const STICKY_NET = "sticky right-20 z-20 bg-background";
const STICKY_COST_PER_USE = "sticky right-0 z-20 bg-background";

function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Row align="center" gap="sm">
      <span className="eyebrow">{label}</span>
      <Row className="overflow-hidden rounded border border-[var(--border)]">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={cn(
              "border-l border-[var(--border)] px-2 py-1 font-mono text-2xs first:border-l-0",
              option.value === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {option.label}
          </button>
        ))}
      </Row>
    </Row>
  );
}

function MultiFilter<T extends string>({
  label,
  options,
  selected,
  formatLabel,
  onChange,
}: {
  label: string;
  options: readonly T[];
  selected: readonly T[];
  formatLabel: (value: T) => string;
  onChange: (value: T[] | undefined) => void;
}) {
  const selectedSet = new Set(selected);
  const toggle = (value: T) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next.size > 0 ? [...next] : undefined);
  };

  return (
    <Row align="center" gap="sm">
      <span className="eyebrow">{label}</span>
      <Row gap="xs" wrap>
        <button
          type="button"
          aria-pressed={selected.length === 0}
          onClick={() => onChange(undefined)}
          className={cn(
            "rounded border border-[var(--border)] px-2 py-1 font-mono text-2xs",
            selected.length === 0
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          All
        </button>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={selectedSet.has(option)}
            onClick={() => toggle(option)}
            className={cn(
              "rounded border border-[var(--border)] px-2 py-1 font-mono text-2xs",
              selectedSet.has(option)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {formatLabel(option)}
          </button>
        ))}
      </Row>
    </Row>
  );
}

/**
 * `suggested` is split by lane rather than rendered once, because the two mean
 * different things to whoever is scanning the grid — see the class list below.
 *
 * `conflict` is the ownership gate: we did not own the tool while the project
 * ran, so the cell is inert. `evidence` is its opposite — a purchase charged to
 * this project that is under the suggestion floor, which is exactly the proof
 * that keeps a cell clickable when its neighbours are locked.
 */
type CellState =
  | "attached"
  | "purchased"
  | "trade"
  | "evidence"
  | "conflict"
  | "empty";

function MatrixCell({
  state,
  purchaseCost,
  title,
  conflictReason,
  striped,
  onToggle,
}: {
  state: CellState;
  purchaseCost: number;
  title: string;
  /** Set on `conflict`, and on an ATTACHED cell that predates its own tool. */
  conflictReason: string | null;
  striped: boolean;
  onToggle: () => void;
}) {
  const hint = match(state)
    .with("attached", () =>
      conflictReason
        ? `${title} · recorded, but ${conflictReason}`
        : purchaseCost > 0
          ? `${title} · ${formatCurrency(purchaseCost, 0)} bought here`
          : title,
    )
    .with(
      "purchased",
      () =>
        `${title} · suggested, ${formatCurrency(purchaseCost, 0)} bought here`,
    )
    .with("trade", () => `${title} · suggested by trade`)
    .with(
      "evidence",
      () => `${title} · ${formatCurrency(purchaseCost, 0)} bought here`,
    )
    .with("conflict", () => `${title} · ${conflictReason ?? "not owned then"}`)
    .with("empty", () => title)
    .exhaustive();

  const locked = state === "conflict";
  const flagged = state === "attached" && conflictReason !== null;

  return (
    <td
      className={cn(
        "border-b border-l border-[var(--border)] p-0 group-hover/row:bg-muted",
        striped && "bg-muted/20",
      )}
    >
      <button
        type="button"
        title={hint}
        aria-label={hint}
        aria-pressed={state === "attached"}
        aria-disabled={locked}
        disabled={locked}
        onClick={onToggle}
        className={cn(
          "flex h-6 w-full items-center justify-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
          locked
            ? "cursor-not-allowed bg-muted/50"
            : "hover:ring-1 hover:ring-primary/40 hover:ring-inset",
        )}
      >
        <span
          className={cn(
            "flex size-3.5 items-center justify-center rounded-[3px]",
            state === "attached" && "bg-primary text-primary-foreground",
            // The two suggestion lanes carry very different confidence, so they
            // get different weights rather than one shared ghost. `bought here`
            // is a ledger fact — the tool's own purchase is charged to this
            // project — so it keeps the accent and the check, one step from
            // confirmed. A trade match is an inference from "this project does
            // this kind of work", so it drops to a dotted neutral outline with
            // no check: visible when you scan a column, never mistaken for a
            // record. Keeps ultramarine meaning "this is real".
            state === "purchased" &&
              "border border-dashed border-primary text-primary",
            state === "trade" && "border border-dotted border-muted-foreground",
            // A locked cell says "not possible", not "not yet" — so it reads as
            // struck-through rather than as one more empty box to fill in.
            locked && "text-muted-foreground/60",
            // An attached edge that conflicts stays fully editable: it is the
            // only way to correct one. It just stops looking clean.
            flagged && "bg-warning/20 text-warning-ink ring-1 ring-warning",
          )}
        >
          {(state === "attached" || state === "purchased") && (
            <Check className="size-3" aria-hidden />
          )}
          {locked && <Slash className="size-3" aria-hidden />}
        </span>
      </button>
    </td>
  );
}

export function ToolMatrixPage({
  search,
  onSearchChange,
}: {
  search: ToolMatrixSearch;
  onSearchChange: (next: Partial<ToolMatrixSearch>) => void;
}) {
  const queryClient = useQueryClient();
  const [projectDraft, setProjectDraft] = useState(search.project ?? "");
  const [toolDraft, setToolDraft] = useState(search.tool ?? "");

  useEffect(() => {
    setProjectDraft(search.project ?? "");
  }, [search.project]);

  useEffect(() => {
    setToolDraft(search.tool ?? "");
  }, [search.tool]);

  const input = useMemo(
    () => ({
      statusScope: search.statuses,
      kinds: search.kinds,
      completionYear: search.completed,
      search: search.project,
      toolSearch: search.tool,
      minNetLifetimeCost: search.floor ?? 100,
      groupBy: search.group ?? ("trade" as const),
      maxColumns: MATRIX_PAGE_SIZE,
      columnPage: search.page ?? 1,
    }),
    [
      search.statuses,
      search.kinds,
      search.completed,
      search.project,
      search.tool,
      search.floor,
      search.group,
      search.page,
    ],
  );

  const { data, isLoading } = useQuery(project.toolMatrix.queryOptions(input));
  const productIds = useMemo(
    () => data?.rows.map((row) => row.productId) ?? EMPTY_TOOL_PRODUCT_IDS,
    [data?.rows],
  );

  // A hand-edited or stale URL can point past the last page after filtering.
  // The server clamps authoritatively; mirror that answer back into the URL.
  useEffect(() => {
    const resolvedPage = data?.columnPagination.page;
    const requestedPage = search.page ?? 1;
    if (resolvedPage === undefined || resolvedPage === requestedPage) return;
    onSearchChange({ page: resolvedPage === 1 ? undefined : resolvedPage });
  }, [data?.columnPagination.page, onSearchChange, search.page]);

  // Optimistic overlay. Keyed by cell so two cells can be in flight at once,
  // and so a revert inside the settle window just deletes the entry.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const setUsage = useMutation(project.setToolUsage.mutationOptions());

  const toggleCell = useCallback(
    (projectId: string, productId: string, nextUsed: boolean) => {
      const key = cellKey(projectId, productId);
      setPending((prev) => new Map(prev).set(key, nextUsed));

      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setUsage.mutate(
            { projectId, productId, used: nextUsed },
            {
              onSettled: () => {
                setPending((prev) => {
                  const next = new Map(prev);
                  next.delete(key);
                  return next;
                });
                // Whole-matrix refetch, not a row patch: attaching one tool
                // removes it from that column's suggestion pool and moves its
                // lifetime use count, which re-ranks trade matches in every
                // other column too. Only `project.*` — nothing on this page
                // reads a product query.
                void invalidateOperationTags(queryClient, ripple.projectOnly);
              },
            },
          );
        }, CELL_SETTLE_MS),
      );
    },
    [queryClient, setUsage],
  );

  const cellIndex = useMemo(() => {
    const index = new Map<string, ProjectToolMatrixCellOut>();
    for (const cell of data?.cells ?? []) {
      index.set(cellKey(cell.projectId, cell.productId), cell);
    }
    return index;
  }, [data?.cells]);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return null;

  const statusFilter = search.statuses ?? [];
  const kindFilter = search.kinds ?? [];
  const { page, pageSize, pageCount } = data.columnPagination;
  const firstProject =
    data.totals.matchingProjects === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastProject = Math.min(page * pageSize, data.totals.matchingProjects);

  return (
    <Stack gap="md">
      <div className="rounded border border-[var(--border)] bg-card">
        <Row
          align="center"
          gap="lg"
          wrap
          className="border-b border-[var(--border)] px-2 py-2"
        >
          <Row align="center" gap="sm">
            <span className="eyebrow">Projects</span>
            <Search className="size-3.5 text-muted-foreground" aria-hidden />
            <Input
              value={projectDraft}
              aria-label="Filter projects"
              placeholder="Filter projects"
              className="h-7 w-40"
              onChange={(event) => setProjectDraft(event.target.value)}
              onBlur={() =>
                onSearchChange({
                  project: projectDraft.trim() || undefined,
                  page: undefined,
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSearchChange({
                    project: projectDraft.trim() || undefined,
                    page: undefined,
                  });
                }
              }}
            />
          </Row>
          <MultiFilter
            label="Status"
            options={projectStatusValues}
            selected={statusFilter}
            formatLabel={(status: ProjectStatus) =>
              PROJECT_STATUS_LABELS[status]
            }
            onChange={(statuses) =>
              onSearchChange({ statuses, page: undefined })
            }
          />
          <MultiFilter
            label="Kind"
            options={projectKindValues}
            selected={kindFilter}
            formatLabel={(kind: ProjectKind) => KIND_LABELS[kind]}
            onChange={(kinds) => onSearchChange({ kinds, page: undefined })}
          />
          <Row align="center" gap="sm">
            <span className="eyebrow">Completed</span>
            <NativeSelect
              aria-label="Filter projects by completion year"
              value={search.completed ?? ""}
              onChange={(event) =>
                onSearchChange({
                  completed: event.target.value || undefined,
                  page: undefined,
                })
              }
              className="font-mono text-2xs"
            >
              <option value="">All</option>
              {data.filterOptions.completionYears.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </NativeSelect>
          </Row>
          <Row align="center" gap="xs" className="ml-auto">
            <button
              type="button"
              aria-label="Previous project page"
              title="Previous project page"
              disabled={page <= 1}
              onClick={() => onSearchChange({ page: page - 1 })}
              className="flex size-7 items-center justify-center rounded border border-[var(--border)] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            <span
              className="font-mono text-2xs whitespace-nowrap text-slate"
              title="Pages prioritize projects with tool activity, then recent projects; each page reads chronologically."
            >
              {firstProject}–{lastProject} of {data.totals.matchingProjects} ·
              page {page}/{Math.max(pageCount, 1)}
            </span>
            <button
              type="button"
              aria-label="Next project page"
              title="Next project page"
              disabled={pageCount === 0 || page >= pageCount}
              onClick={() => onSearchChange({ page: page + 1 })}
              className="flex size-7 items-center justify-center rounded border border-[var(--border)] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </Row>
        </Row>
        <Row
          align="center"
          gap="lg"
          wrap
          className="border-b border-[var(--border)] px-2 py-2"
        >
          <SegmentedControl
            label="Group"
            value={search.group ?? "trade"}
            onChange={(group) => onSearchChange({ group })}
            options={[
              { value: "trade" as const, label: "Trade" },
              { value: "manufacturer" as const, label: "Manufacturer" },
            ]}
          />
          <SegmentedControl
            label="Min net cost"
            value={search.floor ?? 100}
            onChange={(floor) => onSearchChange({ floor })}
            options={COST_FLOORS.map((floor) => ({
              value: floor,
              label: floor === 0 ? "All" : `$${floor}`,
            }))}
          />
          <Row align="center" gap="sm" className="ml-auto">
            <span className="eyebrow">Tools</span>
            <Search className="size-3.5 text-muted-foreground" aria-hidden />
            <Input
              value={toolDraft}
              aria-label="Filter tools"
              placeholder="Filter tools"
              className="h-7 w-44"
              onChange={(event) => setToolDraft(event.target.value)}
              onBlur={() =>
                onSearchChange({ tool: toolDraft.trim() || undefined })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSearchChange({ tool: toolDraft.trim() || undefined });
                }
              }}
            />
          </Row>
        </Row>

        {data.rows.length === 0 || data.columns.length === 0 ? (
          <Empty variant="minimal">
            <EmptyHeader>
              <Wrench className="size-5" aria-hidden />
              <EmptyTitle>Nothing to plot</EmptyTitle>
            </EmptyHeader>
            <EmptyDescription>
              {data.rows.length === 0
                ? "No tools clear this cost floor. Lower it to include cheaper tools."
                : "No projects match this scope. Clear the project filters to widen it."}
            </EmptyDescription>
          </Empty>
        ) : (
          <ProductImageSummariesProvider productIds={productIds}>
            <div className="overflow-visible">
              <MatrixTable
                data={data}
                cellIndex={cellIndex}
                pending={pending}
                onToggle={toggleCell}
              />
            </div>
          </ProductImageSummariesProvider>
        )}
        <Row
          align="center"
          gap="lg"
          wrap
          className="border-t border-[var(--border)] px-2 py-2 text-2xs text-muted-foreground"
        >
          <Row align="center" gap="sm">
            <span className="size-3 rounded-[3px] bg-primary" aria-hidden />
            Attached
          </Row>
          <Row align="center" gap="sm">
            <span
              className="size-3 rounded-[3px] border border-dashed border-primary"
              aria-hidden
            />
            Bought here
          </Row>
          <Row align="center" gap="sm">
            <span
              className="size-3 rounded-[3px] border border-dotted border-muted-foreground"
              aria-hidden
            />
            Trade match
          </Row>
          <Row align="center" gap="sm">
            <span
              className="flex size-3 items-center justify-center rounded-[3px] bg-muted/50 text-muted-foreground"
              aria-hidden
            >
              <Slash className="size-3" />
            </span>
            Not owned then
          </Row>
          <span className="ml-auto font-mono text-slate">
            {data.columns.length} of {data.totals.matchingProjects} projects ·{" "}
            {data.rows.length} of {data.totals.matchingTools} tools
            {data.totals.timelineConflictCells > 0 &&
              ` · ${data.totals.timelineConflictCells} locked`}
            {data.truncated.rows && " · row cap reached"}
          </span>
        </Row>
      </div>
    </Stack>
  );
}

function ToolIdentityLink({
  row,
}: {
  row: ProjectToolMatrixOut["rows"][number];
}) {
  const images = useHydratedProductImages(row.productId);

  return (
    <EntityInlineLink
      displayImage={images[0] ?? null}
      entity="product"
      data={{
        id: row.productId,
        name: row.productName,
      }}
      truncate
    />
  );
}

function MatrixTable({
  data,
  cellIndex,
  pending,
  onToggle,
}: {
  data: ProjectToolMatrixOut;
  cellIndex: Map<string, ProjectToolMatrixCellOut>;
  pending: Map<string, boolean>;
  onToggle: (projectId: string, productId: string, used: boolean) => void;
}) {
  const rowsByGroup = useMemo(() => {
    const grouped = new Map<string, ProjectToolMatrixOut["rows"]>();
    for (const row of data.rows) {
      const bucket = grouped.get(row.groupKey) ?? [];
      bucket.push(row);
      grouped.set(row.groupKey, bucket);
    }
    return grouped;
  }, [data.rows]);

  // One pass over the grid rather than a predicate call per render per cell.
  // Only conflicting pairs are stored, so this stays sparse for the columns
  // that matter (a current project conflicts with nothing).
  const conflictIndex = useMemo(() => {
    const today = format(new Date(), "yyyy-MM-dd");
    const index = new Map<string, string>();
    for (const column of data.columns) {
      const isLive = isLiveProjectStatus(column.status);
      for (const row of data.rows) {
        const conflict = toolTimelineConflict(
          row.ownership,
          {
            effectiveStart: column.startDate,
            effectiveEnd: column.endDate,
            startSource: column.startSource,
            endSource: column.endSource,
          },
          { isLive, today },
        );
        if (!conflict) continue;
        index.set(
          cellKey(column.projectId, row.productId),
          conflict.kind === "acquired_after_end"
            ? `acquired ${conflict.date}, after this project ended ${conflict.boundary}`
            : `disposed of ${conflict.date}, before this project started ${conflict.boundary}`,
        );
      }
    }
    return index;
  }, [data.columns, data.rows]);

  const columnSpan = data.columns.length + 4;
  const tableWidth =
    256 + data.columns.length * PROJECT_COLUMN_WIDTH + 56 + 80 + 80;

  return (
    <table
      className="table-fixed border-collapse text-left"
      style={{ width: tableWidth }}
    >
      <thead className="sticky top-[51px] z-30 bg-card">
        <tr className="border-b border-[var(--foreground)]">
          <th
            aria-label="Tool"
            className={cn(
              STICKY,
              "z-40 w-64 max-w-64 min-w-64 bg-card px-2 pb-1 align-bottom",
            )}
          >
            <div className="w-64">
              <span className="eyebrow">Tool</span>
            </div>
          </th>
          {data.columns.map((column, columnIndex) => (
            <th
              key={column.projectId}
              aria-label={column.projectName}
              title={`${column.projectName} · ${column.attachedCount} attached, ${column.suggestedCount} suggested`}
              className={cn(
                "relative h-28 w-11 min-w-11 overflow-visible border-l border-[var(--border)] bg-card align-bottom",
                columnIndex % 2 === 1 && "bg-muted/20",
              )}
            >
              <div className="relative h-24 w-11 overflow-visible">
                <EntityPreviewLink
                  displayImage={null}
                  entity="project"
                  id={column.projectId}
                  showIdentityMark={false}
                  className="absolute bottom-2 left-1 z-10 flex w-24 origin-bottom-left rotate-[-60deg] items-center gap-1 truncate text-2xs leading-none text-foreground underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid"
                >
                  <ProjectMark icon={column.icon} size={12} />
                  <span className="truncate">{column.projectName}</span>
                </EntityPreviewLink>
              </div>
              <div className="pb-1 text-center text-2xs text-slate">
                {column.startDate ? `’${column.startDate.slice(2, 4)}` : "—"}
              </div>
            </th>
          ))}
          <th
            className={cn(
              NUMERIC,
              STICKY_USES,
              "w-14 border-l border-[var(--border)] bg-card align-bottom",
            )}
          >
            <span className="eyebrow">Uses</span>
          </th>
          <th className={cn(NUMERIC, STICKY_NET, "w-20 bg-card align-bottom")}>
            <span className="eyebrow">Net</span>
          </th>
          <th
            className={cn(
              NUMERIC,
              STICKY_COST_PER_USE,
              "w-20 bg-card align-bottom",
            )}
          >
            <span className="eyebrow">$/use</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {data.groups.flatMap((group) => [
          <tr key={`group-${group.key}`} className="bg-muted/40">
            <td
              aria-label={group.label}
              colSpan={columnSpan}
              className={cn(
                STICKY,
                "border-y border-[var(--border)] bg-muted/40 px-2 py-1",
              )}
            >
              <Row align="center" gap="sm" className="w-64">
                <span className="eyebrow">{group.label}</span>
                <Badge variant="outline">{group.rowCount}</Badge>
              </Row>
            </td>
          </tr>,
          ...(rowsByGroup.get(group.key) ?? []).map((row) => (
            <tr key={row.productId} className="group/row hover:bg-muted/20">
              <td
                className={cn(
                  STICKY,
                  "w-64 max-w-64 min-w-64 border-r border-b border-[var(--border)] px-2 py-1 group-hover/row:bg-muted",
                )}
              >
                <div className="w-64 min-w-0">
                  <ToolIdentityLink row={row} />
                  <div className="truncate text-2xs text-slate">
                    {row.manufacturer}
                    {!row.isInventoried && " · not in inventory"}
                  </div>
                </div>
              </td>
              {data.columns.map((column, columnIndex) => {
                const key = cellKey(column.projectId, row.productId);
                const cell = cellIndex.get(key);
                const optimistic = pending.get(key);
                const conflictReason = conflictIndex.get(key) ?? null;
                const serverState: CellState =
                  cell === undefined
                    ? // Locked only with nothing to weigh against it. Any cell
                      // the server emitted carries evidence — a recorded edge,
                      // a suggestion, or a purchase charged to this project —
                      // and evidence always beats the inferred window.
                      conflictReason
                      ? "conflict"
                      : "empty"
                    : cell.state === "attached"
                      ? "attached"
                      : cell.state === "purchase_evidence"
                        ? "evidence"
                        : cell.lane === "purchased_here"
                          ? "purchased"
                          : "trade";
                // An optimistic toggle-off drops straight to empty rather than
                // back to its ghost: the suggestion that produced the ghost is
                // recomputed server-side, so guessing it here would flicker.
                const state: CellState =
                  optimistic === undefined
                    ? serverState
                    : optimistic
                      ? "attached"
                      : "empty";
                return (
                  <MatrixCell
                    key={key}
                    state={state}
                    purchaseCost={cell?.projectPurchaseCost ?? 0}
                    title={`${row.productName} on ${column.projectName}`}
                    conflictReason={conflictReason}
                    striped={columnIndex % 2 === 1}
                    onToggle={() =>
                      onToggle(
                        column.projectId,
                        row.productId,
                        state !== "attached",
                      )
                    }
                  />
                );
              })}
              <td
                className={cn(
                  NUMERIC,
                  STICKY_USES,
                  "border-b border-l border-[var(--border)] group-hover/row:bg-muted",
                )}
              >
                {row.visibleUseCount > 0 ? (
                  row.visibleUseCount
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
                {row.projectUseCount !== row.visibleUseCount && (
                  <span className="text-muted-foreground">
                    {" "}
                    / {row.projectUseCount}
                  </span>
                )}
              </td>
              <td
                className={cn(
                  NUMERIC,
                  STICKY_NET,
                  "border-b border-[var(--border)] group-hover/row:bg-muted",
                )}
              >
                {formatCurrency(row.netLifetimeCost, 0)}
              </td>
              <td
                className={cn(
                  NUMERIC,
                  STICKY_COST_PER_USE,
                  "border-b border-[var(--border)] group-hover/row:bg-muted",
                )}
              >
                {row.costPerProjectUse === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatCurrency(row.costPerProjectUse, 0)
                )}
              </td>
            </tr>
          )),
        ])}
      </tbody>
      <tfoot>
        <tr className="border-t border-[var(--foreground)]">
          <td
            aria-label="Tool totals"
            className={cn(STICKY, "bg-card px-2 py-1")}
          >
            <div className="w-64">
              <span className="eyebrow">{data.rows.length} tools</span>
            </div>
          </td>
          {data.columns.map((column, columnIndex) => (
            <td
              key={column.projectId}
              aria-label={`${column.projectName} attached tools`}
              className={cn(
                "bg-card text-center font-mono text-2xs tabular-nums",
                columnIndex % 2 === 1 && "bg-muted/20",
              )}
            >
              {column.attachedCount || (
                <span className="text-muted-foreground">·</span>
              )}
            </td>
          ))}
          <td
            aria-label="Attached uses total"
            className={cn(NUMERIC, STICKY_USES, "border-l bg-card")}
          >
            {data.totals.attachedCells}
          </td>
          <td
            aria-label="Suggested tools total"
            className={cn(NUMERIC, STICKY_COST_PER_USE, "bg-card")}
            colSpan={2}
          >
            {data.totals.suggestedCells} suggested
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
