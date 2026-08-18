import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";
import type { Filter, FilterBarField } from "./filter-bar-core";

const fields: FilterBarField[] = [
  { key: "name", label: "Name", type: "text" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "open", label: "Open", hint: "3 items" },
      { value: "done", label: "Done" },
    ],
  },
  {
    key: "tags",
    label: "Tags",
    type: "multiselect",
    options: [
      { value: "home", label: "Home" },
      { value: "urgent", label: "Urgent" },
    ],
  },
];

function renderBar(filters: Filter[]) {
  const onChange = vi.fn();
  const result = render(
    <FilterBar filters={filters} fields={fields} onChange={onChange} />,
  );
  return { onChange, ...result };
}

describe("FilterBar", () => {
  it("adds searchable select fields and preserves facet hints", async () => {
    const { onChange, rerender } = renderBar([]);

    const addFilter = screen.getByRole("combobox", { name: "Add filter" });
    expect(addFilter).toHaveAccessibleName("Add filter");
    fireEvent.change(addFilter, { target: { value: "status" } });

    expect(onChange).toHaveBeenCalledWith([
      { id: "filter-status", field: "status", operator: "is", values: [] },
    ]);

    rerender(
      <FilterBar
        filters={[
          {
            id: "filter-status",
            field: "status",
            operator: "is",
            values: [],
          },
        ]}
        fields={fields}
        onChange={onChange}
      />,
    );
    const status = screen.getByRole("combobox", { name: "Filter Status" });
    fireEvent.click(screen.getByRole("button", { name: "Open Filter Status" }));
    fireEvent.change(status, { target: { value: "ope" } });
    const openOption = await screen.findByRole("option", {
      name: /open.*3 items/i,
    });
    fireEvent.click(openOption);
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);
  });

  it("immediately clears select and multiselect values without removing their chips", () => {
    const { onChange } = renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home", "urgent"],
      },
    ]);

    const clearButtons = screen.getAllByRole("button", {
      name: "Clear filter",
    });
    fireEvent.click(clearButtons[0]!);
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: [],
      },
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home", "urgent"],
      },
    ]);

    fireEvent.click(clearButtons[1]!);
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: [],
      },
    ]);
  });

  it("surfaces an invalid entity link filter instead of rendering a blank value", () => {
    renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: [UNRESOLVABLE_ENTITY_FILTER],
      },
    ]);

    expect(screen.getByRole("combobox", { name: "Filter Status" })).toHaveValue(
      "Invalid link filter",
    );
    expect(
      screen.getByRole("button", { name: "Remove Status filter" }),
    ).toBeVisible();
  });
});
