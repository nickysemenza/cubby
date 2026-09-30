import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import {
  statementCsvCommitInput,
  statementCsvCommitOut,
  statementCsvPreviewOut,
} from "@cubby/schemas/statement-row";
import { testUserId } from "@cubby/schemas/testing";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { z } from "zod";

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
  runNative: (args: string[], outputPath: string) => Promise<void>;
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
  await createFixtureWithContext(
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
  const invoke = async (args: string[]) => {
    invocation++;
    const outputPath = path.join(artifacts, `native-csv-${invocation}.json`);
    await runNative(
      ["headless-statement-csv-import", "--base-url", origin, ...args],
      outputPath,
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
  let staleReviewRefused = false;
  try {
    await invoke(["--file", filePath, "--review-file", changedReviewPath]);
  } catch {
    staleReviewRefused = true;
  }
  requireFact(
    staleReviewRefused,
    "Native CSV accepted review of different file bytes",
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
  await writeFile(
    guessedReviewPath,
    JSON.stringify(
      statementCsvCommitInput.parse({
        ...mint,
        selected: [{ key: candidate.key, kind: "purchase" }],
      }),
    ),
  );
  let guessedMatchRefused = false;
  try {
    await invoke(["--file", mintPath, "--review-file", guessedReviewPath]);
  } catch {
    guessedMatchRefused = true;
  }
  requireFact(
    guessedMatchRefused,
    "Native CSV created a transaction despite ambiguous existing matches",
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
          "reviewed-attachment-preserves-canonical-charge",
          "no-implicit-expense-or-inventory",
        ],
        createdTransactions: after.transactions - before.transactions,
        recordedEvidence: after.evidence - before.evidence,
        nativeInvocations: invocation,
      },
      null,
      2,
    )}\n`,
  );
  return evidencePath;
}
