import type { Row } from "@tanstack/react-table";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BulkAction } from "../data-table/bulk-actions.types";

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
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({ entity: "product" }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
    ]);
    // Copy alone is enough to earn the checkbox column — that's what turns
    // selection on for lists that have no bulk actions of their own.
    expect(result.current.enableRowSelection).toBe(true);
  });

  // `image` is the one entity whose row id stays a uuid, and a uuid must never
  // reach a clipboard the user pastes into MCP.
  it("omits Copy codes for image", () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({
        entity: "image",
        deleteBulkAction: noop,
      }),
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual(["delete"]);
  });

  it("has no config at all for image with nothing else to offer", () => {
    const { result } = renderHook(() =>
      useListBulkActions<TestRow>({ entity: "image" }),
    );

    expect(result.current.config).toBeUndefined();
    expect(result.current.enableRowSelection).toBe(false);
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
});
