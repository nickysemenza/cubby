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
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb, withTransaction } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  lockFinancialTransactionSources,
  financialSourceRefsIncluding,
} from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  previewFinancialSpending,
  commitFinancialSpending,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import {
  createFinancialTransaction,
  updateFinancialTransaction,
} from "~/server/domains/financial-transaction/repo/financial-transaction";
import { sourceObservationFrom } from "~/server/domains/transaction-import/repo/source-observation-state";
import { updateSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import {
  type ChargeProposal,
  pendingChargesNear,
  regenerateChargesAfterCommit,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { isMoneyMoveKind } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import {
  type SuggestionStateRow,
  transitionSuggestionState,
} from "~/server/generic/suggestions/repo/suggestion-state";

import {
  currentStatementApplication,
  loadStatementApplication,
  statementApplicationSelection,
  statementTransactionPatch,
} from "./statement-suggestion-application";

const refused = (message: string) =>
  createAppError("CONSTRAINT_VIOLATION", message);
const CORRECTION_REVIEW =
  'Review it with verdict "wrong" and correction {present:true, value:<the full application>}.';

/** Apply revalidates authoritative evidence under its keys, independently of background retirement. */
export async function applyStatementTransactionSuggestion(
  db: Database,
  context: EntityKernelContext,
  state: SuggestionStateRow,
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
      `Accepting a suggestion as is applies its recommended action; a different choice is a correction. ${CORRECTION_REVIEW}`,
    );
  if (!input.corrected && application.kindOverride)
    throw refused(
      `Changing the kind is a correction to the suggestion. ${CORRECTION_REVIEW}`,
    );
  if (!input.corrected && application.booking)
    throw refused(
      `Changing the booking is a correction to the suggestion. ${CORRECTION_REVIEW}`,
    );

  if (
    published.transferPair &&
    application.action === "create" &&
    published.create &&
    isMoneyMoveKind(published.create.kind)
  ) {
    const { lockTransferPairLegs } =
      await import("~/server/domains/transaction-import/repo/transfer-pair-suggestions");
    await lockTransferPairLegs(db, published.transferPair.key);
  }
  await withTransaction(db, async (tx) => {
    // Source account judgments run later under this same reservation, before occurrence row locks.
    const pairCreate =
      published.transferPair &&
      application.action === "create" &&
      published.create &&
      isMoneyMoveKind(published.create.kind);
    if (!pairCreate) {
      await lockFinancialEvidenceKeys(
        tx,
        "source",
        stored.refs.map((ref) => ref.slice(0, ref.indexOf(":"))),
      );
      const candidateIds = published.candidates.map(
        (candidate) => candidate.transactionId,
      );
      const candidates = candidateIds.length
        ? await unwrapDb(tx).execute<{ shortcode: string }>(sql`
            SELECT shortcode FROM "FinancialTransaction"
            WHERE id IN (${sql.join(
              candidateIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
          `)
        : { rows: [] };
      await lockFinancialTransactionSources(
        tx,
        candidates.rows.map((candidate) =>
          parseShortcodeFor("financialTransaction", candidate.shortcode),
        ),
        stored.refs.map((ref) => {
          const split = ref.indexOf(":");
          return {
            source: ref.slice(0, split),
            externalId: ref.slice(split + 1),
          };
        }),
      );
    }
    await transitionSuggestionState(tx, state.id, { status: "applied" });
  });

  const charge = { source: subject.source, chargeKey: subject.chargeKey };
  const current = await currentStatementApplication(db, loaded, application);
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
      await import("~/server/domains/transaction-import/repo/transfer-pair-suggestions");
    await applyTransferPair(db, context, {
      key: judgment.transferPair.key,
      expectedFingerprint: judgment.transferPair.fingerprint,
    });
    return;
  }
  const actor = context.actorContext;
  const claimRows = async () => {
    await updateSourceTransactionRecords(
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
      await updateFinancialTransaction.read(
        ["id"],
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
  // This write changes the candidates, claims, holds and copies of pending
  // charges near it on the account; refresh them now rather than leaving them
  // to refuse at apply until a whole-ledger pass.
  const target = judgment.candidates.find(
    (candidate) => candidate.transactionId === targetId,
  );
  const dates = [
    judgment.statementDate,
    ...[target?.transactionDate, target?.postedDate].filter(
      (date): date is string => Boolean(date),
    ),
  ];
  await runAfterCommit(db, async (committed) => {
    try {
      const neighbours = await pendingChargesNear(
        committed,
        judgment.accountId,
        dates,
      );
      await regenerateChargesAfterCommit(
        committed,
        [...neighbours, ...judgment.copies].filter(
          (other) =>
            other.source !== charge.source ||
            other.chargeKey !== charge.chargeKey,
        ),
      );
    } catch (error) {
      // SILENT: advisory refresh only; the apply committed and each
      // neighbour's own accept rechecks evidence, so the next Refresh repairs it.
      log.error("Neighbour suggestion refresh failed", {
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
  const created = await createFinancialTransaction.read(
    ["id"],
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
  return parseShortcodeFor("financialTransaction", created.output.id);
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
    sourceRefs: await financialSourceRefsIncluding(
      db,
      targetId,
      create.sourceRef,
    ),
    ...statementTransactionPatch(judgment, application),
  };
  await effects.claimRows();
  await updateFinancialTransaction.read(
    ["id"],
    db,
    codeOf(targetId),
    data,
    effects.actor,
  );
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
  const pendingRows = await unwrapDb(db).execute<{
    source: string;
    externalId: string;
  }>(
    sql`
    SELECT source, "externalId" FROM ${sourceObservationFrom}
    WHERE id IN (${sql.join(
      supersede.pendingRowIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) AND ${notDeleted("SourceTransactionRecord")}
  `,
    "objects",
  );
  await effects.claimRows();
  for (const source of new Set(pendingRows.map((row) => row.source)))
    await updateSourceTransactionRecords(
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
  await updateFinancialTransaction.read(
    ["id"],
    db,
    codeOf(transactionId),
    {
      sourceRefs: await financialSourceRefsIncluding(
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
