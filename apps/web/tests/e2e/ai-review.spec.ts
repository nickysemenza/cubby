import { eq, inArray } from "drizzle-orm";

import {
  product as productTable,
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";

import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures-core";

// Failure modes: bulk Accept skips the shared handler (no record write or
// status change), bulk Reject applies the suggested value, a Run-filtered
// link shows another Run's Suggestions, or a settled row hides its result.
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

  await rowFor(names[2] ?? "")
    .getByRole("checkbox", { name: "Select row", exact: true })
    .check();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
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
