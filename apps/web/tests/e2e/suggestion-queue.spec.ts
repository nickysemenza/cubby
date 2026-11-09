import { eq, inArray } from "drizzle-orm";

import { getDb } from "~/server/db/helpers";
import {
  emailReview,
  runOperation,
  product as productTable,
} from "~/server/db/schema";

import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import { seedUnimportedOrderMail } from "./fixtures/mail";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Failure mode: Report incorrect fails to retain the member's history feedback.
test("automatic history records the member's incorrect-report feedback", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db, actor } = await createEvidenceHarnessContext(page);
  const mail = await seedUnimportedOrderMail(
    page,
    uniqueName(testInfo, "Synthetic audit vendor"),
  );
  const source = mail.events[0];
  if (!source) throw new Error("Synthetic Email missing");
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const decision = { id: crypto.randomUUID() };
  const outcomeAt = new Date().toISOString();
  await getDb(db)
    .insert(runOperation)
    .values({
      runId,
      operationId: `synthetic-outcome:${source.emailId}`,
      kind: "target_outcome",
      state: "completed",
      inputFingerprint: "synthetic",
      completedAt: new Date(outcomeAt),
      result: {
        mailOutcome: {
          id: decision.id,
          judgment: {
            kind: "imported",
            lines: [{ name: "Synthetic packet", cost: 5 }],
            total: 5,
          },
          producer: {
            kind: "rule",
            model: null,
            revision: "synthetic/v1",
            runId,
            evaluationId: null,
          },
          checksum: source.checksum,
          fingerprint: source.checksum,
          createdAt: outcomeAt,
        },
        target: {
          entityKind: "email",
          entityId: await resolveOrThrow(db, "email", source.emailId),
          workKey: source.emailId,
          state: "completed",
          outcome: "verified",
          warning: null,
          diff: null,
          completedAt: outcomeAt,
          targetFingerprint: source.checksum,
        },
      },
    });
  await gotoAuthenticatedPage(page, "/suggestions");
  await gotoAuthenticatedPage(
    page,
    "/automatic-decisions?family=mail_import_outcome",
  );
  const audit = page.getByRole("region", {
    name: "Automation history",
    exact: true,
  });
  await expect(audit).toContainText("Synthetic packet");
  await expect(
    audit.getByRole("link", { name: /Synthetic itemized confirmation/ }),
  ).toBeVisible();

  await audit
    .getByRole("button", { name: "Report incorrect", exact: true })
    .click();
  await expect(
    audit.getByRole("button", { name: "Report incorrect", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(async () =>
      (
        await getDb(db)
          .select()
          .from(emailReview)
          .where(eq(emailReview.subjectId, decision.id))
      ).some((row) => row.verdict === "wrong" && row.intent === "history"),
    )
    .toBe(true);
});

// Identity conflicts cannot merge; matching pairs still require survivor and impact confirmation.
test("new proposal families require explicit review and preserve merge confirmation", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db } = await createEvidenceHarnessContext(page);
  const { first, second, conflicted } = await createFixtureGraph(
    page,
    async (create) => {
      const brand = await create("vendor", {
        name: uniqueName(testInfo, "Example Tools"),
      });
      const first = await create("product", {
        name: uniqueName(testInfo, "Synthetic matching drill"),
        brandId: brand.id,
        model: "SYN-DRILL-17",
      });
      const second = await create("product", {
        name: uniqueName(testInfo, "Synthetic matching drill duplicate"),
        brandId: brand.id,
        model: "SYN-DRILL-17",
      });
      const conflicted = await create("product", {
        name: uniqueName(testInfo, "Synthetic conflicting drill"),
        brandId: brand.id,
        model: "SYN-DRILL-29",
      });
      return { first, second, conflicted };
    },
  );
  const firstId = await resolveOrThrow(db, "product", first.id);
  const secondId = await resolveOrThrow(db, "product", second.id);
  await publishProductPair(db, {
    productIds: [firstId, secondId],
    source: "agent",
    evidence: "Synthetic identical-model evidence",
    sourceUrls: [],
    actionable: true,
  });
  await publishProductPair(db, {
    productIds: [firstId, await resolveOrThrow(db, "product", conflicted.id)],
    source: "agent",
    evidence: "Synthetic conflicting-model evidence",
    sourceUrls: [],
    actionable: true,
    conflict: true,
  });
  await gotoAuthenticatedPage(page, "/suggestions");
  const table = page.getByRole("table", { name: "Suggestions", exact: true });
  const conflictRow = table
    .getByRole("row")
    .filter({ hasText: "Synthetic conflicting-model evidence" });
  await expect(
    conflictRow.getByRole("button", { name: "Review merge", exact: true }),
  ).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    `/suggestions?family=product_pair&record=product:${second.id}`,
  );
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Keep (target):", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ deletedAt: productTable.deletedAt })
            .from(productTable)
            .where(
              eq(
                productTable.id,
                await resolveOrThrow(db, "product", conflicted.id),
              ),
            )
        )[0]?.deletedAt,
    )
    .toBeNull();
  const merged = await getDb(db)
    .select({ deletedAt: productTable.deletedAt })
    .from(productTable)
    .where(inArray(productTable.id, [firstId, secondId]));
  expect(merged.filter((row) => row.deletedAt !== null)).toHaveLength(1);
  expect(merged.filter((row) => row.deletedAt === null)).toHaveLength(1);
});
