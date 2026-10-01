import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import {
  financialBookingInput,
  financialBookingPreview,
  financialBookingResult,
} from "@cubby/schemas/financial-booking";
import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { spendingCategoryCreateInput } from "@cubby/schemas/spending-category";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementCsvCommitInput,
  statementCsvCommitOut,
  statementCsvPreviewOut,
} from "@cubby/schemas/statement-row";
import { testUserId } from "@cubby/schemas/testing";
import { request } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { z } from "zod";

import { httpContract } from "~/lib/generated/http-contract.gen";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "~/server/repo/member-login";

import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./context";

// Generated Swift Encodable omits nil properties when printing the decoded
// response. Retain the shared validators and restore only their nullable fields.
const previewSchema = statementCsvPreviewOut.shape.preview.unwrap();
const previewRow = previewSchema.shape.rows.element;
const proposed = previewRow.shape.proposed;
const existing = previewRow.shape.existingTransactions.unwrap().element;
const swiftStatementCsvPreviewOut = statementCsvPreviewOut.extend({
  source: statementCsvPreviewOut.shape.source.default(null),
  preview: previewSchema
    .extend({
      rows: z.array(
        previewRow.extend({
          accountId: previewRow.shape.accountId.default(null),
          accountName: previewRow.shape.accountName.default(null),
          provisionalAccount: previewRow.shape.provisionalAccount.default(null),
          proposed: proposed.extend({
            transactionDate: proposed.shape.transactionDate.default(null),
            merchant: proposed.shape.merchant.default(null),
            rawDescription: proposed.shape.rawDescription.default(null),
            sourceCategory: proposed.shape.sourceCategory.default(null),
            notes: proposed.shape.notes.default(null),
          }),
          existingTransactions: z
            .array(
              existing.extend({
                postedDate: existing.shape.postedDate.default(null),
                transactionDate: existing.shape.transactionDate.default(null),
                merchant: existing.shape.merchant.default(null),
                rawDescription: existing.shape.rawDescription.default(null),
              }),
            )
            .default([]),
        }),
      ),
    })
    .nullable()
    .default(null),
});

type ScenarioInput = {
  pool: Pool;
  origin: string;
  artifacts: string;
  userId: string;
  runNative: (
    args: string[],
    outputPath: string,
    errorPath: string,
  ) => Promise<void>;
};

function requireFact(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

/**
 * Real Swift file ingress and generated OpenAPI calls guard these failures:
 * preview writes, implicit booking, collapsed physical occurrences, duplicate
 * retry writes, guessed cross-provider links, and overwritten canonical dates.
 * The caller owns the disposable Worker, native build, and verifiable bundle.
 */
export async function runSwiftStatementCsvScenario(input: ScenarioInput) {
  const { pool, origin, artifacts, runNative } = input;
  const context = buildKernelContext(
    buildScenarioDatabase(pool),
    testUserId(input.userId),
  );
  const account = await createFixtureWithContext(
    context,
    "financialAccount",
    financialAccountCreateInput.parse({
      name: "Synthetic CLI CSV card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic CLI Visa",
          externalAccountId: null,
        },
        {
          source: "mint",
          alias: "Synthetic CLI Visa",
          externalAccountId: null,
        },
      ],
    }),
  );

  const snapshot = async () => {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM "Expense") AS expenses,
        (SELECT count(*)::int FROM "InventoryEntry") AS inventory,
        (SELECT count(*)::int FROM "FinancialTransaction") AS transactions,
        (SELECT count(*)::int FROM "StatementRow") AS evidence,
        (SELECT count(*)::int FROM "StatementImport") AS imports
    `);
    return z
      .object({
        expenses: z.number(),
        inventory: z.number(),
        transactions: z.number(),
        evidence: z.number(),
        imports: z.number(),
      })
      .parse(result.rows[0]);
  };
  const before = await snapshot();
  let invocation = 0;
  const refusalEvidence: string[] = [];
  const invoke = async (args: string[], expectedError?: string) => {
    invocation++;
    const outputPath = path.join(artifacts, `native-csv-${invocation}.json`);
    const errorPath = path.join(
      artifacts,
      `native-csv-${invocation}.stderr.txt`,
    );
    await writeFile(errorPath, "");
    try {
      await runNative(
        ["headless-statement-csv-import", "--base-url", origin, ...args],
        outputPath,
        errorPath,
      );
    } catch (error) {
      if (!expectedError) throw error;
      const diagnostic = await readFile(errorPath, "utf8");
      requireFact(
        diagnostic.trim() === expectedError,
        `Native CSV failed for an unexpected reason: ${diagnostic.trim()}`,
      );
      refusalEvidence.push(errorPath);
      return outputPath;
    }
    requireFact(
      !expectedError,
      "Native CSV accepted a review that should be refused",
    );
    return outputPath;
  };
  const native = async (args: string[]) => {
    const decoded: unknown = JSON.parse(
      await readFile(await invoke(args), "utf8"),
    );
    return decoded;
  };
  const file = {
    fileName: "synthetic-cli-monarch.csv",
    text: [
      "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id",
      "2026-08-18,Synthetic CLI Cafe,Food,Synthetic CLI Visa,CLI CAFE,,-4.50,cli-coffee-one",
      "2026-08-18,Synthetic CLI Cafe,Food,Synthetic CLI Visa,CLI CAFE,,-4.50,cli-coffee-two",
      "2026-08-18,Synthetic Zero,Other,Synthetic CLI Visa,ZERO,,0,cli-zero",
    ].join("\n"),
  };
  const filePath = path.join(artifacts, file.fileName);
  await writeFile(filePath, file.text);
  const preview = swiftStatementCsvPreviewOut.parse(
    await native(["--file", filePath]),
  );
  requireFact(
    JSON.stringify(await snapshot()) === JSON.stringify(before),
    "Swift CSV preview wrote data",
  );
  const rows = preview.preview?.rows ?? [];
  requireFact(
    preview.totalRows === 3 && preview.zeroValueRows === 1,
    "Swift CSV preview lost physical source occurrences",
  );
  requireFact(
    rows.length === 2 && rows.every((row) => row.status === "ready_to_create"),
    "Swift CSV preview did not expose both independently reviewable charges",
  );

  const reviewPath = path.join(artifacts, "synthetic-cli-review.json");
  const reviewed = statementCsvCommitInput.parse({
    ...file,
    selected: rows.map((row) => ({ key: row.key, kind: "purchase" })),
  });
  await writeFile(reviewPath, JSON.stringify(reviewed));
  // A review of different bytes must fail before any server mutation.
  const changedReviewPath = path.join(
    artifacts,
    "synthetic-cli-stale-review.json",
  );
  await writeFile(
    changedReviewPath,
    JSON.stringify({ ...reviewed, text: `${file.text}\n` }),
  );
  await invoke(
    ["--file", filePath, "--review-file", changedReviewPath],
    "Review must name this exact CSV file, bytes, and mapping",
  );
  requireFact(
    JSON.stringify(await snapshot()) === JSON.stringify(before),
    "Native stale file review wrote data",
  );
  const committed = statementCsvCommitOut.parse(
    await native(["--file", filePath, "--review-file", reviewPath]),
  );
  requireFact(
    committed.transactions === 2 && committed.evidence === 3,
    "Explicit native CSV review did not create two charges and three source rows",
  );
  const rowVersions = async () =>
    (
      await pool.query(`
    SELECT "externalId", "accountId", "updatedAt", xmin::text AS version
    FROM "StatementRow" WHERE "accountDescriptor" = 'Synthetic CLI Visa'
    ORDER BY "externalId"
  `)
    ).rows;
  const savedVersions = await rowVersions();
  const retryPreview = swiftStatementCsvPreviewOut.parse(
    await native(["--file", filePath]),
  );
  requireFact(
    retryPreview.preview?.rows.every(
      (row) => row.status === "already_recorded",
    ) === true,
    "Native CSV retry did not report already-recorded charges",
  );
  const retry = statementCsvCommitOut.parse(
    await native(["--file", filePath, "--review-file", reviewPath]),
  );
  requireFact(
    retry.transactions === 0 && retry.evidence === 0,
    "Native exact-file retry duplicated records",
  );
  requireFact(
    JSON.stringify(await rowVersions()) === JSON.stringify(savedVersions),
    "Native exact-file retry rewrote source observations",
  );

  const mint = {
    fileName: "synthetic-cli-mint.csv",
    text: "Date,Description,Original Description,Amount,Transaction Type,Category,Account Name\n2026-08-17,Synthetic CLI Cafe,CLI CAFE,4.50,debit,Food,Synthetic CLI Visa",
  };
  const mintPath = path.join(artifacts, mint.fileName);
  await writeFile(mintPath, mint.text);
  const ambiguous = swiftStatementCsvPreviewOut.parse(
    await native(["--file", mintPath]),
  );
  const candidate = ambiguous.preview?.rows[0];
  requireFact(
    candidate?.status === "possible_existing" &&
      candidate.existingTransactionIds.length === 2,
    "Native cross-provider preview guessed a match for ambiguous date evidence",
  );
  requireFact(
    candidate.proposed.transactionDate === null &&
      candidate.proposed.postedDate === "2026-08-17",
    "Native generated CSV preview lost source date semantics",
  );
  const beforeAmbiguity = await snapshot();
  const guessedReviewPath = path.join(
    artifacts,
    "synthetic-cli-guessed-review.json",
  );
  const guessedReview = statementCsvCommitInput.parse({
    ...mint,
    selected: [{ key: candidate.key, kind: "purchase" }],
  });
  await writeFile(guessedReviewPath, JSON.stringify(guessedReview));
  const expectedRefusal = `Statement row ${candidate.key} needs review: possible_existing.`;
  const refusalWirePath = path.join(
    artifacts,
    "statement-csv-refusal-wire.json",
  );
  // Check the actual Worker response before the native decoder. A generic
  // HTTP failure must not count as the expected domain refusal.
  const http = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: { cookies: [], origins: [] },
  });
  try {
    const signIn = await http.post("/api/auth/sign-in/email", {
      data: { email: "sim@cubby.localhost", password: "cubby-sim-local-only" },
    });
    requireFact(signIn.ok(), "CSV refusal probe could not authenticate");
    const response = await http.fetch(
      httpContract.statementRow.commitCsv.path,
      {
        method: httpContract.statementRow.commitCsv.method,
        data: guessedReview,
      },
    );
    const body: unknown = await response.json();
    await writeFile(
      refusalWirePath,
      `${JSON.stringify({ status: response.status(), body }, null, 2)}\n`,
    );
    const refusal = publicStartOperationErrorSchema.parse(body);
    requireFact(
      response.status() === 400 &&
        refusal.code === "BAD_REQUEST" &&
        refusal.reason === "CONSTRAINT_VIOLATION" &&
        refusal.message === expectedRefusal,
      "CSV ambiguous review did not return its canonical API refusal",
    );
  } finally {
    await http.dispose();
  }
  await invoke(
    ["--file", mintPath, "--review-file", guessedReviewPath],
    `HTTP 400 BAD_REQUEST: ${expectedRefusal}`,
  );
  requireFact(
    JSON.stringify(await snapshot()) === JSON.stringify(beforeAmbiguity),
    "Native ambiguous selection wrote data before review",
  );
  const target = candidate.existingTransactionIds[0];
  requireFact(
    target !== undefined,
    "Native CSV preview has no reviewed target",
  );
  const canonical = async () =>
    (
      await pool.query(
        `
    SELECT amount, status, "transactionDate", "postedDate" FROM "FinancialTransaction"
    WHERE shortcode = $1
  `,
        [target],
      )
    ).rows;
  const canonicalBefore = await canonical();
  const mintReviewPath = path.join(artifacts, "synthetic-cli-mint-review.json");
  await writeFile(
    mintReviewPath,
    JSON.stringify(
      statementCsvCommitInput.parse({
        ...mint,
        selected: [{ key: candidate.key, transactionId: target }],
      }),
    ),
  );
  const attached = statementCsvCommitOut.parse(
    await native(["--file", mintPath, "--review-file", mintReviewPath]),
  );
  requireFact(
    attached.transactions === 0 &&
      attached.attached === 1 &&
      attached.evidence === 1,
    "Reviewed native CSV attachment did not preserve the existing charge",
  );
  requireFact(
    JSON.stringify(await canonical()) === JSON.stringify(canonicalBefore),
    "Native CSV attachment overwrote canonical amount, status, or dates",
  );
  const after = await snapshot();
  requireFact(
    after.transactions === before.transactions + 2 &&
      after.evidence === before.evidence + 4,
    "Native CSV journey produced unexpected booking or evidence totals",
  );
  requireFact(
    after.expenses === before.expenses && after.inventory === before.inventory,
    "Native CSV import implicitly created Expense or stock records",
  );
  const verifyPagedDuplicates = async () => {
    const duplicateFile = {
      fileName: "synthetic-cli-paged-duplicates.csv",
      text: [
        "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id",
        ...Array.from(
          { length: 201 },
          (_, index) =>
            `2026-08-25,Synthetic Page Store,Shopping,Synthetic CLI Visa,PAGE STORE,,-9.00,${index === 0 || index === 200 ? "page-duplicate" : index === 1 ? "zero-duplicate" : `page-${index}`}`,
        ),
        "2026-08-25,Synthetic Page Store,Shopping,Synthetic CLI Visa,PAGE STORE,,0,zero-duplicate",
      ].join("\n"),
    };
    const duplicatePath = path.join(artifacts, duplicateFile.fileName);
    await writeFile(duplicatePath, duplicateFile.text);
    const beforeDuplicates = await snapshot();
    const firstPage = swiftStatementCsvPreviewOut.parse(
      await native(["--file", duplicatePath]),
    );
    const lastPage = swiftStatementCsvPreviewOut.parse(
      await native(["--file", duplicatePath, "--preview-offset", "200"]),
    );
    const duplicates = [
      firstPage.preview?.rows[0],
      firstPage.preview?.rows[1],
      lastPage.preview?.rows[0],
    ];
    requireFact(
      firstPage.hasMore &&
        !lastPage.hasMore &&
        firstPage.totalRows === 202 &&
        firstPage.zeroValueRows === 1 &&
        duplicates.every(
          (row) => row?.status === "indistinguishable_duplicate",
        ) &&
        firstPage.preview?.summary.indistinguishableDuplicate === 2 &&
        lastPage.preview?.summary.indistinguishableDuplicate === 1,
      "Whole-file provider duplicates escaped pagination or zero-value filtering",
    );
    for (const [index, row] of duplicates.entries()) {
      requireFact(row !== undefined, "Duplicate preview occurrence is absent");
      const refusalPath = path.join(
        artifacts,
        `synthetic-page-refusal-${index}.json`,
      );
      await writeFile(
        refusalPath,
        JSON.stringify(
          statementCsvCommitInput.parse({
            ...duplicateFile,
            selected: [{ key: row.key, kind: "purchase" }],
          }),
        ),
      );
      await invoke(
        ["--file", duplicatePath, "--review-file", refusalPath],
        `HTTP 400 BAD_REQUEST: Statement row ${row.key} needs review: indistinguishable_duplicate.`,
      );
      requireFact(
        JSON.stringify(await snapshot()) === JSON.stringify(beforeDuplicates),
        "Duplicate CSV refusal wrote transactions or source evidence",
      );
    }
    const evidenceReviewPath = path.join(
      artifacts,
      "synthetic-page-evidence-review.json",
    );
    await writeFile(
      evidenceReviewPath,
      JSON.stringify(
        statementCsvCommitInput.parse({
          ...duplicateFile,
          selected: [],
        }),
      ),
    );
    const evidenceOnly = statementCsvCommitOut.parse(
      await native([
        "--file",
        duplicatePath,
        "--review-file",
        evidenceReviewPath,
      ]),
    );
    requireFact(
      evidenceOnly.evidence === 202 &&
        evidenceOnly.transactions === 0 &&
        evidenceOnly.attached === 0,
      "Evidence-only import collapsed duplicate provider occurrences",
    );
    const duplicateRetry = statementCsvCommitOut.parse(
      await native([
        "--file",
        duplicatePath,
        "--review-file",
        evidenceReviewPath,
      ]),
    );
    requireFact(
      duplicateRetry.evidence === 0 &&
        duplicateRetry.alreadyPresent === 202 &&
        duplicateRetry.transactions === 0,
      "Evidence-only duplicate retry was not idempotent",
    );
  };
  const verifyDateMatching = async () => {
    for (const [name, transactionDate, postedDate, expected] of [
      ["transaction-near", "2026-09-10", "2026-09-17", "possible_existing"],
      ["posted-near", "2026-09-03", "2026-09-10", "possible_existing"],
      ["both-far", "2026-09-03", "2026-09-17", "ready_to_create"],
    ] as const) {
      const merchant = `Synthetic date ${name}`;
      const seeded = await createFixtureWithContext(
        context,
        "financialTransaction",
        financialTransactionCreateInput.parse({
          accountId: account.id,
          purchaseId: null,
          kind: "purchase",
          status: "posted",
          amount: 13,
          transactionDate,
          postedDate,
          merchant,
          rawDescription: merchant,
          sourceCategory: null,
          sourceRefs: [],
          notes: null,
        }),
      );
      const dateFile = {
        fileName: `synthetic-${name}.csv`,
        text: `Date,Description,Original Description,Amount,Transaction Type,Category,Account Name\n2026-09-10,${merchant},${merchant},13,debit,Shopping,Synthetic CLI Visa`,
      };
      const datePath = path.join(artifacts, dateFile.fileName);
      await writeFile(datePath, dateFile.text);
      const beforeDate = await snapshot();
      const datePreview = swiftStatementCsvPreviewOut.parse(
        await native(["--file", datePath]),
      );
      const row = datePreview.preview?.rows[0];
      requireFact(
        row?.status === expected &&
          row.existingTransactionIds.length ===
            (expected === "possible_existing" ? 1 : 0),
        `CSV candidate matching lost either-date semantics: ${name}`,
      );
      requireFact(
        JSON.stringify(await snapshot()) === JSON.stringify(beforeDate),
        "Date candidate preview wrote data",
      );
      if (expected === "ready_to_create") continue;
      requireFact(
        row.existingTransactionIds[0] === seeded.id,
        "CSV date preview selected a different charge",
      );
      const readCharge = async () =>
        (
          await pool.query(
            'SELECT amount, status, "transactionDate", "postedDate" FROM "FinancialTransaction" WHERE shortcode = $1',
            [seeded.id],
          )
        ).rows;
      const savedCharge = await readCharge();
      const dateReviewPath = path.join(
        artifacts,
        `synthetic-${name}-review.json`,
      );
      await writeFile(
        dateReviewPath,
        JSON.stringify(
          statementCsvCommitInput.parse({
            ...dateFile,
            selected: [{ key: row.key, kind: "purchase" }],
          }),
        ),
      );
      await invoke(
        ["--file", datePath, "--review-file", dateReviewPath],
        `HTTP 400 BAD_REQUEST: Statement row ${row.key} needs review: possible_existing.`,
      );
      requireFact(
        JSON.stringify(await snapshot()) === JSON.stringify(beforeDate),
        "Date candidate creation refusal wrote data",
      );
      await writeFile(
        dateReviewPath,
        JSON.stringify(
          statementCsvCommitInput.parse({
            ...dateFile,
            selected: [{ key: row.key, transactionId: seeded.id }],
          }),
        ),
      );
      const result = statementCsvCommitOut.parse(
        await native(["--file", datePath, "--review-file", dateReviewPath]),
      );
      requireFact(
        result.attached === 1 &&
          result.transactions === 0 &&
          result.evidence === 1 &&
          JSON.stringify(await readCharge()) === JSON.stringify(savedCharge),
        "Either-date attachment changed the canonical charge",
      );
    }
    const final = await snapshot();
    requireFact(
      final.transactions === after.transactions + 3 &&
        final.evidence === after.evidence + 204 &&
        final.expenses === before.expenses &&
        final.inventory === before.inventory,
      "Paged duplicates and either-date review produced unexpected writes",
    );
    return final;
  };
  await verifyPagedDuplicates();
  const final = await verifyDateMatching();
  const booking = await verifySharedBooking(input, target);
  console.log(
    "[headless-csv-e2e] Swift file preview, explicit review, exact retry, and ambiguous date attachment verified",
  );
  const evidencePath = path.join(artifacts, "statement-csv-results.json");
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        scenario: "swift-statement-csv",
        status: "passed",
        cases: [
          "preview-no-writes",
          "exact-file-review-binding",
          "physical-occurrences-and-zero-evidence",
          "exact-retry-no-writes",
          "ambiguous-date-match-refused",
          "canonical-refusal-wire-and-native-diagnostics",
          "reviewed-attachment-preserves-canonical-charge",
          "no-implicit-expense-or-inventory",
          "whole-file-provider-duplicate-pages-and-zero-rows",
          "duplicate-refusal-before-writes",
          "duplicate-evidence-only-and-retry",
          "either-date-explicit-attachment-preserves-charge",
          "both-dates-outside-window-no-candidate",
          "shared-swift-booking-preview-no-writes",
          "shared-swift-reviewed-booking-and-replay",
        ],
        createdTransactions: after.transactions - before.transactions,
        seededCanonicalTransactions: 3,
        recordedEvidence: final.evidence - before.evidence,
        nativeInvocations: invocation,
        booking,
      },
      null,
      2,
    )}\n`,
  );
  return [evidencePath, refusalWirePath, ...refusalEvidence];
}

async function verifySharedBooking(
  input: ScenarioInput,
  transactionId: string,
) {
  const context = buildKernelContext(
    buildScenarioDatabase(input.pool),
    testUserId(input.userId),
  );
  let member = await currentMemberLedgerParty(context.db, context.actorContext);
  if (!member) {
    const created = await createFixtureWithContext(
      context,
      "ledgerParty",
      ledgerPartyCreateInput.parse({
        name: "Synthetic CLI reviewer",
        kind: "member",
      }),
    );
    await setMemberLoginParty(
      context.db,
      context.auth.userId,
      parseShortcodeFor("ledgerParty", created.id),
      context.actorContext,
    );
    member = await currentMemberLedgerParty(context.db, context.actorContext);
  }
  requireFact(
    member !== undefined && member !== null,
    "Native booking fixture member is missing",
  );
  const vendor = await createFixtureWithContext(
    context,
    "vendor",
    vendorCreateInput.parse({ name: "Synthetic CLI supplier" }),
  );
  const category = await createFixtureWithContext(
    context,
    "spendingCategory",
    spendingCategoryCreateInput.parse({ name: "Synthetic CLI household" }),
  );
  const argsPath = path.join(
    input.artifacts,
    "synthetic-cli-booking-input.json",
  );
  const previewPath = path.join(input.artifacts, "native-booking-preview.json");
  await writeFile(
    argsPath,
    JSON.stringify(
      financialBookingInput.parse({
        transactionId,
        vendorId: vendor.id,
        spendingCategoryId: category.id,
      }),
    ),
  );
  const countExpenses = async () =>
    z.coerce
      .number()
      .parse(
        (
          await input.pool.query(
            'SELECT count(*) AS n FROM "Expense" WHERE "deletedAt" IS NULL',
          )
        ).rows[0].n,
      );
  const before = await countExpenses();
  const invoke = async (flag: string, file: string, output: string) => {
    await input.runNative(
      ["headless-financial-booking", "--base-url", input.origin, flag, file],
      output,
      `${output}.stderr.txt`,
    );
    return JSON.parse(await readFile(output, "utf8"));
  };
  const raw = await invoke("--input-file", argsPath, previewPath);
  const preview = financialBookingPreview
    .extend({
      categoryOverride:
        financialBookingPreview.shape.categoryOverride.default(null),
      funderName: financialBookingPreview.shape.funderName.default(null),
    })
    .parse(raw);
  requireFact(
    preview.action === "create_aggregate" && (await countExpenses()) === before,
    "Shared native booking preview wrote economics",
  );
  // The reviewed native response is reused byte-for-byte for commit and replay.
  const first = financialBookingResult
    .extend({ expenseId: financialBookingResult.shape.expenseId.default(null) })
    .parse(
      await invoke(
        "--review-file",
        previewPath,
        path.join(input.artifacts, "native-booking-commit.json"),
      ),
    );
  const retry = financialBookingResult
    .extend({ expenseId: financialBookingResult.shape.expenseId.default(null) })
    .parse(
      await invoke(
        "--review-file",
        previewPath,
        path.join(input.artifacts, "native-booking-replay.json"),
      ),
    );
  requireFact(
    first.expenseId !== null &&
      retry.replayed &&
      retry.purchaseId === first.purchaseId &&
      (await countExpenses()) === before + 1,
    "Shared native reviewed booking duplicated or lost its aggregate",
  );
  return { previewWrites: 0, expenseDelta: 1, replayed: true };
}
