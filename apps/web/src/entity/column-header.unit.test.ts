import { describe, expect, it } from "vitest";

import { columnHeaderFor } from "./column-header";

type Field = Parameters<typeof columnHeaderFor>[0];

const field = (
  label: string,
  display: Partial<Field["display"]> = {},
  provenance: Field["provenance"] = null,
): Field => ({
  label,
  kind: "number",
  display: { format: null, columnLabel: null, ...display },
  provenance,
});
const from = (...entities: Array<"expense" | "location" | null>) => ({
  kind: "derived" as const,
  sources: entities.map((entity) => ({
    entity,
    label: entity ? null : "Image storage",
    relation: null,
  })),
});

// Table headers use a short label so a header no longer holds its column
// wider than its values; the full label stays the accessible name and
// tooltip. A count of one entity's records collapses to that entity's icon.
describe("columnHeaderFor", () => {
  it.each<{
    case: string;
    field: Field;
    short: string;
    countOf: string | null;
  }>([
    {
      case: "a count of one entity's records",
      field: field("Expense count", { format: "count" }, from("expense")),
      short: "Expenses",
      countOf: "expense",
    },
    {
      case: "an array count of one entity's records",
      field: field(
        "Serving as locations",
        { format: "arrayCount", columnLabel: "As location" },
        from("location"),
      ),
      short: "As location",
      countOf: "location",
    },
    {
      case: "a count with several sources",
      field: field(
        "Source recipe count",
        { format: "count" },
        from("expense", "location"),
      ),
      short: "Source recipes",
      countOf: null,
    },
    {
      case: "a count with no entity source",
      field: field("Category count", { format: "count" }, from(null)),
      short: "Categories",
      countOf: null,
    },
    {
      case: "a declared short label",
      field: field("Itemization coverage", { columnLabel: "Itemized" }),
      short: "Itemized",
      countOf: null,
    },
    {
      case: "a label with no short form",
      field: field("Purchase date"),
      short: "Purchase date",
      countOf: null,
    },
    {
      case: "a count named only by its label",
      field: field("Purchase count", {}, from("expense")),
      short: "Purchases",
      countOf: "expense",
    },
    {
      case: "a non-number named like a count",
      field: { ...field("Branch count", {}, from("expense")), kind: "text" },
      short: "Branches",
      countOf: null,
    },
  ])("$case", ({ field: input, short, countOf }) => {
    expect(columnHeaderFor(input)).toEqual({
      label: input.label,
      short,
      countOf,
    });
  });
});
