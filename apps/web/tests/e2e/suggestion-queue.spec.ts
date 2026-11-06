import { eq, inArray } from "drizzle-orm";
import { suggestionReviewBatchOut } from "@cubby/schemas/suggestion";

import { getDb } from "~/server/db/helpers";
import {
  emailReview,
  runOperation,
  product as productTable,
  expense as expenseTable,
  inventoryEntry,
} from "~/server/db/schema";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import {
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import { seedUnimportedOrderMail } from "./fixtures/mail";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchesOperation, operationResult } from "./support/dispatch-wire";

// Failure modes: Confirm fails to apply the proposed connection or changes money;
// Report incorrect fails to retain the member's history feedback.
test("one queue confirms proposals and records automatic-history feedback", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db, actor } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Synthetic queue drill");
  const { item, charge } = await createFixtureGraph(page, async (create) => {
    const brand = await create("vendor", {
      name: uniqueName(testInfo, "Example Tools"),
    });
    const item = await create("product", { name, brandId: brand.id });
    const charge = await create("expense", {
      name: `${name} receipt`,
      cost: 24,
      trade: "electrical",
    });
    return { item, charge };
  });
  const connection = await publishEntityConnection(db, {
    relation: "product-expense",
    source: { entityKind: "product", entityId: item.id },
    target: { entityKind: "expense", entityId: charge.id },
    label: "Synthetic acquisition connection",
    evidence: {
      reasons: ["Synthetic itemized evidence"],
      contradictions: [],
      unknowns: [],
    },
  });
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
  const queue = page.getByRole("table", { name: "Suggestions", exact: true });
  const proposal = queue
    .getByRole("row")
    .filter({ hasText: "Synthetic acquisition connection" });
  await expect(proposal).toHaveCount(1);
  // Feedback precedes the application transaction; only its response proves commit.
  const [application] = await Promise.all([
    page.waitForResponse((response) =>
      dispatchesOperation(response.request(), "suggestion.reviewBatch"),
    ),
    proposal.getByRole("button", { name: "Confirm", exact: true }).click(),
  ]);
  expect(
    await operationResult(
      application,
      "suggestion.reviewBatch",
      suggestionReviewBatchOut,
    ),
  ).toMatchObject([
    { ok: true, suggestionId: connection.review.suggestionId, applied: true },
  ]);
  await expect
    .poll(async () =>
      (await readSuggestionDecisions(db, connection.review.suggestionId)).some(
        (row) => row.verdict === "correct" && row.intent === "apply",
      ),
    )
    .toBe(true);

  const chargeId = await resolveOrThrow(db, "expense", charge.id);
  const productId = await resolveOrThrow(db, "product", item.id);
  expect(
    await getDb(db)
      .select({ productId: expenseTable.productId, cost: expenseTable.cost })
      .from(expenseTable)
      .where(eq(expenseTable.id, chargeId)),
  ).toEqual([{ productId, cost: 24 }]);

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

// Replaces the transient project/placement reviewers: mounting is passive,
// each stored change needs confirmation, and a coalesced move follows its survivor.
test("project assignments and placement moves use the shared queue", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db } = await createEvidenceHarnessContext(page);
  const { project, expense, source, target, to } = await createFixtureGraph(
    page,
    async (create) => {
      const project = await create("project", {
        name: uniqueName(testInfo, "Synthetic workshop refresh"),
      });
      const expense = await create("expense", {
        name: uniqueName(testInfo, "Synthetic supplies"),
        cost: 15,
        trade: "building",
      });
      const item = await create("product", {
        name: uniqueName(testInfo, "Synthetic placement tool"),
      });
      const from = await create("location", {
        name: uniqueName(testInfo, "Synthetic unplaced shelf"),
      });
      const to = await create("location", {
        name: uniqueName(testInfo, "Synthetic target shelf"),
      });
      const source = await create("inventory", {
        productId: item.id,
        locationId: from.id,
        amount: { value: 1, unit: "each" },
      });
      const target = await create("inventory", {
        productId: item.id,
        locationId: to.id,
        amount: { value: 2, unit: "each" },
      });
      return { project, expense, source, target, to };
    },
  );
  await publishEntityConnection(db, {
    relation: "expense-project",
    source: { entityKind: "expense", entityId: expense.id },
    target: { entityKind: "project", entityId: project.id },
    label: "Synthetic project assignment",
    evidence: {
      reasons: ["Synthetic dated work"],
      contradictions: [],
      unknowns: [],
    },
  });
  await publishEntityConnection(db, {
    relation: "inventory-location",
    source: { entityKind: "inventory", entityId: source.id },
    target: { entityKind: "location", entityId: to.id },
    label: "Synthetic placement move",
    evidence: {
      reasons: ["Synthetic stock destination"],
      contradictions: [],
      unknowns: [],
    },
  });
  const expenseId = await resolveOrThrow(db, "expense", expense.id);
  await gotoAuthenticatedPage(page, `/projects/${project.id}`);
  const proposals = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(proposals).toContainText("Synthetic project assignment");
  expect(
    (
      await getDb(db)
        .select({ projectId: expenseTable.projectId })
        .from(expenseTable)
        .where(eq(expenseTable.id, expenseId))
    )[0]?.projectId,
  ).toBeNull();
  await proposals.getByRole("button", { name: "Confirm", exact: true }).click();
  const projectId = await resolveOrThrow(db, "project", project.id);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ projectId: expenseTable.projectId })
            .from(expenseTable)
            .where(eq(expenseTable.id, expenseId))
        )[0]?.projectId,
    )
    .toBe(projectId);
  await gotoAuthenticatedPage(page, `/inventory/${source.id}`);
  await expect(proposals).toContainText("Synthetic placement move");
  await proposals.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/inventory/${target.id}$`));
  const targetId = await resolveOrThrow(db, "inventory", target.id);
  expect(
    (
      await getDb(db)
        .select({
          value: inventoryEntry.amountValue,
          unit: inventoryEntry.amountUnit,
        })
        .from(inventoryEntry)
        .where(eq(inventoryEntry.id, targetId))
    )[0],
  ).toEqual({ value: 3, unit: "each" });
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
