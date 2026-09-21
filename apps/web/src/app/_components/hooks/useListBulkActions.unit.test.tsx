import { act, cleanup, renderHook } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  EntityActionClipboardProvider,
  type EntityActionClipboardPort,
} from "../actions/entity-actions";
import type { BulkAction } from "../data-table/bulk-actions.types";
import type { CubbyRow as Row } from "../data-table/table-features";
import { useListBulkActions } from "./useListBulkActions";

interface TestRow {
  id: string;
  fieldResolutions?: unknown;
}

const rows = (...ids: string[]) =>
  ids.map((id) => fromPartial<Row<TestRow>>({ original: { id } }));

const noop: BulkAction<TestRow> = {
  id: "delete",
  label: "Delete",
  onExecute: async () => ({ success: true }),
};

let harness: ReturnType<typeof createBrowserTestHarness>;
let copiedShortcodes: string[][];
let copiedIdentifiers: string[][];
let clipboard: EntityActionClipboardPort;

beforeEach(() => {
  harness = createBrowserTestHarness();
  copiedShortcodes = [];
  copiedIdentifiers = [];
  clipboard = {
    copyShortcodes: async (codes) => {
      copiedShortcodes.push([...codes]);
      return true;
    },
    copyIdentifiers: async (ids) => {
      copiedIdentifiers.push([...ids]);
      return true;
    },
  };
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

function wrapper({ children }: { children: ReactNode }) {
  const BrowserProviders = harness.wrapper;
  return (
    <BrowserProviders>
      <EntityActionClipboardProvider port={clipboard}>
        {children}
      </EntityActionClipboardProvider>
    </BrowserProviders>
  );
}

describe("useListBulkActions", () => {
  it("offers Copy codes on a shortcode entity with no other actions", () => {
    // `ledgerParty` has a shortcode but declares no entity actions, so it
    // isolates the generic half. Product is covered below, where the registry
    // contributes.
    const { result } = renderHook(
      () => useListBulkActions<TestRow>({ entity: "ledgerParty" }),
      { wrapper },
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
    const { result } = renderHook(
      () => useListBulkActions<TestRow>({ entity: "product" }),
      { wrapper },
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
      "add-to-inventory",
      "merge",
      "enrich-products",
      "print-labels",
      "bulk-edit",
      "set-stock-tracking",
    ]);
  });

  it("offers redundant override cleanup only when a selected row can reset", () => {
    const { result } = renderHook(
      () => useListBulkActions<TestRow>({ entity: "project" }),
      { wrapper },
    );
    const action = result.current.config?.actions.find(
      (candidate) => candidate.id === "use-inherited-values",
    );
    expect(action).toBeDefined();
    expect(action?.availability?.(rows("PRJ-PLAIN"))).toEqual({
      status: "hidden",
    });
    const redundant = fromPartial<Row<TestRow>>({
      original: {
        id: "PRJ-REDUNDANT",
        fieldResolutions: {
          locations: {
            mode: "explicit",
            storedValue: ["Main house"],
            value: ["Main house"],
            fallbackValue: ["Main house"],
            source: "Parent project",
            sourceEntity: null,
            matchesFallback: true,
            canReset: true,
          },
        },
      },
    });
    expect(action?.availability?.([redundant])).toEqual({
      status: "available",
    });
  });

  it("offers Copy codes for image now that it has a shortcode", () => {
    const { result } = renderHook(
      () =>
        useListBulkActions<TestRow>({
          entity: "image",
          deleteBulkAction: noop,
        }),
      { wrapper },
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
      "delete",
    ]);
  });

  it("earns the checkbox column for image on Copy codes alone", () => {
    const { result } = renderHook(
      () => useListBulkActions<TestRow>({ entity: "image" }),
      { wrapper },
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
    ]);
    expect(result.current.enableRowSelection).toBe(true);
  });

  it("copies USDA external identifiers with their truthful label", async () => {
    const { result } = renderHook(
      () => useListBulkActions<TestRow>({ entity: "usda-food" }),
      { wrapper },
    );

    expect(result.current.config?.actions.map((action) => action.id)).toEqual([
      "copy-identifiers",
    ]);
    const selected = rows("12345", "67890");
    const action = result.current.config?.actions[0];
    await act(async () => {
      await result.current.state.executeAction(action!, selected);
    });
    expect(copiedIdentifiers).toEqual([["12345", "67890"]]);
  });

  it("leads with Copy and trails with Delete", () => {
    const { result } = renderHook(
      () =>
        useListBulkActions<TestRow>({
          entity: "location",
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
      { wrapper },
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "copy-shortcodes",
      "print-location-labels",
      "move-location-under",
      "bulk-edit",
      "move",
      "delete",
    ]);
  });

  it("puts Inspect first and limits it to one selected record", async () => {
    const inspect = vi.fn();
    const { result } = renderHook(
      () =>
        useListBulkActions<TestRow>({
          entity: "product",
          onInspectRow: inspect,
        }),
      { wrapper },
    );

    expect(result.current.config?.actions.map((a) => a.id)).toEqual([
      "inspect",
      "copy-shortcodes",
      "add-to-inventory",
      "merge",
      "enrich-products",
      "print-labels",
      "bulk-edit",
      "set-stock-tracking",
    ]);
    expect(
      result.current.state
        .getAvailableActions(rows("PRD-4K7M", "PRD-9X2A"))
        .map((action) => action.id),
    ).not.toContain("inspect");

    const selected = rows("PRD-4K7M");
    const action = result.current.config?.actions[0];
    expect(action).toBeDefined();
    await act(async () => {
      result.current.state.onRowSelectionChange({ "PRD-4K7M": true });
      await result.current.state.executeAction(action!, selected);
    });

    expect(inspect).toHaveBeenCalledWith(selected[0]);
    expect(result.current.state.selectedCount).toBe(1);
  });

  it("lets an embedded specialist table opt out of canonical catalog actions", () => {
    const { result } = renderHook(
      () =>
        useListBulkActions<TestRow>({
          entity: "inventory",
          includeCatalogActions: false,
          bulkActions: {
            actions: [
              {
                id: "embedded-move",
                label: "Move",
                onExecute: async () => ({ success: true }),
              },
            ],
          },
        }),
      { wrapper },
    );

    expect(result.current.config?.actions.map((action) => action.id)).toEqual([
      "embedded-move",
    ]);
  });

  it("copies the selected rows' ids and keeps the selection", async () => {
    const { result } = renderHook(
      () => useListBulkActions<TestRow>({ entity: "product" }),
      { wrapper },
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

    expect(copiedShortcodes).toEqual([["PRD-4K7M", "PRD-9X2A"]]);
    expect(result.current.state.selectedCount).toBe(2);
  });

  // The other half of `preserveSelection`: an action without it must still
  // clear. Asserting only the keep-side would let an inverted condition make
  // EVERY action sticky — including Delete, which would leave rows ticked that
  // no longer exist.
  it("still clears the selection for an action that does not preserve it", async () => {
    const { result } = renderHook(
      () =>
        useListBulkActions<TestRow>({
          entity: "product",
          deleteBulkAction: noop,
        }),
      { wrapper },
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
