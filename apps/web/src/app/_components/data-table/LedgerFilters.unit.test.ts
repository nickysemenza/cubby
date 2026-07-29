import { describe, expect, it } from "vitest";
import type { FilterFieldConfig } from "~/components/reui/filters";
import {
  columnFiltersToLedgerFilters,
  ledgerFiltersToColumnFilters,
} from "./LedgerFilters";

type TestField = FilterFieldConfig<string> & {
  key: string;
  type: "text" | "select" | "multiselect";
};

const fields: TestField[] = [
  { key: "name", label: "Name", type: "text" },
  { key: "status", label: "Status", type: "multiselect" },
  { key: "project", label: "Project", type: "select" },
];

describe("LedgerFilters adapters", () => {
  it("preserves scalar and multiselect table state", () => {
    const tableFilters = [
      { id: "name", value: "sink" },
      { id: "status", value: ["blocked", "in_progress"] },
      { id: "project", value: "project-1" },
    ];

    const ledger = columnFiltersToLedgerFilters(tableFilters, fields);

    expect(
      ledger.map(({ field, operator, values }) => ({
        field,
        operator,
        values,
      })),
    ).toEqual([
      { field: "name", operator: "contains", values: ["sink"] },
      {
        field: "status",
        operator: "is_any_of",
        values: ["blocked", "in_progress"],
      },
      { field: "project", operator: "is", values: ["project-1"] },
    ]);
    expect(ledgerFiltersToColumnFilters(ledger, fields)).toEqual(tableFilters);
  });

  it("drops empty values and unknown fields", () => {
    expect(
      ledgerFiltersToColumnFilters(
        [
          {
            id: "empty",
            field: "name",
            operator: "contains",
            values: [""],
          },
          {
            id: "unknown",
            field: "missing",
            operator: "is",
            values: ["value"],
          },
        ],
        fields,
      ),
    ).toEqual([]);
  });
});
