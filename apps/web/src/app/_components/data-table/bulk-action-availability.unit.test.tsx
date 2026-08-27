import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkActionBar } from "./BulkActionBar";
import type { BulkAction } from "./bulk-actions.types";
import type { CubbyRow as Row } from "./table-features";
import { useBulkActions } from "./useBulkActions";

interface TestRow {
  id: string;
}

const rows = (...ids: string[]) =>
  ids.map((id) => ({ original: { id } })) as Row<TestRow>[];

const available = { status: "available" } as const;

describe("bulk action selection availability", () => {
  it("keeps disabled actions visible, omits hidden actions, and never executes a subset", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const mixedSelectionAction: BulkAction<TestRow> = {
      id: "move",
      label: "Move",
      availability: (selectedRows) =>
        selectedRows.some((row) => row.original.id === "LOCKED")
          ? { status: "disabled", reason: "Locked rows cannot move" }
          : available,
      onExecute: run,
    };
    const hiddenAction: BulkAction<TestRow> = {
      id: "hidden",
      label: "Hidden",
      availability: () => ({ status: "hidden" }),
      onExecute: run,
    };
    const { result } = renderHook(() =>
      useBulkActions({
        config: { actions: [mixedSelectionAction, hiddenAction] },
      }),
    );
    const mixedRows = rows("READY", "LOCKED");

    expect(
      result.current.getAvailableActions(mixedRows).map((action) => action.id),
    ).toEqual(["move"]);

    await act(async () => {
      await result.current.executeAction(mixedSelectionAction, mixedRows);
      await result.current.executeAction(hiddenAction, mixedRows);
    });
    expect(run).not.toHaveBeenCalled();

    const readyRows = rows("READY-1", "READY-2");
    await act(async () => {
      await result.current.executeAction(mixedSelectionAction, readyRows);
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(readyRows);
  });

  it("renders disabled reasons, hides unavailable actions, and preserves ordering", () => {
    const selectedRows = rows("READY", "LOCKED");
    const onExecute = vi.fn(async () => undefined);
    const actions: BulkAction<TestRow>[] = [
      {
        id: "delete",
        label: "Delete",
        tone: "destructive",
        onExecute: async () => ({ success: true }),
      },
      {
        id: "move",
        label: "Move",
        availability: () => ({
          status: "disabled",
          reason: "Locked rows cannot move",
        }),
        onExecute: async () => ({ success: true }),
      },
      {
        id: "hidden",
        label: "Hidden",
        availability: () => ({ status: "hidden" }),
        onExecute: async () => ({ success: true }),
      },
    ];

    render(
      <BulkActionBar
        selectedCount={selectedRows.length}
        selectedRows={selectedRows}
        actions={actions}
        onExecute={onExecute}
        onClearSelection={vi.fn()}
        isExecuting={false}
        currentAction={null}
      />,
    );

    const move = screen.getByRole("button", {
      name: "Move, Locked rows cannot move",
    });
    expect(move).toBeDisabled();
    expect(move).toHaveAttribute("title", "Locked rows cannot move");
    expect(screen.queryByRole("button", { name: "Hidden" })).toBeNull();
    expect(
      screen.getAllByRole("button").map((button) => button.textContent?.trim()),
    ).toEqual(["Move", "Delete", "Clear selection"]);

    fireEvent.click(move);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("blocks stale execution outside an action's selection bounds", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const inspect: BulkAction<TestRow> = {
      id: "inspect",
      label: "Inspect",
      maxSelection: 1,
      onExecute: run,
    };
    const { result } = renderHook(() =>
      useBulkActions({ config: { actions: [inspect] } }),
    );
    const twoRows = rows("FIRST", "SECOND");

    expect(result.current.getAvailableActions(twoRows)).toEqual([]);
    await act(async () => {
      await result.current.executeAction(inspect, twoRows);
    });

    expect(run).not.toHaveBeenCalled();
  });
});
