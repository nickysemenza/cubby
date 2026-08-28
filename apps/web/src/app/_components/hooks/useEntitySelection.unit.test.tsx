import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  canSelectEntityRecord,
  useEntitySelection,
} from "./useEntitySelection";

interface TestRow {
  id: string;
  projection: boolean;
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function BrowserWrapper({ children }: { children: ReactNode }) {
  const Wrapper = harness.wrapper;
  return <Wrapper>{children}</Wrapper>;
}

describe("useEntitySelection", () => {
  it("contributes the select column and the shared bar actions", () => {
    const { result } = renderHook(
      () => useEntitySelection<TestRow>({ entity: "task" }),
      { wrapper: BrowserWrapper },
    );

    expect(result.current.selectColumns.map((column) => column.id)).toEqual([
      "select",
    ]);
    expect(result.current.enableRowSelection).toBe(true);
    expect(result.current.selectedCount).toBe(0);
  });

  it("excludes projection rows before a bulk action can receive them", () => {
    const canSelect = (row: TestRow) => !row.projection;

    expect(
      canSelectEntityRecord(true, canSelect, {
        id: "TSK-1",
        projection: false,
      }),
    ).toBe(true);
    expect(
      canSelectEntityRecord(true, canSelect, {
        id: "TSK-2",
        projection: true,
      }),
    ).toBe(false);
  });

  it("renders no bar while nothing is selected", () => {
    const { result } = renderHook(
      () => useEntitySelection<TestRow>({ entity: "task" }),
      { wrapper: BrowserWrapper },
    );

    expect(result.current.renderBulkActionBar(null)).toBeNull();
  });

  it("enables selection for an inspect-only surface", () => {
    const { result } = renderHook(
      () =>
        useEntitySelection<TestRow>({
          entity: "task",
          onInspectRow: () => undefined,
        }),
      { wrapper: BrowserWrapper },
    );

    expect(result.current.selectColumns.map((column) => column.id)).toEqual([
      "select",
    ]);
    expect(result.current.enableRowSelection).toBe(true);
    expect(result.current.selectedCount).toBe(0);
  });
});
