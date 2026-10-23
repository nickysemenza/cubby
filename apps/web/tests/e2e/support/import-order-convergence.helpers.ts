import { recordSourceTransactionRecordsOut } from "@cubby/schemas/source-transaction-record";
import type { ConvergenceNames } from "#web/tooling/convergence-harness.ts";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  resolveRunFindingOut,
  type ResolveRunFindingInput,
} from "@cubby/schemas/problems";
import {
  prepareSourceOrderReconciliationOut,
  proposedImportFix,
  type PrepareSourceOrderReconciliationInput,
} from "@cubby/schemas/purchase-import";
import type { Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { runFinding } from "~/server/testing/run-finding.fixtures";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { createEvidenceHarnessContext } from "../fixtures/core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { startOperation } from "./start-operation";
import { entityApi } from "./entity-api";
import { expect } from "./e2e-test";

/** Record normalized evidence, then explicitly approve its transaction through the kernel. */
export async function recordReviewedConvergenceStatement(
  page: Page,
  db: Awaited<ReturnType<typeof createEvidenceHarnessContext>>["db"],
  names: ConvergenceNames,
  accountId: string,
) {
  const { source, ...row } = names.sourceTransactionRecord;
  const fingerprint = `synthetic-statement-${names.token}`;
  const recorded = await startOperation(
    page.request,
    "sourceTransactionRecord.record",
    {
      import: { source, label: fingerprint, fingerprint, dateKind: "posted" },
      rows: [row],
      complete: false,
    },
  );
  expect(recorded.ok(), await recorded.text()).toBe(true);
  const result = recordSourceTransactionRecordsOut.parse(recorded.body);
  expect(result.inserted).toBe(1);
  if (!result.batchId) throw new Error("Recorded statement batch missing");
  const collection = await getDb(db).query.transactionImport.findFirst({
    where: eq(schema.transactionImport.shortcode, result.batchId),
  });
  if (!collection) throw new Error("Retained transaction import missing");
  const evidence = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: and(
      eq(schema.sourceTransactionRecord.source, source),
      eq(schema.sourceTransactionRecord.batchId, collection.id),
      notDeleted(schema.sourceTransactionRecord),
    ),
  });
  if (!evidence) throw new Error("Normalized statement evidence missing");
  const created = await entityApi(page.request).create("financialTransaction", {
    accountId,
    amount: -row.providerAmount,
    merchant: row.merchant,
    rawDescription: row.rawDescription,
    sourceCategory: row.sourceCategory,
    kind: "purchase",
    status: "posted",
    postedDate: row.statementDate,
    sourceRefs: [{ source, externalId: evidence.externalId }],
  });
  expect(created.ok(), await created.text()).toBe(true);
}

/** Itemization that arrives after a booked aggregate stays a `conflict` until
 * the member reviews it: prepare the replacement through the reconciliation
 * API, apply it from the Run page, then replay the apply. Money, stock,
 * payment evidence and statement allocations survive unchanged. */
export async function applyReviewedSourceReconciliation(
  page: Page,
  input: {
    db: Awaited<ReturnType<typeof createEvidenceHarnessContext>>["db"];
    baseURL: string;
    purchaseCode: string;
    productCode: string;
  },
) {
  const database = getDb(input.db);
  const purchaseId = await resolveOrThrow(
    input.db,
    "purchase",
    input.purchaseCode,
  );
  const openReconciliations = async () =>
    (
      await database
        .select()
        .from(runFinding)
        .where(
          and(
            eq(runFinding.entityId, purchaseId),
            eq(runFinding.status, "open"),
          ),
        )
    ).filter(
      (row) =>
        proposedImportFix.safeParse(row.proposedFix).data?.kind ===
        "reconcile_source_order",
    );
  // Callers await the import's committed receipt before reconciliation.
  const findings = await openReconciliations();
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  if (!finding) throw new Error("Reconciliation finding missing");
  const lines = () =>
    database.query.expense.findMany({
      where: and(
        eq(schema.expense.purchaseId, purchaseId),
        notDeleted(schema.expense),
      ),
    });
  const aggregate = await lines();
  expect(aggregate).toMatchObject([{ cost: 42.5, productId: null }]);
  const preserved = async () => ({
    inventory: await database.select().from(schema.inventoryEntry),
    payments: await database.select().from(schema.purchasePaymentEvidence),
    allocations: await database
      .select()
      .from(schema.financialTransactionAllocation),
  });
  const before = await preserved();
  const send = async <Output>(
    path: string,
    data: PrepareSourceOrderReconciliationInput | ResolveRunFindingInput,
    output: { parse(value: unknown): Output },
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      data,
      headers: { Origin: input.baseURL },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return output.parse(await response.json());
  };
  const expenseId = parseShortcodeFor("expense", aggregate[0]!.shortcode);
  const review = await send(
    "purchaseImport/prepareReconciliation",
    {
      id: finding.id,
      resolution: {
        kind: "replace_lines",
        expenseIds: [expenseId],
        lines: [
          {
            lineIndex: 0,
            expenseId,
            productId: parseShortcodeFor("product", input.productCode),
          },
        ],
      },
    },
    prepareSourceOrderReconciliationOut,
  );
  expect(review.spend).toEqual({ before: 42.5, after: 42.5, delta: 0 });
  // Preparing records the review; it writes no ledger, stock or settlement.
  expect(await lines()).toEqual(aggregate);
  expect(await preserved()).toEqual(before);

  const [run] = await database
    .select({ shortcode: schema.run.shortcode })
    .from(runFinding)
    .innerJoin(schema.run, eq(schema.run.id, runFinding.runId))
    .where(eq(runFinding.id, finding.id));
  if (!run) throw new Error("Reconciliation Run missing");
  const apply = page.getByRole("button", { name: "Apply fix", exact: true });
  await gotoAuthenticatedPage(
    page,
    `/runs/${run.shortcode}#import-findings`,
    apply,
  );
  await expect(apply).toHaveCount(1);
  await apply.click();
  const confirmation = page.getByRole("dialog", {
    name: "Apply fix",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Apply fix", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await expect(apply).toHaveCount(0);
  await expect(
    page.locator("#import-findings").getByText("applied", { exact: true }),
  ).toBeVisible();
  // A repeated apply of the same reviewed fingerprint is a no-op.
  expect(
    await send(
      "problems/resolveRunFinding",
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: review.reviewedFingerprint,
      },
      resolveRunFindingOut,
    ),
  ).toEqual({ id: finding.id, status: "applied" });
  const productId = await resolveOrThrow(
    input.db,
    "product",
    input.productCode,
  );
  expect(await lines()).toMatchObject([{ cost: 42.5, productId }]);
  expect(await preserved()).toEqual(before);
}
