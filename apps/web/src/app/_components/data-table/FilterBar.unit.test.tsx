import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Filter, FilterBarField } from "./filter-bar-core";
import { FilterBar } from "./FilterBar";

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

function renderBar(
  filters: Filter[],
  props?: Partial<Parameters<typeof FilterBar>[0]>,
) {
  const onChange = vi.fn();
  const result = render(
    <FilterBar
      filters={filters}
      fields={fields}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange, ...result };
}

describe("FilterBar", () => {
  it("renders one chip per declared field, inactive ones reading 'any'", () => {
    renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);

    // "Name" has no active filter — its chip still exists, showing "any".
    expect(
      screen.getByRole("button", { name: "Name: any" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Status: Open" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Tags: any" }),
    ).toBeInTheDocument();
  });

  it("hydrates an active deferred filter before its editor is opened", () => {
    const onActivate = vi.fn();
    renderBar(
      [
        {
          id: "filter-crop",
          field: "crop",
          operator: "is_any_of",
          values: ["ING-C2YH"],
        },
      ],
      {
        fields: [
          {
            key: "crop",
            label: "Crop",
            type: "multiselect",
            options: [],
            onActivate,
          },
        ],
      },
    );

    expect(onActivate).toHaveBeenCalledWith(["ING-C2YH"]);
  });

  it("edits a text field's chip directly, with no separate add-filter step", () => {
    const { onChange } = renderBar([]);

    fireEvent.click(screen.getByRole("button", { name: "Name: any" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Name" }), {
      target: { value: "sink" },
    });

    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-name",
        field: "name",
        operator: "contains",
        values: ["sink"],
      },
    ]);
  });

  it("edits a single-select field's chip through a combobox", async () => {
    const { onChange } = renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
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

  it("edits a multiselect field's chip through a checklist with a Clear/Apply footer", async () => {
    const { onChange } = renderBar([]);

    fireEvent.click(screen.getByRole("button", { name: "Tags: any" }));
    fireEvent.click(await screen.findByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home"],
      },
    ]);
  });

  it("keeps category tree groups and depth while filtering and selecting", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={[]}
        onChange={onChange}
        fields={[
          {
            key: "category",
            label: "Category",
            type: "multiselect",
            options: [
              {
                value: "produce",
                label: "Produce",
                rowLabel: "Produce",
                group: { id: "food", label: "Food", order: 0 },
                depth: 0,
              },
              {
                value: "citrus",
                label: "Produce / Citrus",
                rowLabel: "Citrus",
                group: { id: "food", label: "Food", order: 0 },
                depth: 1,
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Category: any" }));
    expect(screen.getByText("Food")).toBeInTheDocument();
    const citrus = screen.getByRole("button", { name: "Produce / Citrus" });
    expect(citrus).toHaveStyle({ paddingInlineStart: "20px" });
    expect(citrus).toHaveTextContent("Citrus");
    fireEvent.click(citrus);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-category",
        field: "category",
        operator: "is_any_of",
        values: ["citrus"],
      },
    ]);
  });

  it("clears a single field from its own editor's Clear action", async () => {
    const { onChange } = renderBar([
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home", "urgent"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Tags:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("counts every active filter in 'Clear N' and clears them all", () => {
    const { onChange } = renderBar([
      {
        id: "filter-name",
        field: "name",
        operator: "contains",
        values: ["sink"],
      },
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);

    expect(screen.getByRole("button", { name: "Clear 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear 2" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("omits the Clear link entirely when nothing is active", () => {
    renderBar([]);
    expect(screen.queryByText(/^Clear/)).not.toBeInTheDocument();
  });

  it("caps visible chips at 3 and reveals the rest behind a ghost More", async () => {
    const manyFields: FilterBarField[] = [
      { key: "a", label: "A", type: "text" },
      { key: "b", label: "B", type: "text" },
      { key: "c", label: "C", type: "text" },
      { key: "d", label: "D", type: "text" },
      { key: "e", label: "E", type: "text" },
    ];
    const onChange = vi.fn();
    render(<FilterBar filters={[]} fields={manyFields} onChange={onChange} />);

    for (const key of ["A", "B", "C"]) {
      expect(
        screen.getByRole("button", { name: `${key}: any` }),
      ).toBeInTheDocument();
    }
    for (const key of ["D", "E"]) {
      expect(
        screen.queryByRole("button", { name: `${key}: any` }),
      ).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("button", { name: "E: any" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Filter E" }), {
      target: { value: "value" },
    });

    expect(onChange).toHaveBeenLastCalledWith([
      { id: "filter-e", field: "e", operator: "contains", values: ["value"] },
    ]);
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
      screen.getByRole("button", { name: /status: invalid link filter/i }),
    ).toBeVisible();
  });

  it("renders the declared search field as an input instead of a chip", () => {
    renderBar([], { searchKey: "name", searchPlaceholder: "Search products" });

    expect(
      screen.getByRole("textbox", { name: "Search products" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Name:/ }),
    ).not.toBeInTheDocument();
  });
});
