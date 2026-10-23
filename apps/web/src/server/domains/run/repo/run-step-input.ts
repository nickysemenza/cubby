import { sweepRunInput } from "@cubby/schemas/run-fields";
import { runStepMeta } from "@cubby/schemas/run-step";
import {
  parseRunStepInputFilterToken,
  runStepInputFilterToken,
  runStepInputInspection,
  type RunStepInputInspection,
} from "@cubby/schemas/run-step-input";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { run, runStep } from "~/server/db/schema";
import { transferPairSeedKeys } from "~/server/domains/financial-transaction/repo/transfer-pair-input";
import {
  statementHoldAccounts,
  statementInputCharges,
  statementPendingInputTransactions,
} from "~/server/domains/transaction-import/repo/statement-input";
import { createAppError } from "~/server/errors/app-error";
import { listPrepare } from "~/server/generic/list/repo/field-compiler";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/** Current eligibility under recorded scope; Runs do not retain input membership. */
export async function runStepInputWhere(
  db: Database | DrizzleTransaction,
  entity: RunStepInputInspection["entity"],
  token: unknown,
): Promise<SQL> {
  const address = parseRunStepInputFilterToken(token);
  runStepInputInspection.parse({ entity, stepKey: address.stepKey });
  const runId = await resolveOrThrow(db, "run", address.run);
  const [stored] = await unwrapDb(db)
    .select({ purpose: run.purpose, input: run.input, meta: runStep.meta })
    .from(run)
    .innerJoin(
      runStep,
      and(eq(runStep.runId, run.id), eq(runStep.key, address.stepKey)),
    )
    .where(and(eq(run.id, runId), notDeleted(run)))
    .limit(1);
  if (!stored || stored.purpose !== "sweep")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Run input inspection requires an existing Sweep step",
    );
  const input = runStepMeta.parse(stored.meta).input;
  if (!input || input.mode !== "count")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Run input inspection requires the step's recorded input count and boundary",
    );
  const sweep = sweepRunInput.parse(stored.input);
  if (address.stepKey === "transfer_pair_scan") {
    const family = sweep.families.find(
      (candidate) => candidate.family === "transfer_pair",
    );
    if (!family)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "This Sweep does not cover transfer pairs",
      );
    const seeds = transferPairSeedKeys({
      since: family.scope.since ?? null,
      createdBefore: z.iso.datetime().parse(input.boundary),
    });
    return entity === "financialTransaction"
      ? sql`('ftx:' || "FinancialTransaction".shortcode) IN (SELECT key FROM (${seeds}) inputs)`
      : sql`('stmt:' || "SourceTransactionRecord".source || ':' || "SourceTransactionRecord"."chargeKey") IN (SELECT key FROM (${seeds}) inputs)`;
  }
  const family = sweep.families.find(
    (candidate) => candidate.family === "statement_transaction",
  );
  if (!family)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This Sweep does not cover statement transactions",
    );
  // Statement populations are live charge/hold predicates with no frozen cutoff.
  z.null().parse(input.boundary);
  if (address.stepKey === "statement_generate") {
    const charges = statementInputCharges(family.scope);
    // Include every live observation of each eligible charge, including older revisions.
    return sql`("SourceTransactionRecord".source, "SourceTransactionRecord"."chargeKey") IN (SELECT source, "chargeKey" FROM (${charges}) inputs)`;
  }
  const accounts = await statementHoldAccounts(db, family.scope);
  if (!accounts.length) return sql`false`;
  const holds = statementPendingInputTransactions(accounts);
  return sql`"FinancialTransaction".id IN (SELECT id FROM (${holds}) inputs)`;
}

export const runStepInputListRows = (
  entity: RunStepInputInspection["entity"],
) =>
  listPrepare(async (db, filters) => ({
    token: runStepInputFilterToken.parse(filters.runStepInput),
    where: await runStepInputWhere(db, entity, filters.runStepInput),
  })).rows(({ token, where }) => {
    const table =
      entity === "financialTransaction"
        ? sql`"FinancialTransaction"`
        : sql`"SourceTransactionRecord"`;
    return sql`SELECT ${table}.id AS "owner", ${token}::text AS "token" FROM ${table} WHERE ${where}`;
  });
