import { FILTER_NOT_PREFIX } from "@cubby/schemas/filter-sentinel-fields";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  FILTER_ALL,
  FILTER_ANY,
  FILTER_EXACT,
  FILTER_NONE,
} from "~/entity/filters";

import { FilterBar, filterSummary } from "./filter-bar";
import {
  type Filter,
  type FilterBarField,
  nextPickedValues,
  selectedValues,
} from "./filter-bar-core";

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

/** Holds filters like a real owner, so live edits re-render the bar. */
function StatefulBar({
  initial = [],
  onChange,
  ...props
}: Omit<Parameters<typeof FilterBar>[0], "filters" | "onChange"> & {
  initial?: Filter[];
  onChange: (filters: Filter[]) => void;
}) {
  const [filters, setFilters] = useState(initial);
  return (
    <FilterBar
      {...props}
      filters={filters}
      onChange={(next) => {
        onChange(next);
        setFilters(next);
      }}
    />
  );
}

const openPanel = () =>
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));

describe("FilterBar", () => {
  it("edits both sides of a rosterless multiselect without losing either", async () => {
    const onChange = vi.fn();
    render(
      <StatefulBar
        fields={[
          {
            key: "field",
            label: "Field",
            type: "multiselect",
            freeText: true,
            exclude: true,
          },
        ]}
        onChange={onChange}
        editRequest={{ key: "field" }}
        initial={[
          {
            id: "field",
            field: "field",
            operator: "is_any_of",
            values: ["name", `${FILTER_NOT_PREFIX}model`],
          },
        ]}
      />,
    );
    const input = await screen.findByRole("textbox", { name: "Filter Field" });
    expect(input).toHaveValue("name");
    fireEvent.click(screen.getByRole("button", { name: "is not" }));
    expect(input).toHaveValue("model");
    fireEvent.change(input, { target: { value: "model, barcode" } });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        field: "field",
        values: [
          "name",
          `${FILTER_NOT_PREFIX}model`,
          `${FILTER_NOT_PREFIX}barcode`,
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "is" }));
    expect(input).toHaveValue("name");
  });

  // Failure modes: an inactive filter rendered as a chip ("any" noise); an
  // edit that waits for Apply; the panel losing the active filters' place.
  it("shows only active filters as chips and reaches the rest through the panel", async () => {
    const { onChange } = renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);
    expect(screen.getByRole("button", { name: "Status: Open" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Name/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Filters" })).toHaveTextContent(
      "Filter1",
    );

    openPanel();
    expect(await screen.findByText("Active · 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Name" }), {
      target: { value: "brush" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ field: "status", values: ["open"] }),
        expect.objectContaining({ field: "name", values: ["brush"] }),
      ]),
    );
  });

  it("finds a filter by label", async () => {
    renderBar([]);
    openPanel();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Find a filter" }),
      {
        target: { value: "tag" },
      },
    );
    expect(screen.getByRole("button", { name: "Tags" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Name" })).toBeNull();
  });

  it("keeps the open row in place while its first edit activates it", async () => {
    const onChange = vi.fn();
    render(<StatefulBar fields={fields} onChange={onChange} />);
    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Name" }));
    const input = screen.getByRole("textbox", { name: "Filter Name" });
    fireEvent.change(input, { target: { value: "s" } });
    // Same element: the row did not jump into Active and remount its editor.
    expect(screen.getByRole("textbox", { name: "Filter Name" })).toBe(input);
    expect(screen.getByRole("region", { name: "Filter Name" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All filters" }));
    expect(screen.getAllByRole("button", { name: "Name: s" })).toHaveLength(2);
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

  it("edits a single-select chip through its own popover", async () => {
    const { onChange } = renderBar([
      {
        id: "filter-status",
        field: "status",
        operator: "is",
        values: ["open"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Status: Open" }));
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

  it("keeps a chip's editor open after unpicking its last value", async () => {
    const onChange = vi.fn();
    render(
      <StatefulBar
        fields={fields}
        onChange={onChange}
        initial={[
          {
            id: "filter-tags",
            field: "tags",
            operator: "is_any_of",
            values: ["home"],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tags: Home" }));
    fireEvent.click(await screen.findByRole("option", { name: "Home" }));
    fireEvent.click(screen.getByRole("option", { name: "Urgent" }));

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ field: "tags", values: ["urgent"] }),
    ]);
  });

  it("applies each checklist pick as it is made", async () => {
    const { onChange } = renderBar([]);

    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Tags" }));
    fireEvent.click(await screen.findByRole("option", { name: "Home" }));

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home"],
      },
    ]);
  });

  it("offers Any, Yes and No for a boolean filter", async () => {
    const { onChange } = renderBar([], {
      fields: [
        {
          key: "archived",
          label: "Archived",
          type: "select",
          valueType: "boolean",
          options: [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ],
        },
      ],
    });
    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "No" }));
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ field: "archived", values: ["false"] }),
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

    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Category" }));
    expect(await screen.findByText("Food")).toBeInTheDocument();
    const citrus = screen.getByRole("option", { name: "Produce / Citrus" });
    // Depth indents the tree row; the row reads its own label.
    expect(citrus).toHaveStyle({ paddingLeft: "18px" });
    expect(citrus).toHaveTextContent("Citrus");
    fireEvent.click(citrus);
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "filter-category",
        field: "category",
        operator: "is_any_of",
        values: ["citrus"],
      },
    ]);
  });

  it("clears one filter from its chip's ×", () => {
    const { onChange } = renderBar([
      {
        id: "filter-tags",
        field: "tags",
        operator: "is_any_of",
        values: ["home", "urgent"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Clear Tags filter" }));

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("clears every filter, the search text included", () => {
    const { onChange } = renderBar(
      [
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
        {
          id: "filter-tags",
          field: "tags",
          operator: "is_any_of",
          values: ["home"],
        },
      ],
      { searchKey: "name" },
    );

    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("omits Clear entirely when nothing is active", () => {
    renderBar([]);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("opens the panel on a requested field's editor", async () => {
    const { rerender, onChange } = renderBar([]);
    rerender(
      <FilterBar
        filters={[]}
        fields={fields}
        onChange={onChange}
        editRequest={{ key: "tags" }}
      />,
    );
    expect(
      await screen.findByRole("region", { name: "Filter Tags" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Home" })).toBeInTheDocument();
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

  it("renders the declared search field as an input instead of a filter", async () => {
    renderBar([], { searchKey: "name", searchPlaceholder: "Search products" });

    expect(
      screen.getByRole("textbox", { name: "Search products" }),
    ).toBeInTheDocument();
    openPanel();
    await screen.findByRole("button", { name: "Tags" });
    expect(screen.queryByRole("button", { name: /^Name/ })).toBeNull();
  });

  it("offers Match all only on a multi-valued field and applies it", async () => {
    const single = renderBar([]);
    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Tags" }));
    await screen.findByRole("option", { name: "Home" });
    expect(screen.queryByRole("button", { name: "Match all" })).toBeNull();
    single.unmount();

    const onChange = vi.fn();
    render(
      <StatefulBar
        fields={[{ ...fields[2]!, matchAll: true }]}
        onChange={onChange}
      />,
    );
    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Tags" }));
    fireEvent.click(await screen.findByRole("option", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Match all" }));

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ field: "tags", values: ["home", FILTER_ALL] }),
    ]);
  });
});

describe("filterSummary", () => {
  const tags = fields[2]!;
  const chip = (values: string[]) =>
    filterSummary(tags, {
      id: "filter-tags",
      field: "tags",
      operator: "is_any_of",
      values,
    });

  it("joins values with or, and with and under Match all", () => {
    expect(chip(["home", "urgent"])).toBe("Home or Urgent");
    expect(chip(["home", "urgent", FILTER_ALL])).toBe("Home and Urgent");
  });

  it("reads Any value as has a value only while active", () => {
    expect(chip([FILTER_ANY])).toBe("has a value");
    expect(filterSummary(tags, undefined)).toBe("");
  });

  it("names No value beside picked values", () => {
    expect(chip([FILTER_NONE])).toBe("no value");
    expect(chip(["home", FILTER_NONE])).toBe("Home or no value");
  });

  it("treats a lone mode token as inactive", () => {
    expect(chip([FILTER_ALL])).toBe("");
    expect(chip([FILTER_EXACT])).toBe("");
  });
});

describe("nextPickedValues", () => {
  it("lets Any value clear picked values and a pick clear Any value", () => {
    expect(
      nextPickedValues(["home", FILTER_ALL], ["home", FILTER_ANY]),
    ).toEqual([FILTER_ANY, FILTER_ALL]);
    expect(nextPickedValues([FILTER_ANY], [FILTER_ANY, "home"])).toEqual([
      "home",
    ]);
    expect(nextPickedValues(["home"], ["home", FILTER_NONE])).toEqual([
      "home",
      FILTER_NONE,
    ]);
  });
});

describe("selectedValues", () => {
  it("loads excluded ids unprefixed beside included ones", () => {
    // A deferred roster matches literal ids; a prefixed one would leave the
    // "is not" chip showing a bare shortcode after a reload.
    expect(
      selectedValues(["home", FILTER_EXACT, `${FILTER_NOT_PREFIX}attic`]),
    ).toEqual(["home", "attic"]);
  });
});

describe("range bounds editors", () => {
  const rangeFields: FilterBarField[] = [
    {
      key: "age",
      label: "Age",
      type: "select",
      numberRange: { nonnegative: true },
      options: [
        { value: "2", label: "2+" },
        { value: "5", label: "5+" },
      ],
    },
    {
      key: "made",
      label: "Made",
      type: "select",
      dateRange: true,
      options: [{ value: "30d", label: "Last 30 days" }],
    },
  ];
  const filterOf = (field: string, value: string): Filter[] => [
    { id: `filter-${field}`, field, operator: "is", values: [value] },
  ];
  const renderRanges = (filters: Filter[]) => {
    const onChange = vi.fn();
    const view = render(
      <FilterBar filters={filters} fields={rangeFields} onChange={onChange} />,
    );
    const rerender = (next: Filter[]) =>
      view.rerender(
        <FilterBar filters={next} fields={rangeFields} onChange={onChange} />,
      );
    return { onChange, rerender };
  };
  const input = (name: string) =>
    screen.getByRole<HTMLInputElement>("textbox", { name });

  // Failure mode: the bounds editor read its value once, so a value changed
  // while it was open (Back/Forward, a deep link) left stale inputs, and the
  // next edit wrote the stale side back over the restored one.
  it("follows a number range value changed from outside", () => {
    const { onChange, rerender } = renderRanges(filterOf("age", "1..8"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 1 to 8" }));
    rerender(filterOf("age", "5"));
    expect(input("Age minimum").value).toBe("");
    rerender(filterOf("age", "2..10"));
    expect(input("Age minimum").value).toBe("2");
    expect(input("Age maximum").value).toBe("10");
    fireEvent.change(input("Age maximum"), { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith(filterOf("age", "2..12"));
  });

  it("keeps an uncommitted number draft across an unchanged rerender", () => {
    const { onChange, rerender } = renderRanges(filterOf("age", "1..8"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 1 to 8" }));
    fireEvent.change(input("Age minimum"), { target: { value: "-3" } });
    expect(onChange).not.toHaveBeenCalled();
    rerender(filterOf("age", "1..8"));
    expect(input("Age minimum").value).toBe("-3");
    fireEvent.change(input("Age minimum"), { target: { value: "1.50" } });
    rerender(filterOf("age", "1.5..8"));
    expect(input("Age minimum").value).toBe("1.50");
  });

  it("follows a date range value changed from outside", () => {
    const { onChange, rerender } = renderRanges(
      filterOf("made", "2026-01-01..2026-02-01"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Made: 2026-01-01 to 2026-02-01$/ }),
    );
    rerender(filterOf("made", "30d"));
    expect(screen.queryByLabelText("From date")).toBeNull();
    rerender(filterOf("made", "2026-03-01..2026-04-01"));
    expect(screen.getByLabelText<HTMLInputElement>("From date").value).toBe(
      "2026-03-01",
    );
    fireEvent.change(screen.getByLabelText("To date"), {
      target: { value: "2026-04-15" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      filterOf("made", "2026-03-01..2026-04-15"),
    );
  });

  // Failure mode: a number input reports incomplete text (`-`, `1e`) as an
  // empty value, so typing it silently cleared an active bound.
  it("rejects incomplete number text instead of clearing the bound", () => {
    const { onChange } = renderRanges(filterOf("age", "1..8"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 1 to 8" }));
    for (const text of ["-", "1e"]) {
      fireEvent.change(input("Age minimum"), { target: { value: text } });
      expect(input("Age minimum").value).toBe(text);
      expect(input("Age minimum")).toHaveAttribute("aria-invalid", "true");
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  // Failure mode: a preset passed no bounds to the editor, so switching
  // between presets never reset it and a stale invalid draft blocked edits.
  it("starts over when one preset replaces another", () => {
    const { onChange, rerender } = renderRanges(filterOf("age", "5"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 5+" }));
    fireEvent.change(input("Age minimum"), { target: { value: "-3" } });
    rerender(filterOf("age", "2"));
    expect(input("Age minimum").value).toBe("");
    fireEvent.change(input("Age maximum"), { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith(filterOf("age", "..12"));
  });

  // Failure mode: only the last emission was remembered, so a parent's
  // delayed echo of an earlier one rolled the typed minimum back.
  it("keeps typed text through a lagging parent's echoes", () => {
    const { onChange, rerender } = renderRanges(filterOf("age", "1..80"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 1 to 80" }));
    fireEvent.change(input("Age minimum"), { target: { value: "2" } });
    fireEvent.change(input("Age minimum"), { target: { value: "23" } });
    expect(onChange).toHaveBeenLastCalledWith(filterOf("age", "23..80"));
    rerender(filterOf("age", "2..80"));
    expect(input("Age minimum").value).toBe("23");
    rerender(filterOf("age", "23..80"));
    expect(input("Age minimum").value).toBe("23");
    rerender(filterOf("age", "4..80"));
    expect(input("Age minimum").value).toBe("4");
  });

  // Failure mode: typing back to the current value while earlier emissions
  // were outstanding skipped queuing it, so its late echo read as external
  // and rolled the typed minimum back.
  it("queues a return to the current value while echoes are outstanding", () => {
    const { rerender } = renderRanges(filterOf("age", "1..80"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 1 to 80" }));
    for (const text of ["2", "1", "13"])
      fireEvent.change(input("Age minimum"), { target: { value: text } });
    rerender(filterOf("age", "2..80"));
    expect(input("Age minimum").value).toBe("13");
    rerender(filterOf("age", "1..80"));
    expect(input("Age minimum").value).toBe("13");
    rerender(filterOf("age", "13..80"));
    expect(input("Age minimum").value).toBe("13");
  });

  // Failure modes: an inline error was not tied to its input, so a screen
  // reader announced the invalid state without saying what was wrong.
  it("describes each invalid bound by its error", () => {
    renderRanges(filterOf("age", "1..8"));
    fireEvent.click(screen.getByRole("button", { name: "Age: 1 to 8" }));
    fireEvent.change(input("Age minimum"), { target: { value: "-3" } });
    expect(input("Age minimum")).toHaveAccessibleDescription(
      "Enter a number 0 or more.",
    );
  });

  it("describes an invalid relative amount by its error", () => {
    renderRanges(filterOf("made", "@today-30d.."));
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Made: on or after today − 30 days$/,
      }),
    );
    fireEvent.change(input("From days"), { target: { value: "100000" } });
    expect(input("From days")).toHaveAccessibleDescription(
      "Enter whole days, up to 99,999.",
    );
  });

  // Failure mode: a relative amount past the token's five digits emitted a
  // token that is not relative, so the bound flipped to Date mid-typing.
  it("rejects a relative amount past the token limit without leaving Relative", () => {
    const { onChange } = renderRanges(filterOf("made", "@today-30d.."));
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Made: on or after today − 30 days$/,
      }),
    );
    const days = input("From days");
    expect(days.value).toBe("30");
    fireEvent.change(days, { target: { value: "100000" } });
    expect(input("From days").value).toBe("100000");
    expect(input("From days")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByLabelText("From date")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input("From days"), { target: { value: "45" } });
    expect(onChange).toHaveBeenLastCalledWith(filterOf("made", "@today-45d.."));
  });
});
