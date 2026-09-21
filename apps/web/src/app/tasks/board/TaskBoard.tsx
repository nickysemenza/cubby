import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import {
  type CollisionDetection,
  closestCorners,
  DndContext,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
} from "@dnd-kit/core";
import { keyBy } from "es-toolkit";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";

import { useDeleteEntityAction } from "~/app/_components/actions/delete-entity-action";
import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/components/dnd/accessibility";
import { createDndAutoScroller } from "~/components/dnd/auto-scroll";
import { DragPreviewFrame } from "~/components/dnd/DragPreviewFrame";
import {
  createValidTargetKeyboardCoordinates,
  useCubbyDndSensors,
} from "~/components/dnd/sensors";
import { Row } from "~/components/layout";
import { taskCaptureRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { useIsMobile } from "~/hooks/useMobile";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

import type { BoardColsMode, BoardLaneMode } from "./board-model";
import {
  buildColumns,
  buildLanes,
  cellTasks,
  computeMove,
} from "./board-model";
import {
  asCardDropData,
  asDragData,
  asDropData,
  type TaskCreatePreset,
} from "./board-types";
import { BoardAgenda } from "./BoardAgenda";
import {
  axisColorChip,
  axisKey,
  axisLabel,
  BoardCell,
  BoardColumn,
  type CardRenderProps,
  ColumnHeader,
} from "./BoardColumn";
import { edgeForDrop, useBoardDnd } from "./use-board-dnd";
import {
  type BoardCacheTarget,
  useBoardMutations,
} from "./use-board-mutations";

/** A board column's fixed track width — keep in sync with the grid template below. */
const COLUMN_WIDTH = "16rem";
/** The swimlane label track width (grid template's first column). */
const LANE_LABEL_WIDTH = "8rem";

/**
 * Default vertical bound for the standalone `/tasks?view=board` page: nav bar
 * + page header + the view switcher and board-controls rows above it. The
 * project detail embed (a card section, less chrome above it) passes a
 * shorter fixed bound instead — see its `TaskBoard` usage.
 */
const DEFAULT_MAX_HEIGHT = "max-h-[calc(100dvh-18rem)]";

interface TaskBoardProps {
  tasks: TaskOut[];
  cols: BoardColsMode;
  /** Swimlane axis (only meaningful when `cols === "status"`); null = no lanes. */
  lane: BoardLaneMode | null;
  /**
   * Which cache the optimistic patch targets, with the EXACT input this
   * surface passed to its own `chartData`/`board` `queryOptions` call (share
   * the constant/helper) — see `BoardCacheTarget`.
   */
  cacheTarget: BoardCacheTarget;
  /** Whether cards may show the project link (off when a single project owns the board). */
  showProjectOnCards: boolean;
  /**
   * Tailwind max-height class bounding the board's vertical scroll region —
   * column headers stay pinned (`sticky top-0`) while cards scroll beneath.
   * Optional; defaults to a bound sized for the standalone board page.
   */
  maxHeightClassName?: string;
  /**
   * The server's true done-task count, for a caller whose `tasks` only
   * carries a capped slice of done work (see `TasksBoardView` / `task.board`'s
   * `doneCount`). Omitted by callers passing the complete task set (e.g. the
   * project detail embed), which keeps today's exact locally-computed count.
   */
  doneCountOverride?: number;
}

/**
 * The shared board core, used by both `/tasks?view=board` and the project
 * detail embed. Renders columns (status/project/trade) with optional project or
 * trade swimlanes; one drag fires one optimistic `task.update`.
 */
export function TaskBoard({
  tasks,
  cols,
  lane,
  cacheTarget,
  showProjectOnCards,
  maxHeightClassName = DEFAULT_MAX_HEIGHT,
  doneCountOverride,
}: TaskBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroller = useRef<ReturnType<typeof createDndAutoScroller> | null>(
    null,
  );
  useEffect(() => {
    autoScroller.current = createDndAutoScroller({ axis: "both" });
    return () => autoScroller.current?.stop();
  }, []);
  const isMobile = useIsMobile();

  const { moveTask, reorderTasks, deleteTask, isDeleting } =
    useBoardMutations(cacheTarget);
  const onDragEnd = useBoardDnd({ tasks, moveTask, reorderTasks });
  const [activeTaskId, setActiveTaskId] = useState<TaskOut["id"] | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    taskId: TaskOut["id"];
    edge: "top" | "bottom";
  } | null>(null);
  const keyboardCoordinates = useMemo(
    () =>
      createValidTargetKeyboardCoordinates((activeData, targetData) => {
        const drag = asDragData(activeData ?? {});
        if (!drag || !targetData) return false;
        const card = asCardDropData(targetData);
        if (card) return card.targetTaskId !== drag.taskId;
        const cell = asDropData(targetData);
        return cell ? computeMove(drag, cell) != null : false;
      }),
    [],
  );
  const sensors = useCubbyDndSensors({
    pointerDistance: 4,
    touchDelay: 250,
    touchTolerance: 8,
    keyboardCoordinates,
  });
  // Hydration-stable id; see TableHeaderLayout for why the counter default breaks.
  const describedById = `DndDescribedBy-${useId()}`;

  // One hoisted quick-add dialog (not one per column/cell) — the "+" in a
  // column header or an empty cell sets this, which mounts the dialog fresh
  // with that click's preset; closing unmounts it, so the next click always
  // gets a clean intent-backed form on the next open.
  const [pendingPreset, setPendingPreset] = useState<TaskCreatePreset | null>(
    null,
  );

  // The delete action itself is hoisted here (not owned by `TaskCard`) for
  // the same reason the quick-add dialog is: the optimistic delete drops the
  // card out of `cellTasks`, so a dialog owned by the card would unmount
  // before the mutation settles (see `useDeleteEntityAction`'s own doc for
  // why the caller, not the row, must hold the staged delete).
  const deleteAction = useDeleteEntityAction(
    "task",
    {
      isPending: isDeleting,
      remove: async (ids) => {
        const id = ids[0];
        if (!id) return { ok: false, issues: [] };
        try {
          await deleteTask(parseShortcodeFor("task", id));
          return { ok: true, entity: "task", id, changed: true };
        } catch (error) {
          return {
            ok: false,
            issues: [{ message: getErrorMessage(error), source: "server" }],
          };
        }
      },
    },
    // `TaskBoard` can be embedded inside another entity's own detail page
    // (see `ProjectDetail`) — navigating to `/tasks` after a delete there
    // would take the household off the project they were looking at.
    { navigateOnSuccess: false },
  );

  const columns = useMemo(() => buildColumns(tasks, cols), [tasks, cols]);
  const lanes = useMemo(
    () => (lane ? buildLanes(tasks, lane) : null),
    [tasks, lane],
  );
  const taskById = useMemo(() => keyBy(tasks, (t) => t.id), [tasks]);

  const cardProps: CardRenderProps = useMemo(
    () => ({
      taskById,
      // A project link is redundant when the column or lane already is the project.
      showProject:
        showProjectOnCards && cols !== "project" && lane !== "project",
      // A trade badge is redundant when the column or lane already is the trade.
      showTrade: cols !== "trade" && lane !== "trade",
      // Without status columns, the card itself must say where the work stands.
      showStatus: cols !== "status",
      onSetStatus: (taskId: TaskOut["id"], status: TaskStatus) =>
        moveTask(taskId, { status }),
      onRequestDelete: (task: TaskOut) => void deleteAction.run?.([task]),
      dropTarget,
    }),
    [
      taskById,
      showProjectOnCards,
      cols,
      lane,
      moveTask,
      dropTarget,
      deleteAction,
    ],
  );

  // Column header counts span every lane; project/trade columns count only
  // their visible (active) work, the Done column keeps its true total —
  // overridden by `doneCountOverride` when `tasks` only carries a capped
  // slice of done work (see `TaskBoardProps.doneCountOverride`).
  const columnCounts = useMemo(
    () =>
      columns.map((c) => {
        const { totalCount, hiddenDoneCount } = cellTasks(tasks, c, null);
        if (
          c.kind === "status" &&
          c.status === "done" &&
          doneCountOverride !== undefined
        ) {
          return doneCountOverride;
        }
        return totalCount - hiddenDoneCount;
      }),
    [columns, tasks, doneCountOverride],
  );

  // Sticky header cells: opaque paper background so cards scroll under them
  // cleanly, pinned to the top of the shared vertical scroll region below.
  const stickyHeaderClassName = "sticky top-0 z-10 bg-background";

  // Trade/project columns only exist for axis values with active work — a
  // filtered-to-nothing search (or a trade-columns board with no active
  // tasks at all) can leave zero columns, which would otherwise render a
  // blank board with no explanation.
  const board =
    columns.length === 0 ? (
      <p className="flex min-h-32 items-center justify-center border border-dashed border-muted-foreground/20 p-4 text-sm text-muted-foreground">
        No tasks to show
      </p>
    ) : lanes ? (
      <div ref={scrollRef} className="overflow-x-auto">
        <div
          className={cn(
            "grid min-w-max gap-2 overflow-y-auto",
            maxHeightClassName,
          )}
          style={{
            gridTemplateColumns: `${LANE_LABEL_WIDTH} repeat(${columns.length}, ${COLUMN_WIDTH})`,
          }}
        >
          <div className={stickyHeaderClassName} />
          {columns.map((column, i) => (
            <ColumnHeader
              key={axisKey(column)}
              column={column}
              count={columnCounts[i] ?? 0}
              onQuickAdd={setPendingPreset}
              className={stickyHeaderClassName}
            />
          ))}
          {lanes.map((laneKey) => (
            <Fragment key={axisKey(laneKey)}>
              <Row align="center" gap="tight" className="min-w-0 pt-1">
                {axisColorChip(laneKey)}
                <span className="truncate text-sm font-medium text-muted-foreground">
                  {axisLabel(laneKey)}
                </span>
              </Row>
              {columns.map((column) => (
                <BoardCell
                  key={axisKey(column)}
                  tasks={tasks}
                  column={column}
                  lane={laneKey}
                  cardProps={cardProps}
                  onQuickAdd={setPendingPreset}
                  // Each cell scrolls independently so one busy lane×column
                  // intersection doesn't stretch the whole shared grid row.
                  className="max-h-64 overflow-y-auto"
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    ) : (
      <div ref={scrollRef} className="overflow-x-auto">
        <Row
          align="stretch"
          gap="sm"
          className={cn("min-w-max overflow-y-hidden pb-2", maxHeightClassName)}
        >
          {columns.map((column) => (
            <BoardColumn
              key={axisKey(column)}
              tasks={tasks}
              column={column}
              cardProps={cardProps}
              onQuickAdd={setPendingPreset}
              doneCountOverride={doneCountOverride}
            />
          ))}
        </Row>
      </div>
    );

  const activeTask = activeTaskId ? taskById[activeTaskId] : null;
  const onDragStart = ({ active }: DragStartEvent) => {
    const drag = asDragData(active.data.current ?? {});
    setActiveTaskId(drag?.taskId ?? null);
  };
  const onDragMove = (event: DragMoveEvent) => {
    const rect = event.active.rect.current.translated;
    const scrollRoot = scrollRef.current;
    if (rect && scrollRoot) {
      autoScroller.current?.update(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        [
          scrollRoot,
          document.scrollingElement instanceof HTMLElement
            ? document.scrollingElement
            : null,
        ],
      );
    }
  };
  const onDragOver = (event: DragOverEvent) => {
    const target = event.over
      ? asCardDropData(event.over.data.current ?? {})
      : null;
    setDropTarget(
      target ? { taskId: target.targetTaskId, edge: edgeForDrop(event) } : null,
    );
  };
  const clearDragState = () => {
    autoScroller.current?.stop();
    setActiveTaskId(null);
    setDropTarget(null);
  };

  return (
    <>
      <DndContext
        id={describedById}
        sensors={sensors}
        autoScroll={false}
        collisionDetection={boardCollisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragOver}
        onDragCancel={clearDragState}
        onDragEnd={(event) => {
          onDragEnd(event);
          clearDragState();
        }}
        accessibility={{
          container: globalThis.document?.body,
          screenReaderInstructions: cubbyDndScreenReaderInstructions,
          announcements: createDndAnnouncements({
            item: (id) =>
              taskById[
                parseShortcodeFor("task", id.replace("task-board:drag:", ""))
              ]?.name ?? "task",
            target: (id) => id.replace("task-board:", "").replaceAll(":", " "),
          }),
        }}
      >
        {isMobile ? (
          <div
            ref={scrollRef}
            className={cn("overflow-y-auto", maxHeightClassName)}
          >
            <BoardAgenda
              tasks={tasks}
              cardProps={cardProps}
              doneCountOverride={doneCountOverride}
              showEmptyDropTargets={activeTaskId !== null}
            />
          </div>
        ) : (
          board
        )}
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <DragPreviewFrame className="w-64 p-2">
              <p className="text-sm font-medium">{activeTask.name}</p>
              <p className="mt-1 font-mono text-2xs text-muted-foreground">
                Moving task
              </p>
            </DragPreviewFrame>
          )}
        </DragOverlay>
      </DndContext>
      {pendingPreset && (
        <EntityEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingPreset(null);
          }}
          request={taskCaptureRequest({
            status: pendingPreset.status,
            projectId: pendingPreset.projectId,
            trade: pendingPreset.trade,
          })}
        />
      )}
      {deleteAction.dialog}
    </>
  );
}

const boardCollisionDetection: CollisionDetection = (args) => {
  const active = asDragData(args.active.data.current ?? {});
  const targetDataFor = (collision: ReturnType<typeof pointerWithin>[number]) =>
    collision.data?.droppableContainer?.data?.current ?? {};
  const isValid = (collision: ReturnType<typeof pointerWithin>[number]) => {
    const targetData = targetDataFor(collision);
    const card = asCardDropData(targetData);
    if (card) return !active || card.targetTaskId !== active.taskId;
    const cell = asDropData(targetData);
    return !active || (cell ? computeMove(active, cell) != null : false);
  };
  const preferCards = (collisions: ReturnType<typeof pointerWithin>) => {
    const validCollisions = collisions.filter(isValid);
    const cards = validCollisions.filter((collision) =>
      asCardDropData(targetDataFor(collision)),
    );
    return cards.length > 0 ? cards : validCollisions;
  };
  const pointerCollisions = preferCards(pointerWithin(args));
  return pointerCollisions.length > 0
    ? pointerCollisions
    : preferCards(closestCorners(args));
};
