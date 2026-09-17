import type { CellData } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/app/_components/data-table/table-features";

import { createEntityDisplayColumns } from "./entity-display";

/**
 * The task list ("apps/web/src/app/tasks/tasklist.tsx") is the one page this
 * file guards: every column it declares an override for, and every generic
 * column the declaration alone produces, must keep exactly the shape asserted
 * here. See `docs/entities.md`'s "declaration wins" rule and the
 * `10-task.entity.ts` field roster.
 */

/** Row shape covering every task field the list surfaces, mirroring `TaskOut`
 * only where `createEntityDisplayColumns` reads it. */
interface TaskRow {
  status: string;
  projectId: string | null;
  projectName: string | null;
  subjectProductId: string | null;
  subjectProductName: string | null;
  parentTaskId: string | null;
  parentTaskName: string | null;
  dueDate: string | null;
  dueEndDate: string | null;
  trade: string;
  sortOrder: number | null;
}

const TASK_ROW: TaskRow = {
  status: "in_progress",
  projectId: "PRJ-1",
  projectName: "Kitchen remodel",
  subjectProductId: "PRD-1",
  subjectProductName: "Cabinet hinge",
  parentTaskId: "TSK-1",
  parentTaskName: "Demo cabinets",
  dueDate: "2026-09-20",
  dueEndDate: null,
  trade: "carpentry",
  sortOrder: null,
};

/**
 * Narrows a column's `cell` to a callable renderer taking only `{ row }` —
 * every plain-scalar column `createEntityDisplayColumns` builds itself, and
 * the same shape every override here uses. Copied from the shared
 * `entity-display.unit.test.tsx` fixture rather than imported: it captures
 * `TValue` per call site (see `materializeCubbyColumns`'s doc in
 * table-features.ts), so it can't be hoisted to a shared helper module either.
 */
function isRowRenderer<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
): cell is (context: { row: { original: TRecord } }) => ReactNode {
  return typeof cell === "function";
}

function renderRowCell<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
  record: TRecord,
): ReactNode {
  if (!isRowRenderer<TRecord, TValue>(cell)) {
    throw new Error("Expected a row cell renderer.");
  }
  return cell({ row: { original: record } });
}

/**
 * Builds the task list's columns the same way `tasklist.tsx` does: overrides
 * for the three relation-label columns (`projectId`/`subjectProductId`/
 * `parentTaskId` are `identifier` fields with a `reference`, so
 * `createEntityDisplayColumns` throws without one), and everything else
 * (`status`, `dueDate`, `dueEndDate`, `trade`, `sortOrder`) left generic to
 * exercise the declaration's own width/format/mobile metadata.
 */
function buildTaskColumns() {
  const helper = createCubbyColumnHelper<TaskRow>();
  return createEntityDisplayColumns(
    "task",
    helper,
    createCubbyColumnCollection<TaskRow>((add) => {
      add(
        helper.display({
          id: "project",
          cell: ({ row }) => (
            <span>{row.original.projectName ?? "No project"}</span>
          ),
        }),
      );
      add(
        helper.display({
          id: "subjectProduct",
          cell: ({ row }) => <span>{row.original.subjectProductName}</span>,
        }),
      );
      add(
        helper.display({
          id: "parentTask",
          cell: ({ row }) => <span>{row.original.parentTaskName}</span>,
        }),
      );
    }),
  );
}

/** Renders one column's cell against a fixture row — filtered to a single
 * column and invoked inside the same `.visit()` callback, so its `cell` is
 * used exactly where its `TValue` is still concrete (see
 * `materializeCubbyColumns`'s doc in table-features.ts). */
function renderTaskCell(columnId: string, row: TaskRow) {
  const columns = buildTaskColumns();
  const matched = columns.filter((column) => column.id === columnId);
  const rendered = matched.visit((column) => renderRowCell(column.cell, row));
  const [first] = rendered;
  if (rendered.length !== 1 || first === undefined) {
    throw new Error(`Expected exactly one column with id ${columnId}.`);
  }
  return first;
}

function buildTaskColumnMeta() {
  return buildTaskColumns().visit((column) => ({
    id: String(
      column.id ?? ("accessorKey" in column ? column.accessorKey : ""),
    ),
    header: z.string().parse(column.header),
    className: column.meta?.className,
    mobile: column.meta?.mobile,
    enableSorting: column.enableSorting,
  }));
}

describe("task list display columns", () => {
  it("builds exactly the declared columns, in model order", () => {
    const ids = buildTaskColumnMeta().map((d) => d.id);
    expect(ids).toEqual([
      "status",
      "project",
      "subjectProduct",
      "parentTask",
      "dueDate",
      "dueEndDate",
      "trade",
      "sortOrder",
    ]);
  });

  it("takes every header from the declared label, including on overrides", () => {
    const byId = Object.fromEntries(
      buildTaskColumnMeta().map((d) => [d.id, d.header]),
    );
    expect(byId).toEqual({
      status: "Status",
      project: "Project",
      subjectProduct: "For",
      parentTask: "Parent Task",
      dueDate: "Due",
      dueEndDate: "Due end",
      trade: "Trade",
      sortOrder: "Sort Order",
    });
  });

  it("derives enableSorting from the generated sort roster per column id", () => {
    const byId = Object.fromEntries(
      buildTaskColumnMeta().map((d) => [d.id, d.enableSorting]),
    );
    // In `generatedEntitySort.task.fields`.
    expect(byId.status).toBe(true);
    expect(byId.project).toBe(true);
    expect(byId.subjectProduct).toBe(true);
    expect(byId.dueDate).toBe(true);
    expect(byId.trade).toBe(true);
    // Not in the roster.
    expect(byId.parentTask).toBe(false);
    expect(byId.dueEndDate).toBe(false);
    expect(byId.sortOrder).toBe(false);
  });

  it("carries the declared width/mobile metadata for generic columns", () => {
    const byId = Object.fromEntries(
      buildTaskColumnMeta().map((d) => [d.id, d]),
    );
    expect(byId.status?.className).toBe("w-28");
    expect(byId.status?.mobile).toEqual({
      slot: "subtitle",
      priority: 10,
      interactive: undefined,
    });
    expect(byId.dueDate?.className).toBe("w-28");
    expect(byId.dueDate?.mobile).toEqual({
      slot: "meta",
      priority: 40,
      interactive: true,
    });
    expect(byId.trade?.className).toBe("w-28");
    expect(byId.trade?.mobile).toEqual({
      slot: "meta",
      priority: 50,
      interactive: undefined,
    });
    // `dueEndDate` and `sortOrder` declare no width/mobile at all — hidden by
    // default in `tasklist.tsx`'s `initialColumnVisibility`, but still built.
    expect(byId.dueEndDate?.className).toBeUndefined();
    expect(byId.dueEndDate?.mobile).toBeUndefined();
    expect(byId.sortOrder?.className).toBeUndefined();
    expect(byId.sortOrder?.mobile).toBeUndefined();
  });

  it("renders the generic dueDate column through the declared plainDate format", () => {
    render(<>{renderTaskCell("dueDate", TASK_ROW)}</>);
    expect(screen.getByText("Sep 20, 2026")).toBeVisible();
  });

  it("renders the project override's own cell against the row", () => {
    render(<>{renderTaskCell("project", TASK_ROW)}</>);
    expect(screen.getByText("Kitchen remodel")).toBeVisible();
  });

  it("rejects an override for a field the declaration no longer lists (subtaskCount is list: false)", () => {
    const helper = createCubbyColumnHelper<
      TaskRow & { subtaskCount: number }
    >();
    expect(() =>
      createEntityDisplayColumns(
        "task",
        helper,
        createCubbyColumnCollection((add) => {
          add(
            helper.display({
              id: "project",
              cell: () => null,
            }),
          );
          add(
            helper.display({
              id: "subjectProduct",
              cell: () => null,
            }),
          );
          add(
            helper.display({
              id: "parentTask",
              cell: () => null,
            }),
          );
          add(helper.display({ id: "subtaskCount", cell: () => null }));
        }),
      ),
    ).toThrow("Undeclared display renderer for task.subtaskCount");
  });
});
