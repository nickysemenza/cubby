import type { Column } from "@tanstack/react-table";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterConfig } from "./columnHelpers";
import { HeaderFilter } from "./HeaderFilter";

/**
 * Minimal stand-in for the TanStack column API `HeaderFilter` touches. Holds
 * the filter value so the component's write-back can be read straight off it,
 * the way the real table would.
 */
function makeColumn(initial?: unknown) {
  let filterValue: unknown = initial;
  const setFilterValue = vi.fn((next: unknown) => {
    filterValue = next;
  });
  return {
    column: {
      getFilterValue: () => filterValue,
      setFilterValue,
      getFacetedUniqueValues: () => new Map<string, number>(),
    } as unknown as Column<unknown, unknown>,
    setFilterValue,
    read: () => filterValue,
  };
}

const MULTI: FilterConfig = {
  placeholder: "Filter by tag...",
  filterType: "multiselect",
  options: [
    { value: "bread", label: "bread" },
    { value: "chicken", label: "chicken" },
  ],
};

const SELECT: FilterConfig = {
  placeholder: "Filter by trade...",
  filterType: "select",
  options: [
    { value: "drywall", label: "Drywall" },
    { value: "plumbing", label: "Plumbing" },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

/** HeaderFilter debounces writes by 500ms. */
const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
};

describe("HeaderFilter multiselect", () => {
  it("renders the collapsed summary as `first +N`", () => {
    const { column } = makeColumn(["bread", "chicken"]);
    render(<HeaderFilter column={column} filterConfig={MULTI} />);
    expect(screen.getByPlaceholderText("tag")).toHaveValue("bread +1");
  });

  it("shows just the label for a single selection", () => {
    const { column } = makeColumn(["bread"]);
    render(<HeaderFilter column={column} filterConfig={MULTI} />);
    expect(screen.getByPlaceholderText("tag")).toHaveValue("bread");
  });

  it("normalizes a scalar filter value up into a selection", () => {
    // A URL seed or a pivot-click can write a scalar into a multi column.
    const { column } = makeColumn("bread");
    render(<HeaderFilter column={column} filterConfig={MULTI} />);
    expect(screen.getByPlaceholderText("tag")).toHaveValue("bread");
  });

  it("clears to undefined, never an empty array", async () => {
    // `[] || undefined` is `[]` — leaving it in columnFilters would keep the
    // toolbar's Reset visible forever and make client tables drop every row.
    const { column, setFilterValue, read } = makeColumn(["bread"]);
    render(<HeaderFilter column={column} filterConfig={MULTI} />);

    fireEvent.click(screen.getByRole("button", { name: /clear filter/i }));
    await settle();

    expect(setFilterValue).toHaveBeenCalledWith(undefined);
    expect(read()).toBeUndefined();
  });

  it("accumulates selections instead of replacing them", async () => {
    const { column, read } = makeColumn(undefined);
    render(<HeaderFilter column={column} filterConfig={MULTI} />);

    fireEvent.click(screen.getByRole("button", { name: /open tag/i }));
    fireEvent.click(await screen.findByRole("option", { name: "bread" }));
    await settle();
    expect(read()).toEqual(["bread"]);

    fireEvent.click(screen.getByRole("option", { name: "chicken" }));
    await settle();
    expect(read()).toEqual(["bread", "chicken"]);

    // Picking an already-selected value toggles it back off.
    fireEvent.click(screen.getByRole("option", { name: "bread" }));
    await settle();
    expect(read()).toEqual(["chicken"]);
  });

  it("does not re-render forever when the value is an array", async () => {
    // The empty fallback must be a stable constant: a fresh `[]` per render
    // makes the external-change check (a reference compare) always true, which
    // sets state during render — "Too many re-renders".
    const { column } = makeColumn([]);
    const renderSpy = vi.fn();
    function Probe() {
      renderSpy();
      return <HeaderFilter column={column} filterConfig={MULTI} />;
    }
    render(<Probe />);
    await settle();
    expect(renderSpy.mock.calls.length).toBeLessThan(5);
  });
});

describe("HeaderFilter single select", () => {
  it("clears back to unfiltered", async () => {
    const { column, setFilterValue } = makeColumn("drywall");
    render(<HeaderFilter column={column} filterConfig={SELECT} />);

    expect(screen.getByPlaceholderText("trade")).toHaveValue("Drywall");
    fireEvent.click(screen.getByRole("button", { name: /clear filter/i }));
    await settle();

    expect(setFilterValue).toHaveBeenCalledWith(undefined);
  });

  it("has no clear button when nothing is selected", () => {
    const { column } = makeColumn(undefined);
    render(<HeaderFilter column={column} filterConfig={SELECT} />);
    expect(
      screen.queryByRole("button", { name: /clear filter/i }),
    ).not.toBeInTheDocument();
  });
});
