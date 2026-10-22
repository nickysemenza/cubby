import { eq } from "drizzle-orm";

import { householdDaysFromNow } from "~/lib/household-date";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import {
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Empty denominators must not look complete; settled dates must not stay red;
// a paused or stale work sample must not advertise a live processing rate.
test("list cells show project completion, open deadlines, and sampled run work", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const prefix = `Synthetic work grid ${Date.now()}`;
  const { project } = await createFixtureGraph(page, async (create) => {
    const project = await create("project", {
      name: `${prefix} project`,
      status: "in_progress",
    });
    await create("project", {
      name: `${prefix} empty`,
      status: "in_progress",
    });
    await create("task", {
      name: `${prefix} overdue`,
      trade: "other",
      projectId: project.id,
      status: "not_started",
      due: { start: householdDaysFromNow(-2), end: null },
    });
    await create("task", {
      name: `${prefix} finished`,
      trade: "other",
      projectId: project.id,
      status: "done",
      due: { start: householdDaysFromNow(-2), end: null },
    });
    await create("task", {
      name: `${prefix} future`,
      trade: "other",
      projectId: project.id,
      status: "not_started",
      due: { start: householdDaysFromNow(2), end: null },
    });
    return { project };
  });

  await gotoAuthenticatedPage(
    page,
    `/projects?q=${encodeURIComponent(prefix)}`,
  );
  const projects = page.getByRole("table");
  await expect(
    projects
      .getByRole("row", { name: new RegExp(`${prefix} project`) })
      .locator('[data-column-id="taskProgress"]'),
  ).toContainText("1 / 3");
  await expect(
    projects
      .getByRole("row", { name: new RegExp(`${prefix} empty`) })
      .locator('[data-column-id="taskProgress"]'),
  ).toContainText("No tasks");
  await projects.screenshot({
    path: testInfo.outputPath("project-progress.png"),
  });

  await gotoAuthenticatedPage(page, `/tasks?q=${encodeURIComponent(prefix)}`);
  const tasks = page.getByRole("table");
  const overdue = tasks
    .getByRole("row", { name: new RegExp(`${prefix} overdue`) })
    .locator('[data-column-id="dueDate"]');
  const future = tasks
    .getByRole("row", { name: new RegExp(`${prefix} future`) })
    .locator('[data-column-id="dueDate"]');
  await expect(overdue.locator("[data-overdue]")).toHaveCount(1);
  expect(
    await overdue.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toBe(
    await future.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  await tasks.screenshot({ path: testInfo.outputPath("task-deadlines.png") });

  await gotoAuthenticatedPage(page, `/projects/${project.id}`);
  const finished = page
    .getByRole("table", { name: "Tasks", exact: true })
    .getByRole("row", { name: new RegExp(`${prefix} finished`) })
    .locator('[data-column-id="dueDate"]');
  await expect(finished.locator("[data-overdue]")).toHaveCount(0);

  const { db, actor } = await createEvidenceHarnessContext(page);
  const at = new Date().toISOString();
  const runId = await ensureRun(db, actor, {
    purpose: "background",
    trigger: "manual",
  });
  await getDb(db)
    .update(run)
    .set({
      heartbeatAt: new Date(at),
      liveProgress: {
        generation: "synthetic-grid",
        sequence: 1,
        eventId: "synthetic-grid-event",
        phase: "review",
        currentItem: null,
        awaitingApproval: false,
        detail: null,
        createdAt: at,
        work: {
          current: {
            phase: "review",
            label: "Reviewing items",
            unit: "items",
            processed: 12,
            total: 40,
            failures: 0,
            sampledAt: at,
            ratePerSecond: 0.5,
            finished: false,
          },
          completed: [],
        },
      },
    })
    .where(eq(run.id, runId));
  await gotoAuthenticatedPage(page, "/runs");
  const runs = page.getByRole("table");
  const work = runs
    .locator('[data-column-id="workProgress"]')
    .filter({ hasText: "12 / 40 items" });
  await expect(work).toContainText("30 items/min");
  await runs.screenshot({ path: testInfo.outputPath("run-throughput.png") });
  const [paused] = await getDb(db)
    .update(run)
    .set({ status: "paused_auth" })
    .where(eq(run.id, runId))
    .returning({ liveProgress: run.liveProgress });
  await page.reload();
  await expect(work).toContainText("Paused");
  await expect(work).not.toContainText("30 items/min");
  if (!paused?.liveProgress?.work)
    throw new Error("Synthetic work sample missing");
  await getDb(db)
    .update(run)
    .set({
      status: "running",
      liveProgress: {
        ...paused.liveProgress,
        work: {
          ...paused.liveProgress.work,
          current: {
            ...paused.liveProgress.work.current,
            sampledAt: new Date(Date.now() - 300_000).toISOString(),
          },
        },
      },
    })
    .where(eq(run.id, runId));
  await page.reload();
  await expect(work).toContainText("Stale sample");
  await expect(work).not.toContainText("30 items/min");
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAuthenticatedPage(
    page,
    `/projects?q=${encodeURIComponent(prefix)}`,
  );
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
  await gotoAuthenticatedPage(page, "/runs");
  await expect(
    page.getByText("12 / 40 items; Stale sample", { exact: true }),
  ).toBeVisible();
});
