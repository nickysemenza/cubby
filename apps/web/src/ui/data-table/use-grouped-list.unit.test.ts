import { listGroupSummarySchema } from "@cubby/schemas/pagination";
import { describe, expect, it } from "vitest";

import { groupSections, type GroupConfig } from "./use-grouped-list";

const choice: GroupConfig["choice"] = {
  key: "type",
  label: "Type",
  noValueLabel: "Unassigned",
  reason: null,
  value: { kind: "derived", options: null },
  filter: null,
  levels: 0,
  levelReason: "Type has no levels.",
  buckets: [],
  multiple: false,
  dateKind: null,
};
const group = (path: string[], count = 1) =>
  listGroupSummarySchema.parse({
    key: JSON.stringify(path),
    path,
    label: path.at(-1),
    count,
    parentCount: 2,
    fraction: count / 2,
    overlapping: false,
  });
const id = (row: { id: string }) => row.id;
const nested = (row: { depth: number }) => row.depth > 0;

describe("groupSections", () => {
  it("keeps tree children with their parent and hides a collapsed group without shifting later membership", () => {
    const sections = groupSections(
      [
        { id: "a", depth: 0 },
        { id: "child", depth: 1 },
        { id: "b", depth: 0 },
      ],
      {
        choice,
        groups: [group(["alpha"]), group(["beta"])],
        memberships: [
          { id: "a", path: ["alpha"] },
          { id: "b", path: ["beta"] },
        ],
        collapsed: new Set([JSON.stringify(["alpha"])]),
        onToggle: () => {},
      },
      id,
      nested,
    );
    expect(
      sections.map(({ label, count, collapsed, items }) => ({
        label,
        count,
        collapsed,
        ids: items.map(id),
      })),
    ).toEqual([
      { label: "alpha", count: 1, collapsed: true, ids: [] },
      { label: "beta", count: 1, collapsed: false, ids: ["b"] },
    ]);
  });

  it("uses explicit membership rather than full-set counts to place partially loaded rows", () => {
    const sections = groupSections(
      [
        { id: "a", depth: 0 },
        { id: "child", depth: 1 },
        { id: "b", depth: 0 },
      ],
      {
        choice,
        groups: [group(["alpha"], 2), group(["beta"])],
        memberships: [
          { id: "a", path: ["alpha"] },
          { id: "b", path: ["beta"] },
        ],
      },
      id,
      nested,
    );
    expect(sections.map(({ label, items }) => [label, items.map(id)])).toEqual([
      ["alpha", ["a", "child"]],
      ["beta", ["b"]],
    ]);
  });

  it("repeats canonical records in overlapping leaves and omits every descendant of a collapsed prefix", () => {
    const config: GroupConfig = {
      choice,
      groups: [
        group(["house"]),
        group(["house", "alpha"]),
        group(["house", "beta"]),
        group(["garden"]),
        group(["garden", "alpha"]),
      ],
      memberships: [
        { id: "a", path: ["house", "alpha"] },
        { id: "a", path: ["house", "beta"] },
        { id: "a", path: ["garden", "alpha"] },
      ],
    };
    const rows = [{ id: "a", depth: 0 }];
    expect(
      groupSections(rows, config, id).map(({ label, depth, items }) => [
        label,
        depth,
        items.map(id),
      ]),
    ).toEqual([
      ["house", 0, []],
      ["alpha", 1, ["a"]],
      ["beta", 1, ["a"]],
      ["garden", 0, []],
      ["alpha", 1, ["a"]],
    ]);
    expect(
      groupSections(
        rows,
        { ...config, collapsed: new Set([JSON.stringify(["house"])]) },
        id,
      ).map(({ key }) => key),
    ).toEqual([
      JSON.stringify(["house"]),
      JSON.stringify(["garden"]),
      JSON.stringify(["garden", "alpha"]),
    ]);
  });
});
