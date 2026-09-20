import { describe, expect, it } from "vitest";

import { barFieldFromConfig } from "./filter-bar-core";

describe("barFieldFromConfig", () => {
  it("overlays server facet counts without mutating searchable labels", () => {
    const field = barFieldFromConfig(
      "trade",
      "Trade",
      {
        placeholder: "Filter trade...",
        filterType: "multiselect",
        options: [{ value: "electrical", label: "Electrical & Lighting" }],
      },
      { electrical: "0" },
    );

    expect(field.options).toEqual([
      {
        value: "electrical",
        label: "Electrical & Lighting",
        icon: undefined,
        color: "var(--chart-1)",
        hint: "0",
      },
    ]);
  });
});
