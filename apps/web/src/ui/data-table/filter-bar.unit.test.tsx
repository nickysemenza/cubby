import { FILTER_NOT_PREFIX } from "@cubby/schemas/filter-sentinel-fields";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { fireEvent, render, screen } from "@testing-library/react";
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

describe("FilterBar", () => {
  it("keeps active filters visible while inactive filters remain reachable through Filters", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        collapsed
        fields={fields}
        filters={[
          {
            id: "filter-status",
            field: "status",
            operator: "is",
            values: ["open"],
          },
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Status: Open" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Name: any" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("button", { name: "Name: any" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Filter Name" }),
      { target: { value: "brush" } },
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ field: "status", values: ["open"] }),
        expect.objectContaining({ field: "name", values: ["brush"] }),
      ]),
    );
  });
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
      await screen.findByRole("button", { name: "Show filter status options" }),
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

  it("edits a multiselect field's chip through a multiple picker with a Clear/Apply footer", async () => {
    const { onChange } = renderBar([]);

    fireEvent.click(screen.getByRole("button", { name: "Tags: any" }));
    fireEvent.click(await screen.findByRole("option", { name: "Home" }));
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
    expect(await screen.findByText("Food")).toBeInTheDocument();
    const citrus = screen.getByRole("option", { name: "Produce / Citrus" });
    // Depth indents the tree row; the row reads its own label.
    expect(citrus).toHaveStyle({ paddingLeft: "18px" });
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

  it("offers Match all only on a multi-valued field and applies it", async () => {
    const single = renderBar([]);
    fireEvent.click(screen.getByRole("button", { name: "Tags: any" }));
    await screen.findByRole("option", { name: "Home" });
    expect(screen.queryByRole("button", { name: "Match all" })).toBeNull();
    single.unmount();

    const { onChange } = renderBar([], {
      fields: [{ ...fields[2]!, matchAll: true }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Tags: any" }));
    fireEvent.click(await screen.findByRole("option", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Match all" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

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
    expect(filterSummary(tags, undefined)).toBe("any");
  });

  it("names No value beside picked values", () => {
    expect(chip([FILTER_NONE])).toBe("no value");
    expect(chip(["home", FILTER_NONE])).toBe("Home or no value");
  });

  it("treats a lone mode token as inactive", () => {
    expect(chip([FILTER_ALL])).toBe("any");
    expect(chip([FILTER_EXACT])).toBe("any");
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
