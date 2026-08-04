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
import type { ProjectKind } from "@cubby/schemas/project";
import {
  isLiveProjectStatus,
  type ProjectToolMatrixCellOut,
  type ProjectToolMatrixOut,
  projectKindValues,
} from "@cubby/schemas/project";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Check, Search, Slash, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries, queryKeys } from "~/lib/query-keys";
import { toolTimelineConflict } from "~/lib/tool-timeline";
import { cn, formatCurrency } from "~/lib/utils";
import type { ToolMatrixSearch } from "~/routes/_authenticated/projects.tools";

/**
 * How long a cell waits before it commits. A click-and-revert inside this
 * window never reaches the server, which is the only honest way to stop
 * click-then-click-back writing two audit entries — the endpoint itself must
 * report both, because both really happened.
 */
const CELL_SETTLE_MS = 400;

const COST_FLOORS = [0, 100, 250, 500] as const;

const KIND_LABELS: Record<ProjectKind, string> = {
  furniture: "Furniture",
  workshop: "Workshop",
  household: "Household",
  renovation: "Renovation",
  garden: "Garden",
};

const cellKey = (projectId: string, productId: string) =>
  `${projectId}:${productId}`;

/** Sticky row-header column; the header corner has to outrank it. */
const STICKY = "sticky left-0 z-10 bg-background";
const NUMERIC = "px-2 py-1 text-right font-mono text-2xs tabular-nums";

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
              "border-[var(--border)] border-l px-2 py-1 font-mono text-2xs first:border-l-0",
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
  onToggle,
}: {
  state: CellState;
  purchaseCost: number;
  title: string;
  /** Set on `conflict`, and on an ATTACHED cell that predates its own tool. */
  conflictReason: string | null;
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
    <td className="border-[var(--border)] border-b border-l p-0">
      <button
        type="button"
        title={hint}
        aria-label={hint}
        aria-pressed={state === "attached"}
        aria-disabled={locked}
        disabled={locked}
        onClick={onToggle}
        className={cn(
          "flex h-6 w-full items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
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
              "border border-primary border-dashed text-primary",
            state === "trade" && "border border-muted-foreground border-dotted",
            // A locked cell says "not possible", not "not yet" — so it reads as
            // struck-through rather than as one more empty box to fill in.
            locked && "text-muted-foreground/60",
            // An attached edge that conflicts stays fully editable: it is the
            // only way to correct one. It just stops looking clean.
            flagged && "bg-warning/20 text-warning ring-1 ring-warning",
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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [toolDraft, setToolDraft] = useState(search.tool ?? "");

  useEffect(() => {
    setToolDraft(search.tool ?? "");
  }, [search.tool]);

  const input = useMemo(
    () => ({
      kinds: search.kinds,
      toolSearch: search.tool,
      minNetLifetimeCost: search.floor ?? 100,
      groupBy: search.group ?? ("trade" as const),
      maxColumns: 24,
    }),
    [search.kinds, search.tool, search.floor, search.group],
  );

  const { data, isLoading } = useQuery(
    api.project.toolMatrix.queryOptions(input),
  );

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

  const setUsage = useMutation(api.project.setToolUsage.mutationOptions());

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
              // A raw useMutation rather than useActionMutation because the
              // overlay has to be cleared on BOTH outcomes, and that hook owns
              // its own onError.
              onError: (error) => toast.error(getErrorMessage(error)),
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
                void invalidateTRPCQueries(queryClient, [
                  queryKeys.project.all,
                ]);
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

  const kindFilter = search.kinds ?? [];
  const toggleKind = (kind: ProjectKind) => {
    const next = kindFilter.includes(kind)
      ? kindFilter.filter((value) => value !== kind)
      : [...kindFilter, kind];
    onSearchChange({ kinds: next.length > 0 ? next : undefined });
  };

  return (
    <Stack gap="md">
      <div className="rounded border border-[var(--border)] bg-card">
        <Row
          align="center"
          gap="lg"
          wrap
          className="border-[var(--border)] border-b px-2 py-2"
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
          <Row align="center" gap="sm">
            <span className="eyebrow">Kind</span>
            <Row gap="xs" wrap>
              {projectKindValues.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={kindFilter.includes(kind)}
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    "rounded border border-[var(--border)] px-2 py-1 font-mono text-2xs",
                    kindFilter.includes(kind)
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {KIND_LABELS[kind]}
                </button>
              ))}
            </Row>
          </Row>
          <Row align="center" gap="sm" className="ml-auto">
            <Search className="size-3.5 text-muted-foreground" aria-hidden />
            <Input
              value={toolDraft}
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
                : "No projects match this scope. Clear the kind filter to widen it."}
            </EmptyDescription>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <MatrixTable
              data={data}
              cellIndex={cellIndex}
              pending={pending}
              onToggle={toggleCell}
            />
          </div>
        )}
      </div>

      <Row gap="lg" wrap className="text-2xs text-muted-foreground">
        <Row align="center" gap="sm">
          <span className="size-3 rounded-[3px] bg-primary" aria-hidden />
          attached — a recorded project use
        </Row>
        <Row align="center" gap="sm">
          <span
            className="size-3 rounded-[3px] border border-primary border-dashed"
            aria-hidden
          />
          bought here — the purchase is on this project
        </Row>
        <Row align="center" gap="sm">
          <span
            className="size-3 rounded-[3px] border border-muted-foreground border-dotted"
            aria-hidden
          />
          trade match — this project does that kind of work
        </Row>
        <Row align="center" gap="sm">
          <span
            className="flex size-3 items-center justify-center rounded-[3px] bg-muted/50 text-muted-foreground/60"
            aria-hidden
          >
            <Slash className="size-3" />
          </span>
          not owned then — bought after, or sold before
        </Row>
        <span>
          {data.totals.matchingTools} tools · {data.totals.matchingProjects}{" "}
          projects matched
          {data.totals.timelineConflictCells > 0 &&
            ` · ${data.totals.timelineConflictCells} cells locked by the ownership timeline`}
          {data.truncated.columns && " (columns capped)"}
          {data.truncated.rows && " (rows capped)"}
        </span>
      </Row>
    </Stack>
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

  return (
    <table className="border-collapse text-left">
      <thead>
        <tr className="border-[var(--foreground)] border-b-[3px]">
          <th className={cn(STICKY, "z-20 bg-card px-2 pb-1 align-bottom")}>
            <div className="w-64">
              <span className="eyebrow">Tool</span>
            </div>
          </th>
          {data.columns.map((column) => (
            <th
              key={column.projectId}
              className="w-8 min-w-8 border-[var(--border)] border-l bg-card align-bottom"
              title={`${column.projectName} · ${column.attachedCount} attached, ${column.suggestedCount} suggested`}
            >
              <div
                className="mx-auto h-36 overflow-hidden text-ellipsis whitespace-nowrap py-2 text-2xs"
                style={{
                  writingMode: "vertical-rl",
                  transform: "rotate(180deg)",
                }}
              >
                {column.projectName}
              </div>
              <div className="pb-1 text-center text-2xs text-slate">
                {column.startDate ? column.startDate.slice(2, 4) : "—"}
              </div>
            </th>
          ))}
          <th className={cn(NUMERIC, "w-14 bg-card align-bottom")}>
            <span className="eyebrow">Uses</span>
          </th>
          <th className={cn(NUMERIC, "w-20 bg-card align-bottom")}>
            <span className="eyebrow">Net</span>
          </th>
          <th className={cn(NUMERIC, "w-20 bg-card align-bottom")}>
            <span className="eyebrow">$/use</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {data.groups.flatMap((group) => [
          <tr key={`group-${group.key}`} className="bg-muted/40">
            <td
              colSpan={columnSpan}
              className={cn(
                STICKY,
                "border-[var(--border)] border-y bg-muted/40 px-2 py-1",
              )}
            >
              <Row align="center" gap="sm" className="w-64">
                <span className="eyebrow">{group.label}</span>
                <Badge variant="outline">{group.rowCount}</Badge>
              </Row>
            </td>
          </tr>,
          ...(rowsByGroup.get(group.key) ?? []).map((row) => (
            <tr key={row.productId} className="hover:bg-muted/20">
              <td
                className={cn(
                  STICKY,
                  "border-[var(--border)] border-r border-b px-2 py-1",
                )}
              >
                <div className="w-64 min-w-0">
                  <EntityInlineLink
                    entity="product"
                    data={{
                      id: row.productId,
                      name: row.productName,
                      manufacturer: row.manufacturer,
                    }}
                    truncate
                  />
                  <div className="truncate text-2xs text-slate">
                    {row.manufacturer}
                    {!row.isInventoried && " · not in inventory"}
                  </div>
                </div>
              </td>
              {data.columns.map((column) => {
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
              <td className={cn(NUMERIC, "border-[var(--border)] border-b")}>
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
              <td className={cn(NUMERIC, "border-[var(--border)] border-b")}>
                {formatCurrency(row.netLifetimeCost, 0)}
              </td>
              <td className={cn(NUMERIC, "border-[var(--border)] border-b")}>
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
        <tr className="border-[var(--foreground)] border-t-[3px]">
          <td className={cn(STICKY, "bg-card px-2 py-1")}>
            <div className="w-64">
              <span className="eyebrow">{data.rows.length} tools</span>
            </div>
          </td>
          {data.columns.map((column) => (
            <td
              key={column.projectId}
              className="bg-card text-center font-mono text-2xs tabular-nums"
            >
              {column.attachedCount || (
                <span className="text-muted-foreground">·</span>
              )}
            </td>
          ))}
          <td className={cn(NUMERIC, "bg-card")}>
            {data.totals.attachedCells}
          </td>
          <td className={cn(NUMERIC, "bg-card")} colSpan={2}>
            {data.totals.suggestedCells} suggested
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
