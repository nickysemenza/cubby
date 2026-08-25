import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TableLayoutCustomizer from "./TableLayoutCustomizer";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";

type TestRow = Record<string, unknown>;

function layoutHarness() {
  let order = ["select", "image", "name", "trade", "actions"];
  // Mirrors what `normalizeTableLayout` produces: both structural ends pinned.
  const pinning: Record<string, false | "start" | "end"> = {
    select: "start",
    image: "start",
    name: false,
    trade: false,
    actions: "end",
  };
  const visibility = {
    select: true,
    image: true,
    name: true,
    trade: true,
    actions: true,
  };
  const table = {
    state: {
      get columnPinning() {
        return {
          start: order.filter((id) => pinning[id] === "start"),
          end: order.filter((id) => pinning[id] === "end"),
        };
      },
    },
    options: {
      meta: {
        defaultLayout: {
          version: 1,
          columnOrder: ["select", "image", "name", "trade", "actions"],
          columnPinning: { start: ["select", "image"], end: ["actions"] },
          columnVisibility: {
            select: true,
            image: true,
            name: true,
            trade: true,
            actions: true,
          },
          columnSizing: {},
        },
      },
    },
    setColumnOrder: vi.fn((next: string[]) => {
      order = next;
    }),
    setColumnPinning: vi.fn((next: { start?: string[]; end?: string[] }) => {
      for (const id of order) pinning[id] = false;
      for (const id of next.start ?? []) pinning[id] = "start";
      for (const id of next.end ?? []) pinning[id] = "end";
    }),
    setColumnVisibility: vi.fn(),
    setColumnSizing: vi.fn(),
  } as unknown as Table<TestRow>;

  const columns = Object.fromEntries(
    order.map((id) => [
      id,
      {
        id,
        table,
        columnDef: {
          header:
            id === "name"
              ? "Name"
              : id === "trade"
                ? "Trade"
                : id === "select"
                  ? "Select"
                  : id === "image"
                    ? "Image"
                    : "Actions",
        },
        getIsPinned: () => pinning[id] ?? false,
        pin: (region: false | "start" | "end") => {
          pinning[id] = region;
        },
        getCanHide: () => id === "name" || id === "trade",
        getIsVisible: () => visibility[id as keyof typeof visibility],
        toggleVisibility: () => {
          visibility[id as keyof typeof visibility] =
            !visibility[id as keyof typeof visibility];
        },
      } as unknown as Column<TestRow>,
    ]),
  );
  Object.assign(table, {
    getAllLeafColumns: () => order.map((id) => columns[id]!),
    getColumn: (id: string) => columns[id],
  });

  return { table, getOrder: () => order, pinning, visibility };
}

describe("TableLayoutCustomizer", () => {
  it("locks the structural columns at both ends", () => {
    const harness = layoutHarness();
    render(<TableLayoutCustomizer table={harness.table} />);

    for (const locked of ["Select", "Image", "Actions"]) {
      expect(
        screen.queryByRole("button", { name: `Drag ${locked}` }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: `Move ${locked} later` }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: `Move ${locked} earlier` }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: `Hide ${locked}` }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole("button", { name: "Unpin Image" }),
    ).not.toBeInTheDocument();
    // The pin controls are what previously let Actions leave the trailing edge.
    expect(
      screen.queryByRole("button", { name: "Unpin Actions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pin Actions to start" }),
    ).not.toBeInTheDocument();
    expect(harness.pinning.actions).toBe("end");

    expect(
      screen.getByRole("button", { name: "Drag Name" }),
    ).toBeInTheDocument();
  });

  it("offers accessible hide and exact reset commands", () => {
    const harness = layoutHarness();
    render(<TableLayoutCustomizer table={harness.table} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Name" }));
    expect(harness.visibility.name).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Restore default layout" }),
    );
    expect(harness.table.setColumnOrder).toHaveBeenLastCalledWith([
      "select",
      "image",
      "name",
      "trade",
      "actions",
    ]);
    expect(harness.table.setColumnPinning).toHaveBeenCalledWith({
      start: ["select", "image"],
      end: ["actions"],
    });
    expect(harness.table.setColumnVisibility).toHaveBeenCalledWith({
      select: true,
      image: true,
      name: true,
      trade: true,
      actions: true,
    });
    expect(harness.table.setColumnSizing).toHaveBeenCalledWith({});
  });

  it("moves a pinned column through the pinning array", () => {
    const harness = layoutHarness();
    harness.pinning.name = "start";
    harness.pinning.trade = "start";
    render(<TableLayoutCustomizer table={harness.table} />);

    fireEvent.click(screen.getByRole("button", { name: "Move Trade earlier" }));

    expect(harness.table.setColumnPinning).toHaveBeenCalledWith({
      start: ["select", "image", "trade", "name"],
      end: ["actions"],
    });
  });
});
