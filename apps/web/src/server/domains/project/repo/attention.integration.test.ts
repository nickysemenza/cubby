import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import { getDb } from "~/server/db/helpers";
import { entityLink } from "~/server/db/schema";
import { linkValues } from "~/server/generic/entity-links/repo/entity-links";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { computeAttentionItems } from "./attention";
import { loadProjectSubtreeRollups } from "./subtree";

describe("project attention activity", () => {
  const ctx = withTestDb();

  // Reusing attention's complete tree must preserve ownership conflicts and
  // explicit date boundaries; standalone diagnostics retain the same result.
  it("reuses complete Project windows in tool ownership diagnostics", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic completed work",
      status: "done",
      startDate: "2024-01-01",
      endDate: "2024-01-02",
    });
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic later tool" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .insert(entityLink)
      .values(linkValues("projectTool", project.id, product.entityId));
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic later acquisition",
      productId: product.entityId,
      cost: 20,
      date: "2024-02-01",
      future: false,
      lineKind: "principal",
      costType: "materials",
      trade: "other",
    });
    const loaded = await loadProjectSubtreeRollups(ctx.db);
    const standalone = await runDiagnostic(
      ctx.db,
      "tools-used-outside-ownership",
      {},
      { kind: "sample", limit: 100 },
    );
    expect(standalone.count).toBe(1);
    const shared = await runDiagnostic(
      ctx.db,
      "tools-used-outside-ownership",
      {
        projectDateWindows: Promise.resolve({
          tree: loaded,
          dateWindows: loaded.dateWindows,
        }),
      },
      { kind: "sample", limit: 100 },
    );
    expect(shared).toEqual(standalone);
    expect(shared.items).toMatchObject([
      {
        projectId: project.shortcode,
        id: product.id,
        conflict: "acquired_after_end",
        projectBoundary: "2024-01-02",
      },
    ]);
  });

  // A failed shared dependency must reject even when there are no tool edges,
  // rather than escaping as an unhandled promise or a healthy empty result.
  it("propagates a failed shared Project snapshot without tool edges", async () => {
    await expect(
      runDiagnostic(
        ctx.db,
        "tools-used-outside-ownership",
        {
          projectDateWindows: Promise.reject(
            new Error("Synthetic Project snapshot failed"),
          ),
        },
        { kind: "count" },
      ),
    ).rejects.toThrow("Synthetic Project snapshot failed");
  });

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
      computeAttentionItems(ctx.db, { preloaded: Promise.resolve(preloaded) }),
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
