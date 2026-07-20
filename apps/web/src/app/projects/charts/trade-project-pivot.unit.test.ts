import type { ProjectOut, PurchaseOut } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import {
  buildTradeProjectPivot,
  NO_PROJECT_KEY,
  OTHER_PROJECTS_KEY,
} from "./trade-project-pivot";

const project = (
  id: string,
  name: string,
  parentProjectId: string | null = null,
): ProjectOut => ({ id, name, parentProjectId }) as unknown as ProjectOut;

// Plain-string ids/trades on purpose — these fixtures only need the four
// fields the pivot reads, so branding them adds friction for nothing.
const purchase = (overrides: {
  trade: string;
  cost: number | null;
  projectId?: string | null;
  future?: boolean;
}): PurchaseOut =>
  ({
    projectId: null,
    future: false,
    ...overrides,
  }) as unknown as PurchaseOut;

describe("buildTradeProjectPivot", () => {
  it("folds sub-project spend into its top-level root", () => {
    const projects = [
      project("kitchen", "Kitchen Remodel"),
      project("kitchen-plumbing", "Kitchen: Plumbing", "kitchen"),
      project("kitchen-deep", "Kitchen: Deep", "kitchen-plumbing"),
    ];
    const purchases = [
      purchase({ trade: "plumbing", cost: 100, projectId: "kitchen-plumbing" }),
      purchase({ trade: "plumbing", cost: 25, projectId: "kitchen-deep" }),
      purchase({ trade: "plumbing", cost: 5, projectId: "kitchen" }),
    ];

    const { rows, columns, grandTotal } = buildTradeProjectPivot(
      projects,
      purchases,
    );

    expect(columns).toEqual([
      { key: "kitchen", label: "Kitchen Remodel", total: 130 },
    ]);
    expect(rows).toEqual([
      { trade: "plumbing", cells: { kitchen: 130 }, total: 130 },
    ]);
    expect(grandTotal).toBe(130);
  });

  it("excludes future and cost-less purchases", () => {
    const purchases = [
      purchase({ trade: "tools", cost: 50 }),
      purchase({ trade: "tools", cost: 999, future: true }),
      purchase({ trade: "tools", cost: null }),
    ];

    const { grandTotal, columns } = buildTradeProjectPivot([], purchases);

    expect(grandTotal).toBe(50);
    expect(columns[0]?.key).toBe(NO_PROJECT_KEY);
  });

  it("buckets purchases whose project isn't loaded as 'No project'", () => {
    const { columns } = buildTradeProjectPivot(
      [project("kitchen", "Kitchen Remodel")],
      [purchase({ trade: "other", cost: 10, projectId: "filtered-out" })],
    );

    expect(columns).toEqual([
      { key: NO_PROJECT_KEY, label: "No project", total: 10 },
    ]);
  });

  it("rolls roots past the 8-column cap into 'Other projects'", () => {
    const projects = Array.from({ length: 10 }, (_, i) =>
      project(`p${i}`, `Project ${i}`),
    );
    // p0 largest … p9 smallest, so p8 + p9 (20 + 10) land in the rollup.
    const purchases = projects.map((p, i) =>
      purchase({ trade: "building", cost: 100 - i * 10, projectId: p.id }),
    );

    const { columns, rows, grandTotal } = buildTradeProjectPivot(
      projects,
      purchases,
    );

    expect(columns).toHaveLength(9);
    expect(columns.at(-1)).toEqual({
      key: OTHER_PROJECTS_KEY,
      label: "Other projects (2)",
      total: 30,
    });
    expect(rows[0]?.cells[OTHER_PROJECTS_KEY]).toBe(30);
    expect(grandTotal).toBe(550);
  });

  it("ranks a big net-negative project column by magnitude", () => {
    const projects = [project("wedding", "Wedding"), project("small", "Small")];
    const purchases = [
      purchase({ trade: "other", cost: -75_000, projectId: "wedding" }),
      purchase({ trade: "other", cost: 10, projectId: "small" }),
    ];

    const { columns } = buildTradeProjectPivot(projects, purchases);

    expect(columns.map((c) => c.key)).toEqual(["wedding", "small"]);
  });
});
