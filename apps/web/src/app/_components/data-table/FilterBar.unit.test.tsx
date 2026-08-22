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

function openAddFilter() {
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
}

describe("FilterQueryStrip", () => {
  it("keeps deferred options dormant until their field is added", async () => {
    const onActivate = vi.fn();
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={[]}
        fields={[
          {
            key: "project",
            label: "Project",
            type: "multiselect",
            options: [],
            onActivate,
          },
        ]}
        onChange={onChange}
      />,
    );

    expect(onActivate).not.toHaveBeenCalled();
    openAddFilter();
    fireEvent.click(await screen.findByRole("button", { name: "Project" }));

    expect(onActivate).toHaveBeenCalledWith();
    expect(onChange).toHaveBeenCalledWith([
      {
        id: "filter-project",
        field: "project",
        operator: "is_any_of",
        values: [],
      },
    ]);
  });

  it("edits a filter by opening its compact label/value chip", async () => {
    const { onChange } = renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /status: open/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Filter Status" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: /done/i }));

    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["done"],
      },
    ]);
  });

  it("uses one remove affordance per chip and clears the whole query", () => {
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

    expect(
      screen.getAllByRole("button", { name: /^Remove .* filter$/ }),
    ).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Status filter" }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home", "urgent"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("surfaces an invalid entity filter as readable chip text", () => {
    renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: [UNRESOLVABLE_ENTITY_FILTER],
      },
    ]);

    expect(
      screen.getByRole("button", {
        name: /status: invalid link filter/i,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Remove Status filter" }),
    ).toBeVisible();
  });
});
