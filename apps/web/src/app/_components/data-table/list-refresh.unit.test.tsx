import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { MobileListScreen } from "./MobileListScreen";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "./table-features";

interface ListRow {
  id: string;
  name: string;
}

const helper = createCubbyColumnHelper<ListRow>();
const columns = createCubbyColumnCollection<ListRow>((add) => {
  add(
    helper.accessor("name", {
      header: "Name",
      meta: { mobile: { slot: "title" } },
    }),
  );
});

function ListScreen({
  rows,
  error,
  onRefresh,
}: {
  rows: ListRow[];
  error?: Error;
  onRefresh: () => Promise<void>;
}) {
  const table = useCubbyTable({
    data: rows,
    columns: materializeCubbyColumns(columns),
    getRowId: (row) => row.id,
    enableRowSelection: false,
  });

  return (
    <MobileListScreen
      table={table}
      error={error}
      refreshControls={{ onRefresh, isRefreshing: false }}
      emptyState={<span>Empty success</span>}
      showToolbar={false}
    />
  );
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  class TestIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
});

describe("MobileListScreen refresh failures", () => {
  it("retains loaded rows and offers Retry after a refresh failure", async () => {
    const onRefresh = vi.fn(async () => {});

    render(
      <ListScreen
        rows={[{ id: "row-1", name: "Retained row" }]}
        error={new Error("Refresh failed")}
        onRefresh={onRefresh}
      />,
      { wrapper: harness.wrapper },
    );

    expect(await screen.findByText("Retained row")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("does not present an empty-success state for an initial failed load", async () => {
    render(
      <ListScreen
        rows={[]}
        error={new Error("Initial load failed")}
        onRefresh={async () => {}}
      />,
      { wrapper: harness.wrapper },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Initial load failed",
    );
    expect(screen.queryByText("Empty success")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
  });
});
