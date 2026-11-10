import type { FinancialTransactionUpdateData } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementTransactionJudgment,
  type StatementTransactionApplication,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { suggestionSubjects } from "@cubby/schemas/suggestion";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { suggestionTable } from "~/server/db/schema";
import {
  SOURCE_HELD_REASON,
  statementSuggestionSourceHeld,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { recommendedWithLabels } from "~/server/domains/transaction-import/repo/statement-charge";
import {
  statementCandidateSubject,
  statementLabelSubject,
} from "~/server/domains/transaction-import/repo/statement-label-input";
import { decideStatementKind } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import { createAppError } from "~/server/errors/app-error";
import type { SuggestionStateRow } from "~/server/generic/suggestions/repo/suggestion-state";
import { canonicalJson } from "~/server/lib/canonical-json";

import {
  buildChargeProposals,
  buildHoldVoidProposals,
} from "./statement-suggestions";

export const refuseStatementApplication = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);

const projection = z.object({
  refs: z.array(z.string()),
});

export async function loadStatementApplication(
  db: Database,
  state: SuggestionStateRow,
) {
  if (!state.active || state.status !== "pending")
    throw refuseStatementApplication(
      "This Transaction suggestion is no longer pending.",
    );
  const [prediction] = await getDb(db)
    .select({
      subject: suggestionTable.subject,
      judgment: suggestionTable.judgment,
    })
    .from(suggestionTable)
    .where(eq(suggestionTable.id, state.id))
    .limit(1);
  const sourceState = await unwrapDb(db).execute<{ held: boolean }>(
    sql`SELECT ${statementSuggestionSourceHeld("s")} AS held FROM "Suggestion" s WHERE s.id=${state.id}::uuid`,
    "objects",
  );
  if (sourceState[0]?.held)
    throw refuseStatementApplication(SOURCE_HELD_REASON);
  const published = statementTransactionJudgment.parse(prediction?.judgment);
  // A published review hold blocks preview and apply even if its draft can be planned.
  if (published.reviewReason)
    throw refuseStatementApplication(published.reviewReason);
  return {
    subject: suggestionSubjects.statement_transaction.parse(
      prediction?.subject,
    ),
    published,
    stored: projection.parse(state.data),
  };
}

/**
 * The rebuilt proposal is label-free. Carry the reviewed model labels onto it
 * while their inputs still agree, as label publication does, so the kind and
 * candidates compare like for like.
 */
function withPublishedLabels(
  current: StatementTransactionJudgment,
  published: StatementTransactionJudgment,
): StatementTransactionJudgment {
  const judgment = structuredClone(current);
  for (const candidate of judgment.candidates)
    candidate.label =
      published.candidates.find(
        (saved) =>
          saved.transactionId === candidate.transactionId &&
          canonicalJson(statementCandidateSubject(saved)) ===
            canonicalJson(statementCandidateSubject(candidate)),
      )?.label ?? null;
  if (
    judgment.create &&
    published.create &&
    canonicalJson(statementLabelSubject(judgment)) ===
      canonicalJson(statementLabelSubject(published))
  )
    Object.assign(
      judgment.create,
      decideStatementKind({
        amount: judgment.create.amount,
        votes: {
          ...judgment.create.votes,
          label: published.create.votes.label,
        },
        counterparty: {
          ...judgment.create.counterparty,
          label: published.create.counterparty.label,
        },
        transfer: judgment.transfer,
      }),
    );
  judgment.recommended = recommendedWithLabels(judgment);
  return judgment;
}

/**
 * What the member reviewed: the action, the money and dates it writes and the
 * transactions it may touch. Account history, sibling and spending-snapshot
 * drift is not here: selection and spending are recomputed at apply.
 */
function decisiveJudgment(judgment: StatementTransactionJudgment) {
  const create = judgment.create;
  return {
    recommended: judgment.recommended,
    accountId: judgment.accountId,
    statementDate: judgment.statementDate,
    providerStatus: judgment.providerStatus,
    "create.kind": create?.kind ?? null,
    "create.amount": create?.amount ?? null,
    "create.status": create?.status ?? null,
    "create.transactionDate": create?.transactionDate ?? null,
    "create.postedDate": create?.postedDate ?? null,
    "create.merchant": create?.merchant ?? null,
    "create.rawDescription": create?.rawDescription ?? null,
    "create.sourceRef": create?.sourceRef ?? null,
    candidates: judgment.candidates
      .map(({ transactionId, amount, diff }) => ({
        transactionId,
        amount,
        diff,
      }))
      .sort((left, right) =>
        left.transactionId.localeCompare(right.transactionId),
      ),
    supersede: judgment.supersede?.pendingTransactionId ?? null,
    void: judgment.void?.transactionId ?? null,
    matchedTransactionId: judgment.matchedTransactionId ?? null,
    transfer: judgment.transfer,
    transferPair: judgment.transferPair?.key ?? null,
  };
}

/** Rebuild from retained evidence, never the published spending plan or client source. */
export async function currentStatementApplication(
  db: Database,
  input: Awaited<ReturnType<typeof loadStatementApplication>>,
) {
  const { subject, published } = input;
  const rebuilt =
    published.recommended === "void"
      ? (await buildHoldVoidProposals(db, [published.accountId])).find(
          (proposal) =>
            proposal.judgment.void?.transactionId ===
            published.void?.transactionId,
        )
      : (
          await buildChargeProposals(db, [
            { source: subject.source, chargeKey: subject.chargeKey },
          ])
        )[0];
  if (!rebuilt)
    throw refuseStatementApplication(
      "This charge no longer has a Transaction suggestion. Refresh suggestions and review again.",
    );
  if (rebuilt.judgment.reviewReason)
    throw refuseStatementApplication(rebuilt.judgment.reviewReason);
  const judgment = withPublishedLabels(rebuilt.judgment, published);
  const now = Object.entries(decisiveJudgment(judgment));
  const changed = Object.entries(decisiveJudgment(published)).flatMap(
    ([key, value], index) =>
      canonicalJson(value) === canonicalJson(now[index]![1]) ? [] : [key],
  );
  if (changed.length)
    throw refuseStatementApplication(
      `The suggestion changed since review: ${changed.join(", ")}. Refresh suggestions and review again.`,
    );
  return { ...rebuilt, judgment };
}

/** Preview and apply share selection gates before either projects any effects. */
export async function statementApplicationSelection(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
) {
  const accounts = await unwrapDb(db).execute<{
    shortcode: string;
  }>(
    sql`
    SELECT shortcode FROM "FinancialAccount" WHERE id = ${judgment.accountId}::uuid AND ${notDeleted("FinancialAccount")}
  `,
    "objects",
  );
  const accountCode = accounts[0]?.shortcode;
  if (!accountCode)
    throw refuseStatementApplication(
      "The suggestion's account no longer exists.",
    );
  const ids = [
    ...judgment.candidates.map((candidate) => candidate.transactionId),
    ...(judgment.supersede ? [judgment.supersede.pendingTransactionId] : []),
    ...(judgment.void ? [judgment.void.transactionId] : []),
    ...(judgment.matchedTransactionId ? [judgment.matchedTransactionId] : []),
  ];
  const codes = new Map<string, string>();
  if (ids.length) {
    const rows = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(
      sql`
      SELECT id, shortcode FROM "FinancialTransaction" WHERE ${notDeleted("FinancialTransaction")}
      AND id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `,
      "objects",
    );
    for (const row of rows) codes.set(String(row.id), row.shortcode);
  }
  const codeOf = (id: string) => {
    const code = codes.get(id);
    if (!code)
      throw refuseStatementApplication(
        "The chosen transaction is no longer live. Review again.",
      );
    return parseShortcodeFor("financialTransaction", code);
  };
  if (application.kindOverride && application.action !== "create")
    throw refuseStatementApplication(
      "A kind override applies only when creating a transaction.",
    );
  if (application.booking && application.action === "void")
    throw refuseStatementApplication("A void cannot book spending.");
  let targetId: string | null = null;
  switch (application.action) {
    case "create": {
      if (!judgment.create)
        throw refuseStatementApplication(
          "This charge has no transaction to create.",
        );
      const rejected = new Set(application.rejectedCandidateIds);
      const live = judgment.candidates.filter(
        (candidate) => !rejected.has(codeOf(candidate.transactionId)),
      );
      if (live.length)
        throw refuseStatementApplication(
          `Possible existing transactions must be rejected before creating: ${live.map((candidate) => codeOf(candidate.transactionId)).join(", ")}.`,
        );
      break;
    }
    case "attach": {
      if (!application.transactionId && judgment.candidates.length > 1)
        throw refuseStatementApplication(
          `Name the transaction to attach to: ${judgment.candidates.map((candidate) => codeOf(candidate.transactionId)).join(", ")}.`,
        );
      const target = application.transactionId
        ? judgment.candidates.find(
            (candidate) =>
              codeOf(candidate.transactionId) === application.transactionId,
          )
        : judgment.candidates[0];
      if (!target || !judgment.create)
        throw refuseStatementApplication(
          "The chosen transaction is no longer a candidate for this charge. Review again.",
        );
      for (const field of new Set(application.fields))
        if (!target.diff.includes(field))
          throw refuseStatementApplication(
            `The transaction's ${field} already matches the statement.`,
          );
      targetId = target.transactionId;
      break;
    }
    case "supersede":
      if (!judgment.supersede || !judgment.create)
        throw refuseStatementApplication(
          "This charge no longer settles a recorded hold.",
        );
      targetId = judgment.supersede.pendingTransactionId;
      break;
    case "book":
      if (!judgment.matchedTransactionId)
        throw refuseStatementApplication(
          "The matched transaction is no longer available for booking.",
        );
      targetId = judgment.matchedTransactionId;
      break;
    case "void":
      if (!judgment.void)
        throw refuseStatementApplication(
          "This hold no longer qualifies as vanished.",
        );
      targetId = judgment.void.transactionId;
      if (
        application.transactionId &&
        application.transactionId !== codeOf(targetId)
      )
        throw refuseStatementApplication(
          "A void applies only to the vanished hold it names.",
        );
      break;
  }
  if (targetId) codeOf(targetId);
  return { accountCode, codeOf, targetId };
}

/** Both preview and apply project only fields the member chose to change. */
export function statementTransactionPatch(
  judgment: StatementTransactionJudgment,
  application: Pick<StatementTransactionApplication, "action" | "fields">,
): Pick<FinancialTransactionUpdateData, "amount" | "status" | "postedDate"> {
  const create = judgment.create;
  if (!create) return {};
  if (application.action === "supersede")
    return {
      amount: create.amount,
      status: "posted",
      postedDate: judgment.statementDate,
    };
  if (application.action !== "attach") return {};
  const selected = new Set(application.fields);
  return {
    ...(selected.has("amount") && { amount: create.amount }),
    ...(selected.has("status") && {
      status: judgment.providerStatus ?? "observed",
    }),
    ...((selected.has("postedDate") ||
      (selected.has("status") && judgment.providerStatus === "posted")) && {
      postedDate: judgment.statementDate,
    }),
  };
}
