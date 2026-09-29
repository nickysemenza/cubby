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
import type { GroupConfig } from "./useGroupedList";

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

const groupConfig: GroupConfig<ListRow> = {
  field: "name",
  keyFn: (row) => row.name,
  colorFn: () => "#888",
};

function Screen({
  grouped,
  onGroupedChange,
  withGrouping = true,
}: {
  grouped: boolean;
  onGroupedChange: (value: boolean) => void;
  withGrouping?: boolean;
}) {
  const table = useCubbyTable({
    data: [{ id: "row-1", name: "Only row" }],
    columns: materializeCubbyColumns(columns),
    getRowId: (row) => row.id,
    enableRowSelection: false,
  });
  return (
    <MobileListScreen
      table={table}
      groupConfig={withGrouping ? groupConfig : undefined}
      grouped={grouped}
      onGroupedChange={withGrouping ? onGroupedChange : undefined}
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

// The phone band carries only view seg, search and Filter. Grouping stays
// reachable as a row in the Filter sheet, so folding it there cannot strand a
// list whose only phone affordance was the old icon button.
describe("phone grouping", () => {
  it("has no grouped icon button in the band and toggles from the Filter sheet", async () => {
    const onGroupedChange = vi.fn();
    render(<Screen grouped={false} onGroupedChange={onGroupedChange} />, {
      wrapper: harness.wrapper,
    });

    expect(
      screen.queryByRole("button", { name: "Show grouped list" }),
    ).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /^Filter/ }));
    const row = await screen.findByRole("switch", { name: "Grouped" });
    expect(row).toHaveAttribute("aria-checked", "false");
    fireEvent.click(row);
    expect(onGroupedChange).toHaveBeenCalledWith(true);
  });

  it("shows the current state and turns grouping off again", async () => {
    const onGroupedChange = vi.fn();
    render(<Screen grouped onGroupedChange={onGroupedChange} />, {
      wrapper: harness.wrapper,
    });

    fireEvent.click(await screen.findByRole("button", { name: /^Filter/ }));
    const row = await screen.findByRole("switch", { name: "Grouped" });
    expect(row).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row);
    expect(onGroupedChange).toHaveBeenCalledWith(false);
  });

  it("offers no Grouped row when the list declares no grouping", async () => {
    render(
      <Screen grouped={false} onGroupedChange={vi.fn()} withGrouping={false} />,
      { wrapper: harness.wrapper },
    );
    // Nothing to filter, sort or group: the band has no Filter trigger at all.
    expect(await screen.findByText("Only row")).toBeVisible();
    expect(
      screen.queryByRole("switch", { name: "Grouped" }),
    ).not.toBeInTheDocument();
  });
});
