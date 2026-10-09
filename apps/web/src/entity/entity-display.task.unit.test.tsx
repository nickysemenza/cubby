import type { CellData } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/ui/data-table/table-features";

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
          id: "projectId",
          cell: ({ row }) => (
            <span>{row.original.projectName ?? "No project"}</span>
          ),
        }),
      );
      add(
        helper.display({
          id: "subjectProductId",
          cell: ({ row }) => <span>{row.original.subjectProductName}</span>,
        }),
      );
      add(
        helper.display({
          id: "parentTaskId",
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

describe("task list display columns", () => {
  it("folds dueDate and dueEndDate into the one declared span column", () => {
    render(
      <>
        {renderTaskCell("dueDate", { ...TASK_ROW, dueEndDate: "2026-09-23" })}
      </>,
    );
    expect(screen.getByText(/Sep 20 – 23/)).toBeVisible();
  });

  it("renders the generic status column as its rich label, never the stored value", () => {
    render(<>{renderTaskCell("status", TASK_ROW)}</>);
    expect(screen.getByText("In progress")).toBeVisible();
    expect(screen.queryByText("in_progress")).toBeNull();
  });
});
