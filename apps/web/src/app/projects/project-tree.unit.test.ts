import type { ProjectListItemOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { buildProjectTree } from "./project-tree";

/** Minimal `ProjectOut`-shaped fixture — only `id`/`parentProjectId` vary;
 * every other field is a fixed, valid default the builder never reads.
 * Readable seeds are converted to deterministic, schema-valid project
 * shortcodes; callers should assert against the resulting fixture values. */
function proj(id: string, parentProjectId?: string): ProjectListItemOut {
  return {
    id: testShortcode("project", id),
    displayImages: [],
    name: id,
    status: "planning",
    kind: null,
    locations: [],
    defaultTrade: null,
    costEstimate: null,
    parentProjectId:
      parentProjectId != null
        ? testShortcode("project", parentProjectId)
        : null,
    startDate: null,
    endDate: null,
    icon: null,
    notes: null,
    googleDriveFolderUrl: null,
    notionPageUrl: null,
    dates: {
      derivedStart: null,
      derivedEnd: null,
      effectiveStart: null,
      effectiveEnd: null,
      startSource: "none",
      endSource: "none",
    },
    parentProjectName: null,
    childProjectIds: [],
    blockedByIds: [],
    blockingIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    rollup: {
      spent: 0,
      actualSpent: 0,
      committedSpent: 0,
      contributions: 0,
      expenseCount: 0,
      taskCount: 0,
      doneTaskCount: 0,
      subtree: {
        spent: 0,
        actualSpent: 0,
        committedSpent: 0,
        contributions: 0,
        expenseCount: 0,
        taskCount: 0,
        doneTaskCount: 0,
        projectCount: 0,
        costEstimate: null,
      },
    },
    dataQuality: testCompleteDataQuality(),
  };
}

/** Flattens a tree (pre-order) for total-count / id-order assertions. */
function flatten(rows: ReturnType<typeof buildProjectTree>): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    ids.push(row.id);
    ids.push(...flatten(row.subRows));
  }
  return ids;
}

describe("buildProjectTree", () => {
  it("returns [] for an empty list", () => {
    expect(buildProjectTree([])).toEqual([]);
  });

  it("makes every project a root when none has a parent, preserving order", () => {
    const a = proj("a");
    const b = proj("b");
    const c = proj("c");
    const rows = buildProjectTree([a, b, c]);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    for (const row of rows) expect(row.subRows).toEqual([]);
  });

  it("nests two children under their parent, in input order", () => {
    const parent = proj("parent");
    const child1 = proj("child1", "parent");
    const child2 = proj("child2", "parent");
    const rows = buildProjectTree([parent, child1, child2]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(parent.id);
    expect(rows[0]?.subRows.map((r) => r.id)).toEqual([child1.id, child2.id]);
  });

  it("promotes a child to a root when its parent was filtered out", () => {
    const child = proj("child", "missing-parent");
    const rows = buildProjectTree([child]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(child.id);
    expect(rows[0]?.subRows).toEqual([]);
  });

  it("nests a depth-2 chain (a -> b -> c) correctly", () => {
    const a = proj("a");
    const b = proj("b", "a");
    const c = proj("c", "b");
    const rows = buildProjectTree([a, b, c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(a.id);
    expect(rows[0]?.subRows).toHaveLength(1);
    expect(rows[0]?.subRows[0]?.id).toBe(b.id);
    expect(rows[0]?.subRows[0]?.subRows).toHaveLength(1);
    expect(rows[0]?.subRows[0]?.subRows[0]?.id).toBe(c.id);
    expect(rows[0]?.subRows[0]?.subRows[0]?.subRows).toEqual([]);
  });

  it("terminates on a two-node cycle (a <-> b), emitting each exactly once", () => {
    const a = proj("a", "b");
    const b = proj("b", "a");
    const rows = buildProjectTree([a, b]);
    const flat = flatten(rows);
    expect(flat).toHaveLength(2);
    expect(new Set(flat)).toEqual(new Set([a.id, b.id]));
  });

  it("terminates without throwing on a chain longer than the depth cap", () => {
    const ids = Array.from({ length: 105 }, (_, i) => `n${i}`);
    const chain = ids.map((id, i) =>
      i === 0 ? proj(id) : proj(id, ids[i - 1]),
    );
    expect(() => buildProjectTree(chain)).not.toThrow();
    const rows = buildProjectTree(chain);
    // The chain is acyclic, so nodes past the depth cap are dropped (not
    // promoted as spurious extra roots) — same "just stop walking deeper"
    // behaviour as gantt-model.ts. Only the single true root survives.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(testShortcode("project", "n0"));
    const flat = flatten(rows);
    expect(flat.length).toBeLessThan(105);
    expect(flat.length).toBeGreaterThan(0);
    expect(new Set(flat).size).toBe(flat.length); // no duplicates
  });

  it("preserves sibling order under a parent, independent of input order", () => {
    const parent = proj("parent");
    const childB = proj("childB", "parent");
    const childA = proj("childA", "parent");
    // Input order is B then A — output should follow input, not alpha sort.
    const rows = buildProjectTree([parent, childB, childA]);
    expect(rows[0]?.subRows.map((r) => r.id)).toEqual([childB.id, childA.id]);
  });
});
