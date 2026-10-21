import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementSuggestionPreviewInput,
  statementSuggestionPreviewOut,
  type StatementSuggestionPreviewOut,
} from "@cubby/schemas/statement-suggestion";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentState, financialTransaction } from "~/server/db/schema";
import { previewFinancialSpending } from "~/server/domains/financial-transaction/repo/financial-spending";

import {
  currentStatementApplication,
  loadStatementApplication,
  refuseStatementApplication,
  statementApplicationSelection,
  statementTransactionPatch,
} from "./statement-suggestion-application";

/** A draft is advice only: no locks, publication, aliases, or transaction writers. */
export async function previewStatementSuggestion(
  db: Database,
  raw: unknown,
): Promise<StatementSuggestionPreviewOut> {
  const input = statementSuggestionPreviewInput.parse(raw);
  const state = await getDb(db).query.assessmentState.findFirst({
    where: and(
      eq(assessmentState.id, input.assessmentId),
      eq(assessmentState.family, "statement_transaction"),
    ),
  });
  if (!state)
    throw refuseStatementApplication(
      "This Transaction suggestion is no longer available.",
    );
  if (!state.fingerprint || state.fingerprint !== input.expectedFingerprint)
    throw refuseStatementApplication(
      "Assessment evidence fingerprint changed. Refresh suggestions and review again.",
    );
  const loaded = await loadStatementApplication(db, state);
  const current = await currentStatementApplication(db, loaded);
  const { judgment } = current;
  const { application } = input;
  const { accountCode, codeOf, targetId } = await statementApplicationSelection(
    db,
    judgment,
    application,
  );
  const basis = {
    assessmentId: state.id,
    fingerprint: state.fingerprint,
    action: application.action,
  };
  const advice = loaded.published.spending?.request.advice ?? null;
  if (application.action === "create") {
    const create = judgment.create!;
    const source = financialTransactionCreateInput.parse({
      accountId: accountCode,
      purchaseId: null,
      kind: application.kindOverride ?? create.kind,
      status: create.status,
      amount: create.amount,
      transactionDate: create.transactionDate,
      postedDate: create.postedDate,
      merchant: create.merchant,
      rawDescription: create.rawDescription,
      sourceCategory: create.sourceCategory,
      sourceRefs: [create.sourceRef],
      notes: create.notes,
    });
    return statementSuggestionPreviewOut.parse({
      ...basis,
      kind: source.kind,
      amount: source.amount,
      status: source.status,
      transactionDate: source.transactionDate,
      postedDate: source.postedDate,
      merchant: source.merchant,
      rawDescription: source.rawDescription,
      spending: await previewFinancialSpending(db, {
        ...application.booking,
        source: {
          ...source,
          accountId: parseShortcodeFor("financialAccount", accountCode),
        },
        advice,
      }),
    });
  }
  const target = targetId
    ? await getDb(db).query.financialTransaction.findFirst({
        where: eq(financialTransaction.shortcode, codeOf(targetId)),
      })
    : undefined;
  if (!target)
    throw refuseStatementApplication(
      "The chosen transaction is no longer live. Review again.",
    );
  if (application.action === "void")
    return statementSuggestionPreviewOut.parse({
      ...basis,
      kind: target.kind,
      amount: target.amount,
      status: "void",
      transactionDate: target.transactionDate,
      postedDate: target.postedDate,
      merchant: target.merchant,
      rawDescription: target.rawDescription,
      spending: null,
    });
  const create = judgment.create;
  const attachment =
    create &&
    (application.action === "attach" || application.action === "supersede")
      ? {
          settlementRef: create.sourceRef,
          fields: statementTransactionPatch(judgment, application),
        }
      : undefined;
  const spending = await previewFinancialSpending(
    db,
    {
      transactionId: codeOf(target.id),
      ...application.booking,
      advice,
    },
    attachment,
  );
  if (
    spending.status === "deferred" &&
    judgment.providerStatus === "posted" &&
    create &&
    ["purchase", "refund", "fee"].includes(create.kind)
  )
    throw refuseStatementApplication(
      "The matched transaction's kind or status cannot book this spending. For a pending candidate, select Apply status to post it; otherwise edit the transaction first.",
    );
  return statementSuggestionPreviewOut.parse({
    ...basis,
    kind: target.kind,
    amount: attachment?.fields.amount ?? target.amount,
    status: attachment?.fields.status ?? target.status,
    transactionDate: target.transactionDate,
    postedDate: attachment?.fields.postedDate ?? target.postedDate,
    merchant: target.merchant,
    rawDescription: target.rawDescription,
    spending,
  });
}
