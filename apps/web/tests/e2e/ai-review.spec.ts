import type { Route } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import {
  product as productTable,
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";

import { dispatchesOperation } from "./dispatch-wire";
import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures-core";

// Failure modes: bulk Accept skips the shared handler (no record write or
// status change), bulk Reject applies the suggested value, a Run-filtered
// link shows another Run's Suggestions, a settled row hides its result, or
// completing Accept clears a newly selected Reject row while refetching.
test("Review bulk-accepts and bulk-rejects a Run's Suggestions with read-back", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const category = await createEntityFixture(page, "productCategory", {
    name: uniqueName(testInfo, "Review category"),
  });
  const names = ["Accept one", "Accept two", "Reject"].map((label) =>
    uniqueName(testInfo, `Review ${label}`),
  );
  const products = await Promise.all(
    names.map((name) =>
      createEntityFixture(page, "product", { name, categoryId: null }),
    ),
  );
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const [run] = await getDb(db)
    .select({ shortcode: runTable.shortcode })
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!run) throw new Error("Synthetic Run is missing");
  const recordIds = await Promise.all(
    products.map((record) => resolveOrThrow(db, "product", record.id)),
  );
  await getDb(db)
    .insert(suggestionTable)
    .values(
      recordIds.map((recordId) => ({
        runId,
        entity: "product",
        recordId,
        field: "categoryId",
        currentValue: null,
        suggestedValue: category.id,
        confidence: 0.92,
        runnerUpValue: null,
        runnerUpConfidence: null,
        model: "typesafe/jev",
        kind: "addition" as const,
        status: "pending" as const,
      })),
    );

  await gotoAuthenticatedPage(
    page,
    `/ai?tab=review&entity=product&field=categoryId&runId=${run.shortcode}`,
  );
  const table = page.getByRole("table", { name: "Suggestions" });
  const rowFor = (name: string) =>
    table.getByRole("row").filter({ hasText: name });
  for (const name of names) await expect(rowFor(name)).toHaveCount(1);
  await expect(table.getByText("92% · high").first()).toBeVisible();

  for (const name of names.slice(0, 2))
    await rowFor(name)
      .getByRole("checkbox", { name: "Select row", exact: true })
      .check();
  // Hold the real response after the write, so the next selection happens
  // before completion/refetch can clear it. No timer-dependent race setup.
  const acceptance = Promise.withResolvers<void>();
  const holdAcceptance = async (route: Route) => {
    if (!dispatchesOperation(route.request(), "ai.acceptSuggestions")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await acceptance.promise;
    await route.fulfill({ response });
  };
  const rejectRow = rowFor(names[2] ?? "").getByRole("checkbox", {
    name: "Select row",
    exact: true,
  });
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await page.route(`**${BROWSER_OPERATION_PATH}`, holdAcceptance);
  try {
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect
      .poll(async () =>
        (
          await getDb(db)
            .select({ status: suggestionTable.status })
            .from(suggestionTable)
            .where(inArray(suggestionTable.recordId, recordIds.slice(0, 2)))
        ).map((row) => row.status),
      )
      .toEqual(["applied", "applied"]);
    await expect(reject).toBeDisabled();
    await rejectRow.check();
    await expect(rejectRow).toBeChecked();
  } finally {
    acceptance.resolve();
    await page.unroute(`**${BROWSER_OPERATION_PATH}`, holdAcceptance);
  }
  await expect(reject).toBeEnabled();
  await expect(rejectRow).toBeChecked();
  await reject.click();
  await expect
    .poll(async () => {
      const [row] = await getDb(db)
        .select({ status: suggestionTable.status })
        .from(suggestionTable)
        .where(eq(suggestionTable.recordId, recordIds[2] ?? ""));
      return row?.status;
    })
    .toBe("rejected");

  const categories = await getDb(db)
    .select({ id: productTable.id, categoryId: productTable.categoryId })
    .from(productTable)
    .where(inArray(productTable.id, recordIds));
  const categoryUuid = await resolveOrThrow(db, "productCategory", category.id);
  expect(
    recordIds.map(
      (id) => categories.find((row) => row.id === id)?.categoryId ?? null,
    ),
  ).toEqual([categoryUuid, categoryUuid, null]);
  await expect(
    page.getByRole("tab", { name: "Review", selected: true }),
  ).toBeVisible();
});

// Failure mode: accepting one selected row supersedes its sibling, the
// sibling's failure is reported, and the pending refetch drops both rows so
// the error has nowhere to show.
test("Review keeps a superseded sibling's bulk failure beside its row", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const categories = await Promise.all(
    ["First", "Second"].map((label) =>
      createEntityFixture(page, "productCategory", {
        name: uniqueName(testInfo, `Sibling ${label}`),
      }),
    ),
  );
  const name = uniqueName(testInfo, "Review sibling");
  const product = await createEntityFixture(page, "product", {
    name,
    categoryId: null,
  });
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const [run] = await getDb(db)
    .select({ shortcode: runTable.shortcode })
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!run) throw new Error("Synthetic Run is missing");
  const recordId = await resolveOrThrow(db, "product", product.id);
  await getDb(db)
    .insert(suggestionTable)
    .values(
      categories.map((category, index) => ({
        runId,
        entity: "product",
        recordId,
        field: "categoryId",
        currentValue: null,
        suggestedValue: category.id,
        confidence: 0.9 - index * 0.1,
        runnerUpValue: null,
        runnerUpConfidence: null,
        model: "typesafe/jev",
        kind: "addition" as const,
        status: "pending" as const,
      })),
    );

  await gotoAuthenticatedPage(
    page,
    `/ai?tab=review&entity=product&field=categoryId&runId=${run.shortcode}`,
  );
  const table = page.getByRole("table", { name: "Suggestions" });
  const rows = table.getByRole("row").filter({ hasText: name });
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all())
    await row
      .getByRole("checkbox", { name: "Select row", exact: true })
      .check();
  await page.getByRole("button", { name: "Accept", exact: true }).click();

  await expect
    .poll(async () =>
      (
        await getDb(db)
          .select({ status: suggestionTable.status })
          .from(suggestionTable)
          .where(eq(suggestionTable.recordId, recordId))
      )
        .map((row) => row.status)
        .sort(),
    )
    .toEqual(["applied", "superseded"]);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("alert")).toContainText(
    "Pending Suggestion not found",
  );
  await expect(page.getByText("1 could not be settled")).toBeVisible();
  // The superseded row can no longer settle, so it offers no selection.
  await expect(
    rows.getByRole("checkbox", { name: "Select row", exact: true }),
  ).toHaveCount(0);
  // Nor does it stay selected behind the bar, where bulk Accept could resend it.
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  // Leaving and returning to the same filters starts a fresh visit: the
  // earlier failure does not reappear without another settlement.
  const status = page.getByRole("combobox", { name: "Status" });
  await status.selectOption("rejected");
  await expect(page.getByText("could not be settled")).toHaveCount(0);
  await status.selectOption("pending");
  await expect(
    page.getByText("No suggestions match these filters."),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("could not be settled")).toHaveCount(0);
});
