import { assessmentSubjects } from "@cubby/schemas/assessment";
import {
  financialTransactionCreateInput,
  type FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  parseShortcodeFor,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import {
  statementTransactionJudgment,
  type StatementTransactionApplication,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  getDb,
  runAfterCommit,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { assessment, assessmentState } from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  previewFinancialSpending,
  commitFinancialSpending,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import {
  createFinancialTransaction,
  updateFinancialTransaction,
} from "~/server/domains/financial-transaction/repo/financial-transaction";
import { updateStatementRows } from "~/server/domains/statement-import/repo/statement-row";
import {
  buildChargeProposals,
  buildHoldVoidProposals,
  type ChargeProposal,
  regenerateCharges,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { isMoneyMoveKind } from "~/server/domains/statement-import/repo/statement-transaction-kind";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";

const log = createLogger("statement-suggestions");

const refused = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);

const projection = z.object({
  evidenceFingerprint: z.string(),
  refs: z.array(z.string()),
});

async function shortcodes(
  db: Database,
  table: "FinancialTransaction" | "FinancialAccount",
  ids: readonly string[],
) {
  if (!ids.length) return new Map<string, string>();
  const { rows } = await unwrapDb(db).execute<{
    id: string;
    shortcode: string;
  }>(sql`
    SELECT id, shortcode FROM ${sql.identifier(table)}
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  return new Map(rows.map((row) => [String(row.id), row.shortcode]));
}

/** Apply revalidates authoritative evidence under its keys, independently of background retirement. */
export async function applyStatementTransactionSuggestion(
  db: Database,
  context: EntityKernelContext,
  state: typeof assessmentState.$inferSelect,
  input: {
    application: StatementTransactionApplication;
    corrected: boolean;
  },
) {
  const [prediction] = await getDb(db)
    .select()
    .from(assessment)
    .where(eq(assessment.id, state.id))
    .limit(1);
  const subject = assessmentSubjects.statement_transaction.parse(
    prediction?.subject,
  );
  const published = statementTransactionJudgment.parse(prediction?.judgment);
  const stored = projection.parse(state.data);
  const { application } = input;
  if (state.status !== "pending")
    throw refused("This Transaction suggestion is no longer pending.");
  if (!input.corrected && application.action !== published.recommended)
    throw refused(
      "Accepting a suggestion as is applies its recommended action; review a different choice as a correction.",
    );
  if (!input.corrected && application.kindOverride)
    throw refused("Changing the kind is a correction to the suggestion.");
  if (!input.corrected && application.booking)
    throw refused("Changing the booking is a correction to the suggestion.");

  if (
    published.transferPair &&
    application.action === "create" &&
    published.create &&
    isMoneyMoveKind(published.create.kind)
  ) {
    const { lockTransferPairLegs } =
      await import("~/server/domains/financial-transaction/repo/transfer-pair-suggestions");
    await lockTransferPairLegs(db, published.transferPair.key);
  }
  await withTransaction(db, async (tx) => {
    // Evidence keys before the transaction writers below take their rows. The
    // keys name unmatched charges, which no other transaction's refs hold.
    await lockFinancialEvidenceKeys(
      tx,
      "transaction-ref",
      stored.refs.map((ref) => {
        const split = ref.indexOf(":");
        return `${ref.slice(0, split)}\0${ref.slice(split + 1)}`;
      }),
    );
    await unwrapDb(tx)
      .update(assessmentState)
      .set({ status: "applied" })
      .where(eq(assessmentState.id, state.id));
  });

  const charge = { source: subject.source, chargeKey: subject.chargeKey };
  const current: ChargeProposal | undefined =
    published.recommended === "void"
      ? (await buildHoldVoidProposals(db, [published.accountId])).find(
          (proposal) =>
            proposal.judgment.void?.transactionId ===
            published.void?.transactionId,
        )
      : (await buildChargeProposals(db, [charge]))[0];
  if (!current || current.evidenceFingerprint !== stored.evidenceFingerprint)
    throw refused(
      "The statement or transaction evidence changed since this suggestion was made. Refresh suggestions and review again.",
    );
  const judgment = current.judgment;
  if (
    application.action === "create" &&
    published.transferPair?.clean &&
    judgment.transferPair?.clean &&
    !application.kindOverride &&
    published.create &&
    isMoneyMoveKind(published.create.kind)
  ) {
    const { applyTransferPair } =
      await import("~/server/domains/financial-transaction/repo/transfer-pair-suggestions");
    await applyTransferPair(db, context, {
      key: judgment.transferPair.key,
      expectedFingerprint: judgment.transferPair.fingerprint,
    });
    return;
  }
  const actor = context.actorContext;
  const accounts = await shortcodes(db, "FinancialAccount", [
    judgment.accountId,
  ]);
  const accountCode = accounts.get(judgment.accountId);
  if (!accountCode) throw refused("The suggestion's account no longer exists.");
  const transactionCodes = await shortcodes(db, "FinancialTransaction", [
    ...judgment.candidates.map((candidate) => candidate.transactionId),
    ...(judgment.supersede ? [judgment.supersede.pendingTransactionId] : []),
    ...(judgment.void ? [judgment.void.transactionId] : []),
    ...(judgment.matchedTransactionId ? [judgment.matchedTransactionId] : []),
  ]);
  const codeOf = (id: string) =>
    parseShortcodeFor("financialTransaction", transactionCodes.get(id)!);

  const claimRows = async () => {
    await updateStatementRows(
      db,
      {
        selector: {
          source: charge.source,
          externalIds: current.observations.map((row) => row.externalId),
        },
        data: { accountId: parseShortcodeFor("financialAccount", accountCode) },
      },
      actor,
    );
  };

  let appliedTransactionId: FinancialTransactionShortcode | undefined;
  switch (application.action) {
    case "create":
      appliedTransactionId = await applyCreate(
        db,
        judgment,
        application,
        codeOf,
        accountCode,
        {
          claimRows,
          actor,
        },
      );
      break;
    case "attach":
      appliedTransactionId = await applyAttach(
        db,
        judgment,
        application,
        codeOf,
        {
          claimRows,
          actor,
        },
      );
      break;
    case "supersede":
      appliedTransactionId = await applySupersede(db, current, codeOf, {
        claimRows,
        actor,
      });
      break;
    case "book":
      if (!judgment.matchedTransactionId)
        throw refused(
          "The matched transaction is no longer available for booking.",
        );
      appliedTransactionId = codeOf(judgment.matchedTransactionId);
      break;
    case "void":
      await applyVoid(db, judgment, application, codeOf, actor);
      break;
  }
  if (appliedTransactionId) {
    const spending = await previewFinancialSpending(db, {
      transactionId: appliedTransactionId,
      ...application.booking,
      advice:
        application.booking?.advice ??
        published.spending?.request.advice ??
        null,
    });
    if (spending.status === "deferred") {
      const kind = application.kindOverride ?? judgment.create?.kind;
      if (
        judgment.providerStatus === "posted" &&
        kind &&
        ["purchase", "refund", "fee"].includes(kind)
      )
        throw refused(
          "The matched transaction's kind or status cannot book this spending; correct it first.",
        );
    } else await commitFinancialSpending(db, spending, actor);
  }
  // A sibling's evidence included this charge being unmatched; refresh it
  // now rather than leaving it stale until a whole-ledger pass.
  if (judgment.siblings.length)
    await runAfterCommit(db, async (committed) => {
      try {
        await regenerateCharges(
          committed,
          judgment.siblings.map((chargeKey) => ({
            source: charge.source,
            chargeKey,
          })),
        );
      } catch (error) {
        // SILENT: advisory refresh only; the apply committed and the sibling's
        // own accept rechecks evidence, so the next Refresh repairs it.
        log.error("Sibling suggestion refresh failed", {
          error: scrubErrorMessage(String(error)),
        });
      }
    });
}

type Effects = {
  claimRows: () => Promise<void>;
  actor: EntityKernelContext["actorContext"];
};

async function applyCreate(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
  codeOf: (id: string) => FinancialTransactionShortcode,
  accountCode: string,
  effects: Effects,
) {
  const create = judgment.create;
  if (!create) throw refused("This charge has no transaction to create.");
  const rejected = new Set(application.rejectedCandidateIds);
  const live = judgment.candidates.filter(
    (candidate) => !rejected.has(codeOf(candidate.transactionId)),
  );
  // A transaction that may already record this money blocks a create until
  // the member has said it is a different charge.
  if (live.length)
    throw refused(
      `Possible existing transactions must be rejected before creating: ${live.map((candidate) => codeOf(candidate.transactionId)).join(", ")}.`,
    );
  await effects.claimRows();
  const created = await createFinancialTransaction(
    db,
    financialTransactionCreateInput.parse({
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
    }),
    effects.actor,
  );
  return created.output.id;
}

async function appendRef(
  db: Database,
  transactionId: string,
  ref: { source: string; externalId: string },
) {
  const existing =
    (await settlementRefsFor(db, [transactionId])).get(transactionId) ?? [];
  return existing.some(
    (saved) =>
      saved.source === ref.source && saved.externalId === ref.externalId,
  )
    ? existing
    : [...existing, ref];
}

async function applyAttach(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
  codeOf: (id: string) => FinancialTransactionShortcode,
  effects: Effects,
) {
  // With several candidates the target must be named: a default would put the
  // charge's ref on whichever transaction happened to sort first.
  if (!application.transactionId && judgment.candidates.length > 1)
    throw refused(
      `Name the transaction to attach to: ${judgment.candidates.map((candidate) => codeOf(candidate.transactionId)).join(", ")}.`,
    );
  const target = application.transactionId
    ? judgment.candidates.find(
        (candidate) =>
          codeOf(candidate.transactionId) === application.transactionId,
      )
    : judgment.candidates[0];
  if (!target || !judgment.create)
    throw refused(
      "The chosen transaction is no longer a candidate for this charge. Review again.",
    );
  const fields = new Set(application.fields);
  for (const field of fields)
    if (!target.diff.includes(field))
      throw refused(
        `The transaction's ${field} already matches the statement.`,
      );
  const data: FinancialTransactionUpdateData = {
    sourceRefs: await appendRef(
      db,
      target.transactionId,
      judgment.create.sourceRef,
    ),
  };
  if (fields.has("amount")) data.amount = judgment.create.amount;
  if (fields.has("status")) data.status = judgment.providerStatus;
  // A posted transaction needs its posted date, so posting brings the date.
  if (
    fields.has("postedDate") ||
    (fields.has("status") && judgment.providerStatus === "posted")
  )
    data.postedDate = judgment.statementDate;
  await effects.claimRows();
  await updateFinancialTransaction(
    db,
    codeOf(target.transactionId),
    data,
    effects.actor,
  );
  return codeOf(target.transactionId);
}

async function applySupersede(
  db: Database,
  proposal: ChargeProposal,
  codeOf: (id: string) => FinancialTransactionShortcode,
  effects: Effects,
) {
  const { judgment } = proposal;
  if (!judgment.supersede || !judgment.create)
    throw refused("This charge no longer settles a recorded hold.");
  const { rows: pendingRows } = await unwrapDb(db).execute<{
    source: string;
    externalId: string;
  }>(sql`
    SELECT source, "externalId" FROM "StatementRow"
    WHERE id IN (${sql.join(
      judgment.supersede.pendingRowIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND "deletedAt" IS NULL
  `);
  await effects.claimRows();
  for (const source of new Set(pendingRows.map((row) => row.source)))
    await updateStatementRows(
      db,
      {
        selector: {
          source,
          externalIds: pendingRows
            .filter((row) => row.source === source)
            .map((row) => row.externalId),
        },
        data: { supersededByExternalId: proposal.canonical.externalId },
      },
      effects.actor,
    );
  const transactionId = judgment.supersede.pendingTransactionId;
  await updateFinancialTransaction(
    db,
    codeOf(transactionId),
    {
      sourceRefs: await appendRef(db, transactionId, judgment.create.sourceRef),
      status: "posted",
      postedDate: judgment.statementDate,
      amount: judgment.create.amount,
    },
    effects.actor,
  );
  return codeOf(transactionId);
}

async function applyVoid(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
  codeOf: (id: string) => FinancialTransactionShortcode,
  actor: EntityKernelContext["actorContext"],
) {
  if (!judgment.void)
    throw refused("This hold no longer qualifies as vanished.");
  const code = codeOf(judgment.void.transactionId);
  if (application.transactionId && application.transactionId !== code)
    throw refused("A void applies only to the vanished hold it names.");
  await updateFinancialTransaction(db, code, { status: "void" }, actor);
}
