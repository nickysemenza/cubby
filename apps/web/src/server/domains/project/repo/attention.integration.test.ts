import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { computeAttentionItems } from "./attention";
import { loadProjectSubtreeRollups } from "./subtree";

describe("project attention activity", () => {
  const ctx = withTestDb();

  // Activity must use own live content, including refunds and future task
  // ends. Descendants and manual window overrides must not refresh a parent.
  // Reusing the tree must not rescan its allocation and task date aggregates.
  it("reuses own activity dates while preserving stalled and scoped results", async () => {
    const old = new Date("2020-01-01T12:00:00Z");
    const stale = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic quiet parent",
      status: "in_progress",
      updatedAt: old,
      endDate: householdDaysFromNow(90),
    });
    const child = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic active child",
      parentProjectId: stale.id,
      status: "in_progress",
      updatedAt: old,
    });
    const refund = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic refunded work",
      status: "in_progress",
      updatedAt: old,
    });
    const scheduled = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic scheduled work",
      status: "in_progress",
      updatedAt: old,
    });
    for (const projectId of [child.id, refund.id])
      await insertWithShortcode(ctx.db, "expense", {
        name: "Synthetic recent adjustment",
        costType: "materials",
        trade: "other",
        lineKind: "principal",
        projectId,
        cost: -10,
        future: false,
        date: householdDaysAgo(2),
      });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic deleted adjustment",
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      projectId: stale.id,
      cost: 10,
      date: householdDaysAgo(1),
      deletedAt: new Date(),
    });
    await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic ongoing task",
      trade: "other",
      projectId: scheduled.id,
      dueDate: householdDaysAgo(90),
      dueEndDate: householdDaysFromNow(10),
    });
    await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic undated task",
      trade: "other",
      projectId: stale.id,
    });
    const preloaded = await loadProjectSubtreeRollups(ctx.db);
    const measured = await countTestDbQueries(() =>
      computeAttentionItems(ctx.db, { preloaded }),
    );
    expect(
      measured.result
        .filter((item) => item.type === "stalled_project")
        .map((item) => item.entityId),
    ).toEqual([stale.shortcode]);
    const scoped = await computeAttentionItems(ctx.db, {
      preloaded,
      projectIds: [child.id],
    });
    expect(scoped.some((item) => item.type === "stalled_project")).toBe(false);
    expect(await computeAttentionItems(ctx.db)).toEqual(measured.result);
    expect(measured.queryCount).toBeLessThanOrEqual(8);
  });
});
