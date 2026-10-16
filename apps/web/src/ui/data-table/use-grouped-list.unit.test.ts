import { describe, expect, it } from "vitest";

import { groupSections } from "./use-grouped-list";

describe("groupSections", () => {
  it("lets a tree's child rows follow their parent without taking a section place", () => {
    const rows = [
      { id: "alpha-root", depth: 0 },
      { id: "alpha-child", depth: 1 },
      { id: "beta-root", depth: 0 },
    ];
    const sections = groupSections(
      rows,
      {
        choice: {
          key: "type",
          label: "Type",
          noValueLabel: "No type",
          reason: null,
          value: { kind: "derived", options: null },
          filter: null,
        },
        groups: [
          { key: "alpha", label: "Alpha", count: 1 },
          { key: "beta", label: "Beta", count: 1 },
        ],
      },
      (row) => row.depth > 0,
    );
    expect(
      sections.map(({ key, items }) => [key, items.map(({ id }) => id)]),
    ).toEqual([
      ["alpha", ["alpha-root", "alpha-child"]],
      ["beta", ["beta-root"]],
    ]);
  });
});
