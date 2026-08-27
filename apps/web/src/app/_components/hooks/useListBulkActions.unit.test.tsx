import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BulkAction } from "../data-table/bulk-actions.types";
import type { CubbyRow as Row } from "../data-table/table-features";

const mocks = vi.hoisted(() => ({
  copyShortcodes: vi.fn(async () => true),
  copyIdentifiers: vi.fn(async () => true),
  navigate: vi.fn(async () => undefined),
}));

vi.mock("~/lib/clipboard", () => ({
  copyShortcodes: mocks.copyShortcodes,
  copyIdentifiers: mocks.copyIdentifiers,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

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

// The product entry's action resolves product detail to derive its kit
// warning, so resolving the registry needs a client. The app always has one.
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

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
      "print-labels",
      "set-stock-tracking",
    ]);
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
    expect(mocks.copyIdentifiers).toHaveBeenCalledWith(["12345", "67890"]);
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
      "print-labels",
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

    expect(mocks.copyShortcodes).toHaveBeenCalledWith(["PRD-4K7M", "PRD-9X2A"]);
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
