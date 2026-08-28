import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CubbyRow as Row } from "../data-table/table-features";

vi.mock("~/lib/clipboard", () => ({ copyShortcodes: vi.fn(async () => true) }));

import { useEntitySelection } from "./useEntitySelection";

interface TestRow {
  id: string;
  projection: boolean;
}

const row = (id: string, projection = false) =>
  ({ original: { id, projection } }) as Row<TestRow>;

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

describe("useEntitySelection", () => {
  it("contributes the select column and the shared bar actions", () => {
    const { result } = renderHook(
      () => useEntitySelection<TestRow>({ entity: "task" }),
      { wrapper },
    );

    expect(result.current.selectColumns.map((c) => c.id)).toEqual(["select"]);
    expect(result.current.enableRowSelection).toBe(true);
    expect(result.current.selectedCount).toBe(0);
  });

  // The reason the predicate exists: a projection sub-row is not a record, so
  // it must not enter a selection the bulk actions will run against.
  it("composes an exclusion predicate with the selection being enabled at all", () => {
    const { result } = renderHook(
      () =>
        useEntitySelection<TestRow>({
          entity: "task",
          canSelectRow: (r) => !r.projection,
        }),
      { wrapper },
    );

    const canSelect = result.current.enableRowSelection;
    expect(typeof canSelect).toBe("function");
    if (typeof canSelect !== "function") return;
    expect(canSelect(row("TSK-1"))).toBe(true);
    expect(canSelect(row("TSK-2", true))).toBe(false);
  });

  it("renders no bar while nothing is selected", () => {
    const { result } = renderHook(
      () => useEntitySelection<TestRow>({ entity: "task" }),
      { wrapper },
    );

    // The table is only read once rows are selected, so the empty case never
    // touches it.
    expect(result.current.renderBulkActionBar(null as never)).toBeNull();
  });

  it("enables selection for an inspect-only surface", () => {
    const onInspectRow = vi.fn();
    const { result } = renderHook(
      () => useEntitySelection<TestRow>({ entity: "task", onInspectRow }),
      { wrapper },
    );

    expect(result.current.selectColumns.map((column) => column.id)).toEqual([
      "select",
    ]);
    expect(result.current.enableRowSelection).toBe(true);
    expect(result.current.selectedCount).toBe(0);
  });
});
