import { assessmentSubjects } from "@cubby/schemas/assessment";
import type { FinancialTransactionUpdateData } from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  statementTransactionJudgment,
  type StatementTransactionApplication,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { assessment, type assessmentState } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

import {
  buildChargeProposals,
  buildHoldVoidProposals,
} from "./statement-suggestions";

export const refuseStatementApplication = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);

const projection = z.object({
  evidenceFingerprint: z.string(),
  refs: z.array(z.string()),
});

export async function loadStatementApplication(
  db: Database,
  state: typeof assessmentState.$inferSelect,
) {
  if (!state.active || state.status !== "pending")
    throw refuseStatementApplication(
      "This Transaction suggestion is no longer pending.",
    );
  const [prediction] = await getDb(db)
    .select({ subject: assessment.subject, judgment: assessment.judgment })
    .from(assessment)
    .where(eq(assessment.id, state.id))
    .limit(1);
  const published = statementTransactionJudgment.parse(prediction?.judgment);
  // A published review hold blocks preview and apply even if its draft can be planned.
  if (published.reviewReason)
    throw refuseStatementApplication(published.reviewReason);
  return {
    subject: assessmentSubjects.statement_transaction.parse(
      prediction?.subject,
    ),
    published,
    stored: projection.parse(state.data),
  };
}

/** Rebuild from retained evidence, never the published spending plan or client source. */
export async function currentStatementApplication(
  db: Database,
  input: Awaited<ReturnType<typeof loadStatementApplication>>,
) {
  const { subject, published, stored } = input;
  const current =
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
  if (!current || current.evidenceFingerprint !== stored.evidenceFingerprint)
    throw refuseStatementApplication(
      "The statement or transaction evidence changed since this suggestion was made. Refresh suggestions and review again.",
    );
  if (current.judgment.reviewReason)
    throw refuseStatementApplication(current.judgment.reviewReason);
  return current;
}

/** Preview and apply share selection gates before either projects any effects. */
export async function statementApplicationSelection(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
) {
  const { rows: accounts } = await unwrapDb(db).execute<{
    shortcode: string;
  }>(sql`
    SELECT shortcode FROM "FinancialAccount" WHERE id = ${judgment.accountId}::uuid AND ${notDeleted("FinancialAccount")}
  `);
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
    const { rows } = await unwrapDb(db).execute<{
      id: string;
      shortcode: string;
    }>(sql`
      SELECT id, shortcode FROM "FinancialTransaction" WHERE ${notDeleted("FinancialTransaction")}
      AND id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `);
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
