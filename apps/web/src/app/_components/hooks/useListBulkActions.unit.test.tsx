import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BulkAction } from "../data-table/bulk-actions.types";
import type { CubbyRow as Row } from "../data-table/table-features";

const mocks = vi.hoisted(() => ({
  copyShortcodes: vi.fn(async () => true),
}));

vi.mock("~/lib/clipboard", () => ({ copyShortcodes: mocks.copyShortcodes }));

import { useListBulkActions } from "./useListBulkActions";

interface TestRow {
  id: string;
}

const rows = (...ids: string[]) =>
  ids.map((id) => ({ original: { id } })) as Row<TestRow>[];

const noop: BulkAction<TestRow> = {
  id: "delete",
  label: "Delete",
  onExecute: async () => ({ success: true }),
};

describe("useListBulkActions", () => {
  it("offers Copy codes on a shortcode entity with no other actions", () => {
    // `ledgerParty` has a shortcode but declares no entity actions, so it
    // isolates the generic half. Product is covered below, where the registry
    // contributes.
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({ entity: "ledgerParty" }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
    ]);
    // Copy alone is enough to earn the checkbox column — that's what turns
    // selection on for lists that have no bulk actions of their own.
    expect(result.current.enableRowSelection).toBe(true);
  });

  // The payoff of the registry: no product list asks for this action, and
  // every one of them offers it.
  it("adds the entity's declared actions without the list declaring them", () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({ entity: "product" }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
      "add-to-inventory",
    ]);
  });

  it("offers Copy codes for image now that it has a shortcode", () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({
        entity: "image",
        deleteBulkAction: noop,
      }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
      "delete",
    ]);
  });

  it("earns the checkbox column for image on Copy codes alone", () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({ entity: "image" }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
    ]);
    expect(result.current.enableRowSelection).toBe(true);
  });

  it("leads with Copy and trails with Delete", () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({
        entity: "task",
        bulkActions: {
          actions: [
            {
              id: "move",
              label: "Move",
              onExecute: async () => ({ success: true }),
            },
          ],
        },
        deleteBulkAction: noop,
      }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
      "move",
      "delete",
    ]);
  });

  it("copies the selected rows' ids and keeps the selection", async () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({ entity: "product" }),
    );

    const selected = rows("PRD-4K7M", "PRD-9X2A");
    act(() => {
      result.current.state.onRowSelectionChange({
        "PRD-4K7M": true,
        "PRD-9X2A": true,
      });
    });

    const copy = result.current.config?.actions[0];
    expect(copy).toBeDefined();
    await act(async () => {
      await result.current.state.executeAction(copy!, selected);
    });

    expect(mocks.copyShortcodes).toHaveBeenCalledWith(["PRD-4K7M", "PRD-9X2A"]);
    expect(result.current.state.selectedCount).toBe(2);
  });

  // The other half of `preserveSelection`: an action without it must still
  // clear. Asserting only the keep-side would let an inverted condition make
  // EVERY action sticky — including Delete, which would leave rows ticked that
  // no longer exist.
  it("still clears the selection for an action that does not preserve it", async () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({
        entity: "product",
        deleteBulkAction: noop,
      }),
    );

    act(() => {
      result.current.state.onRowSelectionChange({ "PRD-4K7M": true });
    });
    expect(result.current.state.selectedCount).toBe(1);

    await act(async () => {
      await result.current.state.executeAction(noop, rows("PRD-4K7M"));
    });

    expect(result.current.state.selectedCount).toBe(0);
  });
});
