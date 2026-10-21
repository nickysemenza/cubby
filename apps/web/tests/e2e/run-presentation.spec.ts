import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { eq } from "drizzle-orm";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { run, runStep } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { getDb } from "~/server/db/helpers";

import {
  openCellExplanation,
  gotoAuthenticatedPage,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import {
  fixtureUserId,
  getFixtureDb,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import { seedActivityHistory } from "./fixtures/photos";

// A successful image result must not look queued; skipped work must explain the actual outcome.
test("image jobs show completed status and an Apple skip reason", async ({
  page,
  e2eRuntime,
}) => {
  const sample = await seedActivityHistory(
    page,
    "Synthetic image outcome",
    e2eRuntime.objectStorageUrl,
  );
  const db = getDb(getFixtureDb());
  await db
    .update(imageProcessingJob)
    .set({ state: "ready", lastError: null, completedAt: new Date() })
    .where(eq(imageProcessingJob.shortcode, sample.jobId));
  await db
    .update(imageProcessingJob)
    .set({ state: "skipped", lastError: "no_subject", completedAt: new Date() })
    .where(eq(imageProcessingJob.shortcode, sample.standaloneJobId));
  await gotoAuthenticatedPage(page, `/image-jobs?imageId=${sample.imageId}`);
  const table = page.getByRole("table");
  const completed = table
    .getByRole("row")
    .filter({ hasText: "Image description" });
  await expect(completed).toContainText("Completed");
  await expect(completed).not.toContainText("Queued");
  const skipped = table.getByRole("row").filter({ hasText: "Subject lift" });
  await expect(skipped).toContainText("Apple found no foreground subject.");
});

test("related Runs show account labels and shared quality", async ({
  page,
}) => {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);
  const vendor = await insertWithShortcode(db, "vendor", {
    name: "Synthetic reference vendor",
  });
  const party = await insertWithShortcode(db, "ledgerParty", {
    name: "Fixture agent",
    kind: "guest",
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    vendorId: vendor.id,
    ledgerPartyId: party.id,
  });
  await insertWithShortcode(db, "run", {
    actorUserId: userId,
    actorName: "Fixture agent",
    actorEmail: "agent@example.test",
    purpose: "background",
    trigger: "manual",
    status: "completed",
    vendorId: vendor.id,
    vendorAccountId: account.id,
    startedAt: new Date("2026-09-01T10:00:00Z"),
    endedAt: new Date("2026-09-01T10:01:00Z"),
  });
  await gotoAuthenticatedPage(page, `/vendors/${vendor.shortcode}`);
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();
  const row = page
    .getByRole("table", { name: "Runs", exact: true })
    .getByRole("row")
    .filter({ hasText: "Synthetic reference vendor · Fixture agent" });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText(account.shortcode);
  await expect(
    row.getByRole("link", {
      name: "Synthetic reference vendor · Fixture agent",
      exact: true,
    }),
  ).toHaveAttribute("href", `/vendor-accounts/${account.shortcode}`);
  // Completed records retain their score and spoken quality status.
  await expect(row.locator('[data-cell-col="dataQuality"]')).toHaveText(
    "100, Complete",
  );
  await openCellExplanation(row, "How quality is determined");
  await expect(
    page.getByText("Actor attributed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Timeline recorded", { exact: true }),
  ).toBeVisible();

  await gotoAuthenticatedPage(page, "/runs");
  const listRow = page
    .getByRole("row")
    .filter({ hasText: "Synthetic reference vendor" });
  await expect(listRow.locator('[data-cell-col="dataQuality"]')).toHaveText(
    "100, Complete",
  );
});

// Phase work must survive target-free Runs; handoff grouping must leave errors readable.
test("Run work shows phase progress, unknown totals, and expandable handoffs", async ({
  page,
}) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const runId = await ensureRun(db, actor, {
    purpose: "maintenance",
    trigger: "manual",
  });
  const at = new Date(Date.now() - 180_000).toISOString();
  const [owner] = await getDb(db)
    .update(run)
    .set({
      status: "paused_auth",
      startedAt: new Date(Date.now() - 300_000),
      progressHistory: [
        {
          eventId: "synthetic-start-1",
          phase: "attempt_started",
          detail: "Started Workflow instance RUN-4K7M-1",
          createdAt: at,
        },
        {
          eventId: "synthetic-start-2",
          phase: "attempt_started",
          detail: "Started Workflow instance RUN-4K7M-2",
          createdAt: at,
        },
        {
          eventId: "synthetic-failure",
          phase: "failed",
          detail: "Synthetic upstream failure",
          createdAt: at,
        },
      ].map((event, sequence) => ({
        ...event,
        generation: "synthetic",
        sequence,
        currentItem: null,
        awaitingApproval: false,
      })),
    })
    .where(eq(run.id, runId))
    .returning({ id: run.id, shortcode: run.shortcode });
  if (!owner) throw new Error("Synthetic Run was not created");
  await getDb(db)
    .insert(runStep)
    .values({
      runId: owner.id,
      key: "synthetic",
      label: "Synthetic work",
      position: 0,
      state: "paused",
      found: 100,
      done: 35,
      skipped: 3,
      failed: 2,
      meta: {
        work: {
          current: {
            phase: "labels",
            label: "Labelling suggestions",
            unit: "suggestions",
            processed: 40,
            total: 100,
            failures: 2,
            sampledAt: at,
            ratePerSecond: 2,
            finished: false,
          },
          completed: [
            {
              phase: "generate",
              label: "Generating suggestions",
              unit: "charges",
              processed: 120,
              total: 120,
              failures: 0,
              sampledAt: at,
              ratePerSecond: 2,
              finished: true,
            },
          ],
        },
      },
    });
  await gotoAuthenticatedPage(page, `/runs/${owner.shortcode}`);
  const bar = page.getByRole("progressbar", { name: "Labelling suggestions" });
  await expect(bar).toHaveAttribute("aria-valuenow", "40");
  await expect(bar).toHaveAttribute("aria-valuemax", "100");
  await expect(
    page.getByText("40 / 100 suggestions · 2 failed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Using paused rate/)).toBeVisible();
  await expect(page.getByText(/40% · 60 suggestions left/)).toBeVisible();
  await expect(
    page.getByText("120 / 120 charges · 0 failed", { exact: true }),
  ).toBeVisible();
  await page.getByText("Show Workflow handoffs", { exact: true }).click();
  await expect(page.getByText(/RUN-4K7M-1/)).toBeVisible();
  await expect(
    page.getByText("Synthetic upstream failure", { exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(bar).toBeVisible();

  await getDb(db)
    .update(runStep)
    .set({
      meta: {
        work: {
          current: {
            phase: "discover",
            label: "Discovering",
            unit: "items",
            processed: 7,
            total: null,
            failures: 0,
            sampledAt: at,
            ratePerSecond: 1,
            finished: false,
          },
          completed: [],
        },
      },
    })
    .where(eq(runStep.runId, owner.id));
  await page.reload();
  const unknown = page.getByRole("progressbar", { name: "Discovering" });
  await expect(unknown).not.toHaveAttribute("aria-valuenow");
  await expect(
    page.getByText("7 / unknown items · 0 failed", { exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Unknown work must remain visible and animate; skeletons deliberately do neither.
  const indicator = unknown.locator(":scope > div");
  await expect(indicator).not.toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(indicator).toHaveCSS("animation-name", "none");
  await expect(indicator).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const widths = await unknown.evaluate((track) => ({
    track: track.getBoundingClientRect().width,
    indicator: track.firstElementChild?.getBoundingClientRect().width ?? 0,
  }));
  expect(widths.indicator).toBeGreaterThan(0);
  expect(widths.indicator).toBeLessThan(widths.track);
  await page.setViewportSize({ width: 1280, height: 900 });

  // A pre-sample generation checkpoint already knows its scope and completed work.
  await getDb(db)
    .update(runStep)
    .set({
      key: "statement_transaction",
      label: "Statements",
      found: 200,
      done: 60,
      skipped: 0,
      failed: 0,
      meta: {
        work: {
          completed: [],
          current: {
            phase: "statement_generate",
            label: "Generating suggestions",
            unit: "charges",
            processed: 10,
            total: null,
            failures: 0,
            sampledAt: at,
            ratePerSecond: 2,
            finished: false,
          },
        },
      },
    })
    .where(eq(runStep.runId, owner.id));
  await page.reload();
  const generation = page.getByRole("progressbar", {
    name: "Generating suggestions",
  });
  await expect(generation).toHaveAttribute("aria-valuenow", "60");
  await expect(generation).toHaveAttribute("aria-valuemax", "200");
  await expect(page.getByText(/30% · 140 charges left/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
});
