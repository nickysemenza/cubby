import { type FinancialAccountSourceAlias } from "@cubby/schemas/financial-account";
import { financialTransactionImportPreviewInput } from "@cubby/schemas/financial-transaction";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { testShortcode } from "@cubby/schemas/testing";
import { sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  createFinancialAccount,
  financialAccountScaffold,
  updateFinancialAccount,
} from "~/server/domains/financial-account/repo/financial-account";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import {
  deletePurchases,
  readPurchaseById,
  linkExpensesToPurchase,
  mergePurchases,
} from "~/server/domains/purchase/repo/purchase";
import { sourceObservations } from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  recordSourceTransactionRecords,
  updateSourceTransactionRecords,
} from "~/server/domains/transaction-import/repo/source-transaction-record";
import { listSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record.fixtures";
import {
  findOrCreateVendor,
  readVendorById,
} from "~/server/domains/vendor/repo/vendor";
import { findFinancialTransactionAllocationDefects } from "~/server/generic/problems/repo/detectors-financial";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";

import {
  prepareFinancialStatementPreview,
  previewFinancialTransactionImport,
} from "./financial-statement-preview";
import {
  createFinancialTransaction,
  financialTransactionScaffold,
  updateFinancialTransaction,
} from "./financial-transaction";

function requireTestValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

const account = (name: string, aliases: FinancialAccountSourceAlias[] = []) =>
  buildEntity("financialAccount", {
    name,
    identity: { kind: "credit_card", network: "visa" },
    cardNumbers: [
      {
        last4: "1234",
        kind: "primary",
        validFrom: null,
        validTo: null,
        note: null,
      },
    ],
    sourceAliases: aliases,
  });

describe("financial repositories — critical invariants", () => {
  const ctx = withTestDb();

  it("serializes concurrent account alias claims", async () => {
    const results = await Promise.allSettled([
      createFinancialAccount(
        ctx.db,
        account("Concurrent Visa A", [
          {
            source: "concurrency-test",
            alias: "Visa A",
            externalAccountId: "shared-account",
          },
        ]),
        ctx.actor,
      ),
      createFinancialAccount(
        ctx.db,
        account("Concurrent Visa B", [
          {
            source: "concurrency-test",
            alias: "Visa B",
            externalAccountId: "shared-account",
          },
        ]),
        ctx.actor,
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT",
      },
    });
  });

  it("serializes concurrent transaction source-reference claims", async () => {
    const createdAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Concurrent transaction Visa"),
        ctx.actor,
      )
    ).output;
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "concurrency-test",
          label: "Synthetic source",
          fingerprint: "synthetic-race",
        },
        rows: [
          {
            rowPosition: 1,
            accountDescriptor: "Synthetic account",
            statementDate: "2026-01-01",
            providerAmount: -10,
            rawDescription: "Synthetic occurrence",
          },
        ],
      }),
      ctx.actor,
    );
    const [source] = (await listSourceTransactionRecords(ctx.db, {})).data;
    if (!source) throw new Error("Synthetic source missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: source.source, externalIds: [source.externalId] },
        data: { accountId: createdAccount.id },
      },
      ctx.actor,
    );
    const input = (amount: number) =>
      buildEntity("financialTransaction", {
        accountId: createdAccount.id,
        kind: "purchase",
        status: "pending",
        amount,
        sourceRefs: [{ source: source.source, externalId: source.chargeKey }],
      });

    const results = await Promise.allSettled([
      createFinancialTransaction(ctx.db, input(10), ctx.actor),
      createFinancialTransaction(ctx.db, input(10), ctx.actor),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
      },
    });
  });

  // Regression: these enum filters were built as sql`col = ANY(${array})`.
  // Drizzle expands a JS array in a template into a row constructor, so the
  // query went out as `= ANY(($1))` and postgres rejected it — every filtered
  // list 500'd, in both the single-value and the multi-value form.

  // Regression: `accountId`/`purchaseId` are `oneOrMany`, so a mixed batch of
  // real and bogus codes is reachable from the list API and MCP. This must
  // narrow to what resolves (matching every other list filter's
  // `resolveAllPresent` convention — locationList, productScaffold) rather than
  // silently drop the bogus code AND rather than widen to an unfiltered
  // query. An all-bogus batch still yields nothing, same as before.

  // `oneOrMany`'s array branch has no `.min(1)`, so `[]` is valid filter input
  // and reaches the repo. It must mean "no constraint on that field" — never
  // "no constraint at all", which is what an empty cross-product silently
  // produced when it collapsed `or()` to undefined.

  it("previews client-parsed Monarch snapshots idempotently without writing", async () => {
    const createdAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Monarch Visa", [
          {
            source: "monarch",
            alias: "Citi Double Cash (...1702)",
            externalAccountId: "synthetic-provider-account-a",
          },
          // The same card as a second provider labels it. Alias resolution is
          // per-source, so without this a copilot row for this account resolves
          // to nothing.
          {
            source: "copilot",
            alias: "Citi Double Cash (...1702)",
            externalAccountId: null,
          },
        ]),
        ctx.actor,
      )
    ).output;
    const row = {
      key: "row-1",
      source: "monarch",
      providerTransactionId: "synthetic-preview-event",
      providerAccountId: "synthetic-provider-account-a",
      account: "Citi Double Cash (...1702)",
      date: "2026-07-31",
      amount: -54.29,
      merchant: "Amazon",
      originalStatement: "AMZN Mktp",
      category: "Shopping",
      notes: null,
    } satisfies Parameters<
      typeof previewFinancialTransactionImport
    >[1]["rows"][number];
    const first = await previewFinancialTransactionImport(ctx.db, {
      rows: [row],
    });
    // Equal account labels cannot override contradictory provider account IDs.
    const scopedAccounts = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "synthetic-scope-a",
          providerAccountId: "synthetic-provider-account-a",
        },
        {
          ...row,
          key: "synthetic-scope-b",
          providerAccountId: "synthetic-provider-account-b",
          originalStatement: "SYNTHETIC OTHER ACCOUNT",
        },
      ],
    });
    expect(scopedAccounts.rows[0]?.accountId).toBe(createdAccount.id);
    expect(scopedAccounts.rows[1]).toMatchObject({
      status: "unresolved_account",
      accountId: null,
    });
    expect(first.rows[0]).toMatchObject({
      status: "ready_to_create",
      accountId: createdAccount.id,
      newAccount: null,
      proposed: {
        amount: 54.29,
        kind: "purchase",
        status: "observed",
        transactionDate: "2026-07-31",
        postedDate: null,
      },
    });
    expect(first.rows[0]?.existingTransactionIds).toEqual([]);

    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "monarch",
          label: "Synthetic preview source",
          fingerprint: "synthetic-preview-source",
        },
        rows: [
          {
            rowPosition: 1,
            providerTransactionId: row.providerTransactionId,
            providerAccountId: row.providerAccountId,
            providerData: {
              id: row.providerTransactionId,
              account_id: row.providerAccountId,
            },
            accountDescriptor: row.account,
            statementDate: row.date,
            providerAmount: row.amount,
            merchant: row.merchant,
            rawDescription: row.originalStatement,
          },
        ],
      }),
      ctx.actor,
    );
    const [retainedSource] = (await listSourceTransactionRecords(ctx.db, {}))
      .data;
    if (!retainedSource) throw new Error("Synthetic retained source missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: row.source,
          externalIds: [retainedSource.externalId],
        },
        data: { accountId: createdAccount.id },
      },
      ctx.actor,
    );
    const proposed = requireTestValue(
      (await previewFinancialTransactionImport(ctx.db, { rows: [row] }))
        .rows[0],
      "Expected retained preview.",
    ).proposed;
    const createdEvidence = await createRepoEntity(
      ctx,
      "financialTransaction",
      {
        accountId: createdAccount.id,
        purchaseId: null,
        kind: proposed.kind,
        status: proposed.status,
        amount: proposed.amount,
        transactionDate: proposed.transactionDate,
        postedDate: proposed.postedDate,
        merchant: proposed.merchant,
        rawDescription: proposed.rawDescription,
        sourceCategory: proposed.sourceCategory,
        sourceRefs: [proposed.sourceRef],
        notes: proposed.notes,
      },
    );
    const scopedSecondAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Synthetic scoped second account", [
          {
            source: "monarch",
            alias: "Synthetic second source account",
            externalAccountId: "synthetic-provider-account-b",
          },
        ]),
        ctx.actor,
      )
    ).output;
    const scopedLegacy = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "synthetic-legacy-b",
          providerAccountId: "synthetic-provider-account-b",
        },
      ],
    });
    expect(scopedLegacy.rows[0]?.accountId).toBe(scopedSecondAccount.id);
    expect(scopedLegacy.rows[0]?.existingTransactionIds).toEqual([]);
    expect(scopedLegacy.rows[0]?.status).not.toBe("already_recorded");
    const rejectedLegacy = await previewFinancialTransactionImport(ctx.db, {
      rows: [{ ...row, providerAccountId: "synthetic-provider-account-c" }],
    });
    expect(rejectedLegacy.rows[0]).toMatchObject({
      status: "unresolved_account",
      existingTransactionIds: [],
    });
    // Provider transaction IDs are unique within accounts, not across them.
    const reusedProviderIds = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "synthetic-reused-a",
          importFingerprint: "synthetic-account-scoped-ids",
          rowPosition: 1,
          providerTransactionId: "synthetic-reused-provider-id",
          providerAccountId: "synthetic-provider-account-a",
        },
        {
          ...row,
          key: "synthetic-reused-b",
          account: "Synthetic second source account",
          importFingerprint: "synthetic-account-scoped-ids",
          rowPosition: 2,
          providerTransactionId: "synthetic-reused-provider-id",
          providerAccountId: "synthetic-provider-account-b",
        },
      ],
    });
    expect(reusedProviderIds.rows.map((item) => item.accountId)).toEqual([
      createdAccount.id,
      scopedSecondAccount.id,
    ]);
    expect(
      reusedProviderIds.rows.every(
        (item) => item.status !== "indistinguishable_duplicate",
      ),
    ).toBe(true);

    const laterExport = await previewFinancialTransactionImport(ctx.db, {
      rows: [{ ...row, merchant: "Amazon.com", category: "Other" }],
    });
    expect(laterExport.rows[0]?.status).toBe("already_recorded");

    const changedIdentity = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "corrected-statement",
          providerTransactionId: null,
          originalStatement: "AMZN MKTP CORRECTED",
        },
      ],
    });
    expect(changedIdentity.rows[0]).toMatchObject({
      status: "possible_existing",
    });

    await updateFinancialTransaction(
      ctx.db,
      createdEvidence.output.id,
      { postedDate: "2026-07-29" },
      ctx.actor,
    );
    const correctedDateExport = await previewFinancialTransactionImport(
      ctx.db,
      {
        rows: [{ ...row, key: "corrected-date" }],
      },
    );
    expect(correctedDateExport.rows[0]?.status).toBe("already_recorded");

    const manualEvidence = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: createdAccount.id,
        kind: "purchase",
        status: "posted",
        amount: 12.34,
        postedDate: "2026-07-30",
        rawDescription: "MANUAL STATEMENT LINE",
      })
    ).output;
    const possibleExisting = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "possible-existing",
          providerTransactionId: null,
          date: "2026-07-30",
          amount: -12.34,
          originalStatement: "MANUAL STATEMENT LINE",
        },
      ],
    });
    expect(possibleExisting.rows[0]).toMatchObject({
      status: "possible_existing",
    });
    // The manual description and the nearby Amazon merchant are separate
    // plausible matches, including the latter's amount change. Review keeps
    // both candidates instead of silently selecting or creating a charge.
    expect(
      [...(possibleExisting.rows[0]?.existingTransactionIds ?? [])].sort(),
    ).toEqual([manualEvidence.id, createdEvidence.output.id].sort());

    const identityAccount = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Identity-only Visa",
        identity: { kind: "credit_card", network: "visa" },
        // A reissued card: the provider may still label the account with
        // the retired digits, so both must resolve here.
        cardNumbers: [
          {
            last4: "9999",
            kind: "primary",
            validFrom: null,
            validTo: "2024-06-30",
            note: null,
          },
          {
            last4: "9997",
            kind: "primary",
            validFrom: "2024-07-01",
            validTo: null,
            note: null,
          },
        ],
      })
    ).output;
    for (const digits of ["9999", "9997"]) {
      const identityResolved = await previewFinancialTransactionImport(ctx.db, {
        rows: [
          {
            ...row,
            key: `identity-only-account-${digits}`,
            account: `Unmapped Visa (...${digits})`,
            providerTransactionId: null,
            providerAccountId: null,
            originalStatement: "IDENTITY-ONLY LINE",
          },
        ],
      });
      expect(identityResolved.rows[0]).toMatchObject({
        status: "ready_to_create",
        accountId: identityAccount.id,
      });
    }

    // Two live accounts carrying the same digits: last four alone is not
    // unique, so the row stays unresolved rather than guessing.
    await createRepoEntity(ctx, "financialAccount", {
      name: "Sibling Visa",
      identity: { kind: "credit_card", network: "visa" },
      cardNumbers: [
        {
          last4: "9997",
          kind: "supplementary",
          validFrom: null,
          validTo: null,
          note: null,
        },
      ],
    });
    const ambiguous = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "ambiguous-digits",
          providerTransactionId: null,
          providerAccountId: null,
          account: "Unmapped Visa (...9997)",
          originalStatement: "AMBIGUOUS LINE",
        },
      ],
    });
    expect(ambiguous.rows[0]).toMatchObject({
      status: "unresolved_account",
      accountId: null,
    });

    const duplicates = await previewFinancialTransactionImport(ctx.db, {
      rows: [row, { ...row, key: "row-2" }],
    });
    expect(duplicates.rows.map((item) => item.status)).toEqual([
      "indistinguishable_duplicate",
      "indistinguishable_duplicate",
    ]);

    // A fingerprint without row positions still falls back to the shared
    // legacy ref, so identical rows cannot both be created.
    const fingerprinted = {
      ...row,
      date: "2025-01-15",
      amount: -12.34,
      originalStatement: "FINGERPRINTED LINE",
      importFingerprint: "fp-1",
      providerTransactionId: null,
      providerAccountId: null,
    };
    const fingerprintedDuplicates = await previewFinancialTransactionImport(
      ctx.db,
      {
        rows: [fingerprinted, { ...fingerprinted, key: "row-2" }],
      },
    );
    expect(fingerprintedDuplicates.rows.map((item) => item.status)).toEqual([
      "indistinguishable_duplicate",
      "indistinguishable_duplicate",
    ]);
    const positioned = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        { ...fingerprinted, rowPosition: 0 },
        { ...fingerprinted, key: "row-2", rowPosition: 1 },
      ],
    });
    expect(positioned.rows.map((item) => item.status)).toEqual([
      "ready_to_create",
      "ready_to_create",
    ]);
    expect(positioned.rows[0]!.proposed.sourceRef.externalId).not.toBe(
      positioned.rows[1]!.proposed.sourceRef.externalId,
    );
    const preparation = await prepareFinancialStatementPreview(ctx.db);
    await previewFinancialTransactionImport(
      ctx.db,
      { rows: [fingerprinted] },
      { preparation },
    );
    expect(
      await previewFinancialTransactionImport(
        ctx.db,
        {
          rows: [fingerprinted, { ...fingerprinted, key: "row-2" }],
        },
        { preparation },
      ),
    ).toEqual(fingerprintedDuplicates);
    expect(
      await previewFinancialTransactionImport(
        ctx.db,
        {
          rows: [
            { ...fingerprinted, rowPosition: 0 },
            { ...fingerprinted, key: "row-2", rowPosition: 1 },
          ],
        },
        { preparation },
      ),
    ).toEqual(positioned);

    const unresolved = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "unknown-account",
          account: "Unmapped Visa (...9998)",
          providerTransactionId: null,
          providerAccountId: null,
          originalStatement: "OTHER MERCHANT",
        },
      ],
    });
    expect(unresolved.rows[0]).toMatchObject({
      status: "unresolved_account",
      accountId: null,
      newAccount: {
        name: "Unmapped Visa (...9998)",

        identity: { kind: "credit_card", network: "visa" },
        cardNumbers: [{ last4: "9998", kind: "primary" }],
      },
    });

    // Another provider keeps its distinct source observation. The canonical
    // charge already exists within the date window, so attaching that evidence
    // requires review rather than creating another charge.
    const otherProvider = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "copilot-view",
          source: "copilot",
          importFingerprint: "synthetic-copilot-retained",
          rowPosition: 1,
        },
      ],
    });
    expect(otherProvider.rows[0]?.status).toBe("possible_existing");
    expect(otherProvider.rows[0]?.existingTransactionIds).toEqual([
      createdEvidence.output.id,
    ]);
    expect(otherProvider.rows[0]?.proposed.sourceRef).toMatchObject({
      source: "copilot",
    });
    expect(otherProvider.rows[0]?.proposed.sourceRef.externalId).not.toBe(
      proposed.sourceRef.externalId,
    );

    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "copilot",
          label: "Synthetic second provider",
          fingerprint: "synthetic-copilot-retained",
        },
        rows: [
          {
            rowPosition: 1,
            accountDescriptor: row.account,
            statementDate: row.date,
            providerAmount: row.amount,
            merchant: row.merchant,
            rawDescription: row.originalStatement,
          },
        ],
      }),
      ctx.actor,
    );
    const [copilotSource] = (
      await listSourceTransactionRecords(ctx.db, { source: "copilot" })
    ).data;
    if (!copilotSource) throw new Error("Synthetic Copilot occurrence missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: "copilot",
          externalIds: [copilotSource.externalId],
        },
        data: { accountId: createdAccount.id },
      },
      ctx.actor,
    );
    const retainedCopilot = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        {
          ...row,
          key: "copilot-retained",
          source: "copilot",
          importFingerprint: "synthetic-copilot-retained",
          rowPosition: 1,
        },
      ],
    });
    // Explicit review may accept two independently proven source occurrences on one transaction.
    const merged = await updateFinancialTransaction(
      ctx.db,
      createdEvidence.output.id,
      {
        sourceRefs: [
          proposed.sourceRef,
          requireTestValue(
            retainedCopilot.rows[0],
            "Expected the retained Copilot preview row.",
          ).proposed.sourceRef,
        ],
      },
      ctx.actor,
    );
    expect(merged.output.sourceRefs).toHaveLength(2);

    const bothRecorded = await previewFinancialTransactionImport(ctx.db, {
      rows: [
        { ...row, key: "monarch-again" },
        {
          ...row,
          key: "copilot-again",
          source: "copilot",
          importFingerprint: "synthetic-copilot-retained",
          rowPosition: 1,
        },
      ],
    });
    expect(bothRecorded.rows.map((item) => item.status)).toEqual([
      "already_recorded",
      "already_recorded",
    ]);
    // One transaction carrying two matching refs must still be reported once.
    expect(bothRecorded.rows[0]?.existingTransactionIds).toEqual([
      createdEvidence.output.id,
    ]);
  });

  it("shares retained file observations without mixing fingerprint scopes", async () => {
    const fingerprints = ["fixture-cache-first", "fixture-cache-second"];
    // Distinct charges: an identical row in a second file is a re-export of the first.
    for (const [index, fingerprint] of fingerprints.entries())
      await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            source: "monarch",
            label: `${fingerprint}.csv`,
            fingerprint,
            dateKind: "transaction",
            rowCountDeclared: 1,
          },
          rows: [
            {
              rowPosition: 1,
              accountDescriptor: "Fixture Cached Visa",
              statementDate: "2026-05-04",
              providerAmount: -10 - index,
              merchant: "Fixture Shop",
              rawDescription: "FIXTURE SHOP",
            },
          ],
          dryRun: false,
        }),
        ctx.actor,
      );
    const input = financialTransactionImportPreviewInput.parse({
      rows: fingerprints.map((fingerprint, index) => ({
        key: `cached-${index}`,
        source: "monarch",
        account: "Fixture Cached Visa",
        date: "2026-05-04",
        amount: -10 - index,
        merchant: "Fixture Shop",
        originalStatement: "FIXTURE SHOP",
        importFingerprint: fingerprint,
        rowPosition: 1,
      })),
    });
    const emptyPreparation = await prepareFinancialStatementPreview(ctx.db);
    // With no ledger candidates, retained file rows cannot affect admission.
    await previewFinancialTransactionImport(ctx.db, input, {
      preparation: emptyPreparation,
    });
    expect(emptyPreparation.sameFiles.size).toBe(0);
    const createdAccount = (
      await createFinancialAccount(
        ctx.db,
        account("Fixture Cached Visa", [
          {
            source: "monarch",
            alias: "Fixture Cached Visa",
            externalAccountId: null,
          },
        ]),
        ctx.actor,
      )
    ).output;
    const proposed = (
      await previewFinancialTransactionImport(ctx.db, {
        rows: input.rows.slice(0, 1),
      })
    ).rows[0]!.proposed;
    const retained = await getDb(ctx.db).execute<{
      externalId: string;
    }>(
      sql`
      SELECT r."chargeKey" AS "externalId" FROM ${sourceObservations} r
      JOIN "TransactionImport" i ON i.id = r."batchId"
      WHERE i.fingerprint = ${fingerprints[0]} AND r."deletedAt" IS NULL
    `,
      "objects",
    );

    const [sourceRow] = (
      await listSourceTransactionRecords(ctx.db, {
        importFingerprint: fingerprints[0],
      })
    ).data;
    if (!sourceRow) throw new Error("Synthetic cached source missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: sourceRow.source,
          externalIds: [sourceRow.externalId],
        },
        data: { accountId: createdAccount.id },
      },
      ctx.actor,
    );
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: createdAccount.id,
      kind: proposed.kind,
      status: proposed.status,
      amount: proposed.amount,
      transactionDate: proposed.transactionDate,
      postedDate: proposed.postedDate,
      merchant: proposed.merchant,
      rawDescription: proposed.rawDescription,
      sourceRefs: [
        { source: "monarch", externalId: retained[0]!.externalId },
        { source: "monarch", externalId: "fixture-known-miss" },
      ],
    });
    const preparation = await prepareFinancialStatementPreview(ctx.db);
    await previewFinancialTransactionImport(
      ctx.db,
      { rows: input.rows.slice(0, 1) },
      { preparation },
    );
    const firstScopes = preparation.sameFiles.get(fingerprints[0]!)!;
    const original = [...firstScopes.values()];
    expect(
      (await Promise.all(original)).map((positions) => positions.size).sort(),
    ).toEqual([0, 1]);
    const [cached, concurrent] = await Promise.all([
      previewFinancialTransactionImport(ctx.db, input, { preparation }),
      previewFinancialTransactionImport(ctx.db, input, { preparation }),
    ]);
    expect(cached).toEqual(
      await previewFinancialTransactionImport(ctx.db, input),
    );
    expect(concurrent).toEqual(cached);
    expect([...firstScopes.values()]).toEqual(original);
    expect(preparation.sameFiles.size).toBe(2);
    const secondScopes = preparation.sameFiles.get(fingerprints[1]!)!;
    expect(
      (await Promise.all(secondScopes.values())).every(
        (positions) => positions.size === 0,
      ),
    ).toBe(true);
  });

  /**
   * `SourceTransactionRecord.accountId` is declared `block` in
   * FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY, and it is the one edge in the
   * lifecycle registry that fails OPEN. The FK is nullable, so a missing guard
   * does not throw — the account simply vanishes while live triaged rows keep
   * pointing at it, silently discarding the triage judgment that put them
   * there. The comment on the guard records that this check was declared with
   * nothing enforcing it once already ("neither this guard nor the preview
   * queried the table") and was fixed with no regression test. Zero accounts
   * have ever been deleted in production, so the path has never run for real.
   *
   * Deliberately a separate account from the transactions test below: reusing
   * that one would trip the `FinancialTransaction.financialAccountId` block
   * (`ENTITY_DELETE_BLOCKED`) first and leave this policy unexercised.
   */
  it("blocks account deletion while a live statement row still points at it", async () => {
    const acct = (
      await createFinancialAccount(
        ctx.db,
        account("Statement-blocked"),
        ctx.actor,
      )
    ).output;
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "monarch",
          label: "block-guard.csv",
          fingerprint: "fp-block-guard",
          dateKind: "transaction",
          rowCountDeclared: 1,
          notes: null,
        },
        rows: [
          {
            rowPosition: 1,
            accountDescriptor: "Blocked Card",
            statementDate: "2026-05-04",
            providerAmount: -10,
            merchant: "Acme",
            rawDescription: "ACME",
            sourceCategory: null,
            providerStatus: "posted",
            providerNotes: null,
          },
        ],
        dryRun: false,
      }),
      ctx.actor,
    );
    const row = (await listSourceTransactionRecords(ctx.db, {})).data[0];
    expect(row).toBeDefined();
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: "monarch", externalIds: [row!.externalId] },
        data: { accountId: acct.id },
      },
      ctx.actor,
    );

    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "financialAccount", [acct.id]),
    ).rejects.toMatchObject({
      reason: "ENTITY_DELETE_BLOCKED",
    });
    // The child survives with its triage intact — the half a fail-open guard
    // would destroy.
    const stillThere = (await listSourceTransactionRecords(ctx.db, {})).data[0];
    expect(stillThere?.accountId).toBe(acct.id);

    // Clearing the blocker lets the same delete through, so the guard is
    // narrow rather than a blanket refusal.
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: "monarch", externalIds: [row!.externalId] },
        data: { accountId: null },
      },
      ctx.actor,
    );
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "financialAccount", [acct.id]),
    ).resolves.toBeDefined();
  });

  it("blocks account deletion, retains ambiguous aliases, and preserves purchase-only updates", async () => {
    const a = (
      await createFinancialAccount(
        ctx.db,
        account("Visa", [
          { source: "statement", alias: "Visa", externalAccountId: "acct-1" },
        ]),
        ctx.actor,
      )
    ).output;
    await expect(
      createFinancialAccount(
        ctx.db,
        account("Duplicate", [
          { source: "statement", alias: "Other", externalAccountId: "acct-1" },
        ]),
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT",
    });
    const vendorId = await findOrCreateVendor(ctx.db, "Finance test vendor");
    const purchase = (
      await createRepoEntity(ctx, "purchase", {
        date: "2024-01-15",
        vendorId: (await readVendorById(ctx.db, vendorId)).id,
        orderId: "finance-1",
      })
    ).output;
    const tx = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        purchaseId: purchase.id,
        kind: "purchase",
        status: "pending",
        amount: 10,
        sourceRefs: [{ source: "statement", externalId: "tx-1" }],
      })
    ).output;
    await expect(
      deleteThroughKernel(ctx.db, ctx.actor, "financialAccount", [a.id]),
    ).rejects.toMatchObject({
      reason: "ENTITY_DELETE_BLOCKED",
    });
    await expect(
      createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        kind: "purchase",
        status: "pending",
        amount: 10,
        sourceRefs: [{ source: "statement", externalId: "tx-1" }],
      }),
    ).rejects.toMatchObject({
      reason: "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
    });
    await expect(
      updateFinancialTransaction(
        ctx.db,
        tx.id,
        { status: "posted" },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      reason: "FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED",
    });
    const updated = await updateFinancialTransaction(
      ctx.db,
      tx.id,
      { purchaseId: null },
      ctx.actor,
    );
    expect(updated.output.purchaseId).toBeNull();

    for (const filters of [
      { accountId: testShortcode("financialAccount", "FAC-2222") },
      { purchaseId: testShortcode("purchase", "PUR-2222") },
    ]) {
      const filtered = await financialTransactionScaffold.read(ctx.db, {
        filters,
        sorts: [],
        pagination: {
          pageIndex: 0,
          pageSize: 100,
        },
      });
      expect(filtered).toMatchObject({ data: [], count: 0 });
    }
  });

  it("reconciles settlement separately from Expense spend and re-points/detaches transactions", async () => {
    const a = (
      await createFinancialAccount(ctx.db, account("Reconcile Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Reconcile Vendor");
    const { readVendorById } =
      await import("~/server/domains/vendor/repo/vendor");
    const vendor = await readVendorById(ctx.db, vendorId);
    const p1 = (
      await createRepoEntity(ctx, "purchase", {
        date: "2024-01-15",
        vendorId: vendor.id,
        orderId: null,
      })
    ).output;
    const p2 = (
      await createRepoEntity(ctx, "purchase", {
        date: "2024-01-15",
        vendorId: vendor.id,
        orderId: "settle-2",
      })
    ).output;
    const expense = await createRepoEntity(ctx, "expense", {
      date: "2024-01-15",
      name: "settlement line",
      trade: "other",
      costType: "materials",
      cost: 10,
      vendor: "Reconcile Vendor",
      orderId: null,
      future: false,
    });
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: p1.id, expenseIds: [expense.output.id] },
      ctx.actor,
    );
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: p1.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-01-01",
      amount: 10,
    });
    const p1Uuid = parseEntityId(
      "purchase",
      requireTestValue(
        await resolveLiveShortcode(ctx.db, p1.id, "purchase"),
        "Expected the first purchase shortcode to resolve.",
      ),
    );
    expect(
      (await readPurchaseById(ctx.db, p1Uuid)).financialReconciliation.status,
    ).toBe("match");
    await mergePurchases(
      ctx.db,
      { keepId: p1.id, mergeIds: [p2.id] },
      ctx.actor,
    );
    await deletePurchases(ctx.db, [p1.id], ctx.actor);
    const txs = await (
      await import("./financial-transaction")
    ).financialTransactionScaffold.read(ctx.db, {
      filters: { purchasePresenceFilter: "none" },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    expect(txs.data.some((row) => row.purchaseId === null)).toBe(true);
  });

  it("reports unknown, pending, and mismatch in cents while excluding void and deleted evidence", async () => {
    const a = (
      await createFinancialAccount(ctx.db, account("Status Visa"), ctx.actor)
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Status Vendor");
    const vendor = await readVendorById(ctx.db, vendorId);

    const makePurchaseWithExpense = async (
      orderId: string,
      cost: number | null,
    ) => {
      const purchase = (
        await createRepoEntity(ctx, "purchase", {
          date: "2024-01-15",
          vendorId: vendor.id,
          orderId,
        })
      ).output;
      const line = await createRepoEntity(ctx, "expense", {
        date: "2024-01-15",
        name: `line ${orderId}`,
        trade: "other",
        costType: "materials",
        cost,
        vendor: vendor.name,
        orderId,
        future: false,
      });
      await linkExpensesToPurchase(
        ctx.db,
        { purchaseId: purchase.id, expenseIds: [line.output.id] },
        ctx.actor,
      );
      const uuid = parseEntityId(
        "purchase",
        requireTestValue(
          await resolveLiveShortcode(ctx.db, purchase.id, "purchase"),
          "Expected the purchase shortcode to resolve.",
        ),
      );
      return { purchase, uuid };
    };

    const unknown = await makePurchaseWithExpense("status-unknown", 10);
    expect(
      (await readPurchaseById(ctx.db, unknown.uuid)).financialReconciliation,
    ).toMatchObject({ status: "unknown", delta: null, transactionCount: 0 });

    const unpriced = await makePurchaseWithExpense("status-unpriced", null);
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: unpriced.purchase.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-01-01",
      amount: 5,
    });
    expect(
      (await readPurchaseById(ctx.db, unpriced.uuid)).financialReconciliation,
    ).toMatchObject({ status: "unknown", delta: null, transactionCount: 1 });

    // A payment schedule part-way through: one payment posted, one still
    // planned. Settlement must compare against the INCURRED expense only —
    // a `future: true` row cannot have settled, so counting it would report a
    // mismatch for a purchase behaving exactly as intended.
    const schedule = await makePurchaseWithExpense("status-schedule", 100);
    const plannedLine = await createRepoEntity(ctx, "expense", {
      date: "2027-01-15",
      name: "status-schedule planned payment",
      trade: "other",
      costType: "materials",
      cost: 400,
      future: true,
    });
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: schedule.purchase.id, expenseIds: [plannedLine.output.id] },
      ctx.actor,
    );
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: schedule.purchase.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-01-01",
      amount: 100,
    });
    const scheduled = await readPurchaseById(ctx.db, schedule.uuid);
    // The displayed total still carries the whole commitment...
    expect(scheduled.expenseTotal).toBe(500);
    // ...but settlement only answers for the $100 actually incurred.
    expect(scheduled.financialReconciliation).toMatchObject({
      status: "match",
      delta: 0,
      postedTotal: 100,
    });

    const pending = await makePurchaseWithExpense("status-pending", 51.49);
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: pending.purchase.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-01-01",
      amount: 60.56,
    });
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: pending.purchase.id,
      kind: "refund",
      status: "expected",
      transactionDate: "2026-01-02",
      amount: -9.07,
    });
    expect(
      (await readPurchaseById(ctx.db, pending.uuid)).financialReconciliation,
    ).toMatchObject({
      status: "pending",
      postedTotal: 60.56,
      projectedTotal: 51.49,
      postedRefundTotal: 0,
      outstandingTransactionCount: 1,
    });

    const adjusted = await makePurchaseWithExpense(
      "status-refund-adjusted",
      199.26,
    );
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: adjusted.purchase.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-01-03",
      amount: 326.36,
    });
    const refunds = [
      { postedDate: "2026-01-04", amount: -100 },
      { postedDate: "2026-01-05", amount: -27.1 },
    ];
    for (const { postedDate, amount } of refunds) {
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        purchaseId: adjusted.purchase.id,
        kind: "refund",
        status: "posted",
        postedDate,
        amount,
      });
    }
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: adjusted.purchase.id,
      kind: "refund",
      status: "void",
      amount: -999,
    });
    const deletedRefund = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        purchaseId: adjusted.purchase.id,
        kind: "refund",
        status: "posted",
        postedDate: "2026-01-06",
        amount: -999,
      })
    ).output;
    await deleteThroughKernel(ctx.db, ctx.actor, "financialTransaction", [
      deletedRefund.id,
    ]);
    const adjustedReconciliation = (
      await readPurchaseById(ctx.db, adjusted.uuid)
    ).financialReconciliation;
    expect(adjustedReconciliation).toMatchObject({
      status: "match",
      postedRefundTotal: -127.1,
      transactionCount: 3,
    });
    expect(adjustedReconciliation.postedTotal).toBeCloseTo(199.26);
    expect(adjustedReconciliation.projectedTotal).toBeCloseTo(199.26);

    const mismatch = await makePurchaseWithExpense("status-mismatch", 10);
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: a.id,
      purchaseId: mismatch.purchase.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-01-03",
      amount: 12,
    });
    const voided = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        purchaseId: mismatch.purchase.id,
        kind: "adjustment",
        status: "void",
        amount: 999,
      })
    ).output;
    const deleted = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        purchaseId: mismatch.purchase.id,
        kind: "adjustment",
        status: "posted",
        postedDate: "2026-01-04",
        amount: -2,
      })
    ).output;
    await deleteThroughKernel(ctx.db, ctx.actor, "financialTransaction", [
      deleted.id,
    ]);
    const result = await readPurchaseById(ctx.db, mismatch.uuid);
    expect(result.expenseTotal).toBe(10);
    expect(result.financialReconciliation).toMatchObject({
      status: "mismatch",
      transactionCount: 1,
      postedTotal: 12,
      projectedTotal: 12,
      delta: 2,
    });
    expect(voided.status).toBe("void");
  });

  it("settles a disposal with an income payout and holds the sign rule on every path", async () => {
    const a = (
      await createFinancialAccount(
        ctx.db,
        account("Payout Checking"),
        ctx.actor,
      )
    ).output;
    const vendorId = await findOrCreateVendor(ctx.db, "Payout Marketplace");
    const vendor = await readVendorById(ctx.db, vendorId);

    // A disposal: a Purchase whose Expense is negative, settled net of fees.
    const sale = (
      await createRepoEntity(ctx, "purchase", {
        date: "2026-07-13",
        vendorId: vendor.id,
        orderId: "payout-sale-1",
        statedTotal: -140.22,
      })
    ).output;
    const proceeds = await createRepoEntity(ctx, "expense", {
      date: "2026-07-13",
      name: "nailer selling",
      trade: "other",
      costType: "tools",
      cost: -140.22,
      vendor: vendor.name,
      orderId: "payout-sale-1",
      future: false,
    });
    await linkExpensesToPurchase(
      ctx.db,
      { purchaseId: sale.id, expenseIds: [proceeds.output.id] },
      ctx.actor,
    );
    const saleUuid = parseEntityId(
      "purchase",
      requireTestValue(
        await resolveLiveShortcode(ctx.db, sale.id, "purchase"),
        "Expected the sale purchase shortcode to resolve.",
      ),
    );

    // The payout is an inflow recorded as income, and it may link.
    const payout = (
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: a.id,
        purchaseId: sale.id,
        kind: "income",
        status: "posted",
        postedDate: "2026-07-16",
        amount: -140.22,
        sourceRefs: [{ source: "statement", externalId: "payout-1" }],
      })
    ).output;
    expect(payout.purchaseId).toBe(sale.id);

    const settled = await readPurchaseById(ctx.db, saleUuid);
    expect(settled.financialReconciliation).toMatchObject({
      status: "match",
      delta: 0,
      postedTotal: -140.22,
      transactionCount: 1,
      // income is settlement evidence but never a refund — keeping these apart
      // is why the payout is not filed as kind "refund".
      postedRefundTotal: 0,
    });
    expect(settled.reconciliation).toBe("match");

    // Update path: a linked payout may not flip to an outflow. This path is
    // guarded only by the repo check — the update schema carries no refinement.
    await expect(
      updateFinancialTransaction(
        ctx.db,
        payout.id,
        { amount: 140.22 },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    // Update path: a kind outside the allowlist may not stay linked.
    await expect(
      updateFinancialTransaction(ctx.db, payout.id, { kind: "fee" }, ctx.actor),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });

    // The last line of defence when app validation is bypassed used to be a DB
    // CHECK. It was dropped with the `purchaseId` column it read: once "is this
    // linked" became a question about another table, a row-level CHECK could no
    // longer ask it. So a raw UPDATE now SUCCEEDS — and the detector is what
    // catches it. That is a real reduction in enforcement, and this asserts the
    // replacement actually fires rather than quietly assuming it does.
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "amountMinor" = 14022 WHERE "shortcode" = ${payout.id}`,
    );
    const defects = await findFinancialTransactionAllocationDefects(ctx.db);
    expect(
      defects.find((defect) => defect.id === payout.id)?.reasons,
    ).toContain("kind-sign-violation");
  });

  // Provider and owner filter accounts without collapsing distinct balances.
  it("allows independent balances and cards at the same provider", async () => {
    const vendor = await readVendorById(
      ctx.db,
      await findOrCreateVendor(ctx.db, "Stored Value Vendor"),
    );
    const member = async (name: string) =>
      requireTestValue(
        (
          await createLedgerParty(
            ctx.db,
            { name, kind: "member", notes: null },
            ctx.actor,
          )
        ).output,
        "expected member",
      ).id;
    const [memberA, memberB] = [
      await member("Stored Value Member A"),
      await member("Stored Value Member B"),
    ];
    const storedValue = (name: string, owner: string | null) =>
      createRepoEntity(ctx, "financialAccount", {
        name,
        identity: { kind: "stored_value" },
        providerVendorId: vendor.id,
        ledgerPartyId: owner,
      });

    const a = (await storedValue("Credit A", memberA)).output;
    const b = (await storedValue("Credit B", memberB)).output;
    const shared = (await storedValue("Shared card", null)).output;
    expect(a.providerVendorId).toBe(vendor.id);
    expect(a.providerVendorName).toBe("Stored Value Vendor");

    const rewards = (await storedValue("Separate rewards A", memberA)).output;
    // Multiple household balances are also independent.
    await expect(storedValue("Shared card 2", null)).resolves.toBeDefined();

    await expect(
      createRepoEntity(ctx, "financialAccount", {
        ...account("Provider on a credit card"),
        providerVendorId: vendor.id,
      }),
    ).resolves.toBeDefined();
    await expect(
      updateFinancialAccount(
        ctx.db,
        b.id,
        { identity: { kind: "cash" } },
        ctx.actor,
      ),
    ).rejects.toThrow(/fixed at creation/);

    for (const [owner, expected] of [
      [memberA, [a.id, rewards.id]],
      [memberB, [b.id]],
    ] as const) {
      const resolved = await financialAccountScaffold.read(ctx.db, {
        filters: { providerVendorId: [vendor.id], ledgerPartyId: [owner] },
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 10 },
      });
      expect(resolved.data.map((row) => row.id).sort()).toEqual(
        [...expected].sort(),
      );
    }

    // Deleting one balance leaves its siblings available.
    await deleteThroughKernel(ctx.db, ctx.actor, "financialAccount", [a.id]);
    await expect(storedValue("Credit A new", memberA)).resolves.toBeDefined();
    expect(shared.ledgerPartyId).toBeNull();
  });
});
