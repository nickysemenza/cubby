import type { Entity } from "@cubby/schemas/entity";
import type { ListBatch } from "@cubby/schemas/pagination";
import { countLabel } from "@cubby/shared/pluralize";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RowData } from "@tanstack/react-table";
import { cn } from "cn";
import { useState } from "react";
import { toast } from "sonner";

import { verbDef } from "~/entity/actions/action-verbs";
import { fieldOptions } from "~/entity/display/list-renderers/generic-state";
import { entities } from "~/entity/entities";
import type { ServerTreeBatch } from "~/entity/hooks/use-server-tree-children";
import { entityMetadata } from "~/entity/metadata";
import { columnKindOf } from "~/ui/data-table/column-kind-widths";
import { rowLineClasses } from "~/ui/data-table/density";
import type { CubbyRow as Row } from "~/ui/data-table/table-features";
import { showErrorToast } from "~/ui/feedback/error-details";
import { ProgressMeter } from "~/ui/feedback/progress-meter";
import { MoreMenuTrigger } from "~/ui/navigation/more-menu-trigger";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/ui/primitives/dropdown-menu";
import { TableCell, TableRow } from "~/ui/primitives/table";
import { StateBadge } from "~/ui/records/state-badge";
import { DateDisplay } from "~/ui/values/date-display";
import { DenseCellContext } from "~/ui/values/stacked-value";

import type { BatchCommand } from "./batch-command";

/** The batch's members by state, most urgent phase first. */
function batchRollup(
  queryClient: QueryClient,
  entity: Entity,
  batch: ListBatch,
) {
  const state = entityMetadata(queryClient, entity).summary.state;
  const options = state ? fieldOptions(queryClient, entity, state.field) : [];
  const counted = Object.entries(batch.states)
    .filter(([, count]) => count > 0)
    .map(([value, count]) => {
      const option = options.find((candidate) => candidate.value === value) ?? {
        value,
        label: value,
      };
      return { option, count };
    });
  const order = ["needs", "active", "finished"] as const;
  counted.sort(
    (left, right) =>
      order.indexOf(left.option.phase ?? "finished") -
      order.indexOf(right.option.phase ?? "finished"),
  );
  const failed = counted
    .filter(({ option }) => option.stage === "stuck")
    .reduce((sum, { count }) => sum + count, 0);
  return { counted, failed, lead: counted[0] };
}

/** A batch's title ("16 Email imports") and its rollup words. */
export function batchSummary(
  queryClient: QueryClient,
  entity: Entity,
  batch: ListBatch,
) {
  const by = entityMetadata(queryClient, entity).summary.list.tree?.batch?.by;
  const kind = by
    ? fieldOptions(queryClient, entity, by).find(
        (option) => option.value === batch.value,
      )
    : undefined;
  const noun = kind?.label ?? entities[entity].label;
  const rollup = batchRollup(queryClient, entity, batch);
  return {
    title: countLabel(batch.count, noun),
    words: rollup.counted
      .map(({ option, count }) => `${count} ${option.label.toLowerCase()}`)
      .join(", "),
    ...rollup,
  };
}

/**
 * A batch of automatic siblings folded into one row: "16 Email imports" with
 * its state rollup, member progress, the most urgent member state and the
 * newest activity, drawn under the table's own columns. Expanding it pages the
 * members through the `batch` scope; its commands go to each unfinished
 * member through the ordinary action path.
 */
export function BatchRow<TItem extends RowData>({
  entity,
  row,
  batch,
  height,
  cellClassName,
  unpaintedColumns,
  commands = [],
}: {
  entity: Entity;
  row: Row<TItem>;
  batch: ServerTreeBatch;
  height: string;
  cellClassName: string;
  unpaintedColumns: ReadonlySet<string>;
  commands?: readonly BatchCommand[];
}) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<string | null>(null);
  const {
    title,
    words: rollup,
    counted,
    failed,
    lead,
  } = batchSummary(queryClient, entity, batch);
  const finished = batch.phases.finished ?? 0;
  const active = batch.phases.active ?? 0;
  const expanded = row.getIsExpanded();
  const lines = rowLineClasses("single");
  const activityColumn = row
    .getVisibleCells()
    .find(
      (cell) =>
        !unpaintedColumns.has(cell.column.id) &&
        columnKindOf(cell.column.columnDef.meta) === "activity",
    )?.column.id;
  const offered = commands.filter((command) => !command.hidden);
  const run = async (command: BatchCommand) => {
    setRunning(command.id);
    try {
      const { done, total } = await command.run(
        batch,
        new AbortController().signal,
      );
      const { label } = verbDef(command.verb);
      const noun = entities[entity].pluralLabel.toLowerCase();
      if (done === 0)
        toast(`${label}: none of the ${total} active ${noun} accept it`);
      else toast.success(`${label}: ${done} of ${total} ${noun}`);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setRunning(null);
    }
  };

  const content = (columnId: string) => {
    const meta = row
      .getVisibleCells()
      .find((cell) => cell.column.id === columnId)?.column.columnDef.meta;
    if (meta?.entityColumnRole === "identity")
      return (
        <span
          className="flex min-w-0 items-center gap-1"
          style={{ paddingLeft: `${row.depth * 1.25}rem` }}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`}
            onClick={row.getToggleExpandedHandler()}
          >
            <CaretRightIcon
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-(--brand-motion-fast) ease-cozy",
                expanded && "rotate-90",
              )}
            />
          </Button>
          <StackIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate">
            <span className="font-medium">{title}</span>
            {rollup ? (
              <span className="text-muted-foreground"> · {rollup}</span>
            ) : null}
          </span>
        </span>
      );
    if (meta?.widthKind === "progress")
      return (
        <ProgressMeter
          variant="row"
          value={{
            done: finished,
            failed,
            active,
            stalled: 0,
            queued: 0,
            total: batch.count,
            unit: entities[entity].pluralLabel.toLowerCase(),
          }}
        />
      );
    if (meta?.widthKind === "state" && lead)
      return (
        <StateBadge
          option={lead.option}
          phase={lead.option.phase ?? "finished"}
          reason={counted.length > 1 ? rollup : null}
        />
      );
    if (columnId === activityColumn && batch.latestActivity)
      return (
        <DenseCellContext value={{ linksTo: null }}>
          <DateDisplay timestamp={batch.latestActivity} />
        </DenseCellContext>
      );
    // One menu like a record row's: an icon per command overflowed the
    // actions column under the activity cell.
    if (meta?.entityColumnRole === "action" && offered.length > 0)
      return (
        <span className="flex justify-end">
          <DropdownMenu>
            <MoreMenuTrigger
              aria-label={`Actions for every active member of ${title}`}
              size="icon-sm"
              disabled={running !== null}
              onClick={(event) => event.stopPropagation()}
            />
            <DropdownMenuContent align="end">
              {offered.map((command) => {
                const { label, icon: Icon } = verbDef(command.verb);
                return (
                  <DropdownMenuItem
                    key={command.id}
                    onClick={() => void run(command)}
                  >
                    <Icon aria-hidden />
                    {label} all
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      );
    return null;
  };

  const paint = (cell: ReturnType<typeof row.getVisibleCells>[number]) => (
    <TableCell
      key={cell.id}
      data-column-id={cell.column.id}
      className={cn(cellClassName, cell.column.columnDef.meta?.className)}
    >
      <div className={lines.cellContentClass}>
        <div className="min-w-0">{content(cell.column.id)}</div>
      </div>
    </TableCell>
  );

  return (
    <TableRow
      data-batch-row=""
      aria-label={title}
      className={cn("border-b border-hairline-soft", lines.rowClass)}
      style={{ height }}
    >
      {[...row.getStartVisibleCells(), ...row.getCenterVisibleCells()]
        .filter((cell) => !unpaintedColumns.has(cell.column.id))
        .map(paint)}
      {/* The same trailing spacer as a record row, so pinned end columns
          (the actions menu) line up with the rows around the batch. */}
      <TableCell data-spacer aria-hidden className={cellClassName} />
      {row.getEndVisibleCells().map(paint)}
    </TableRow>
  );
}
