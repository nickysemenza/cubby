import {
  financialTransactionCreateInput,
  type FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  parseShortcodeFor,
  type FinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import {
  type StatementTransactionApplication,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { runAfterCommit, unwrapDb, withTransaction } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
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
  type ChargeProposal,
  regenerateCharges,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { isMoneyMoveKind } from "~/server/domains/statement-import/repo/statement-transaction-kind";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { transitionAssessmentState } from "~/server/generic/assessment/repo/assessment-state";
import { settlementRefsIncluding } from "~/server/generic/entity-links/repo/entity-external-ids";

import {
  currentStatementApplication,
  loadStatementApplication,
  statementApplicationSelection,
  statementTransactionPatch,
} from "./statement-suggestion-application";

const log = createLogger("statement-suggestions");

const refused = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);

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
  const loaded = await loadStatementApplication(db, state);
  const { subject, published, stored } = loaded;
  const { application } = input;
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
    await transitionAssessmentState(
      tx,
      state.id,
      { status: "applied" },
      { kind: "statement_applied" },
    );
  });

  const charge = { source: subject.source, chargeKey: subject.chargeKey };
  const current = await currentStatementApplication(db, loaded);
  const judgment = current.judgment;
  const { accountCode, codeOf, targetId } = await statementApplicationSelection(
    db,
    judgment,
    application,
  );
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
        targetId!,
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
      appliedTransactionId = codeOf(targetId!);
      break;
    case "void":
      await updateFinancialTransaction(
        db,
        codeOf(targetId!),
        { status: "void" },
        actor,
      );
      break;
  }
  if (appliedTransactionId) {
    const spending = await previewFinancialSpending(db, {
      transactionId: appliedTransactionId,
      ...application.booking,
      advice: published.spending?.request.advice ?? null,
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
  accountCode: string,
  effects: Effects,
) {
  const create = judgment.create!;
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

async function applyAttach(
  db: Database,
  judgment: StatementTransactionJudgment,
  application: StatementTransactionApplication,
  codeOf: (id: string) => FinancialTransactionShortcode,
  targetId: string,
  effects: Effects,
) {
  const create = judgment.create!;
  const data: FinancialTransactionUpdateData = {
    sourceRefs: await settlementRefsIncluding(db, targetId, create.sourceRef),
    ...statementTransactionPatch(judgment, application),
  };
  await effects.claimRows();
  await updateFinancialTransaction(db, codeOf(targetId), data, effects.actor);
  return codeOf(targetId);
}

async function applySupersede(
  db: Database,
  proposal: ChargeProposal,
  codeOf: (id: string) => FinancialTransactionShortcode,
  effects: Effects,
) {
  const { judgment } = proposal;
  const supersede = judgment.supersede!;
  const create = judgment.create!;
  const { rows: pendingRows } = await unwrapDb(db).execute<{
    source: string;
    externalId: string;
  }>(sql`
    SELECT source, "externalId" FROM "StatementRow"
    WHERE id IN (${sql.join(
      supersede.pendingRowIds.map((id) => sql`${id}::uuid`),
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
  const transactionId = supersede.pendingTransactionId;
  await updateFinancialTransaction(
    db,
    codeOf(transactionId),
    {
      sourceRefs: await settlementRefsIncluding(
        db,
        transactionId,
        create.sourceRef,
      ),
      ...statementTransactionPatch(judgment, {
        action: "supersede",
        fields: [],
      }),
    },
    effects.actor,
  );
  return codeOf(transactionId);
}
