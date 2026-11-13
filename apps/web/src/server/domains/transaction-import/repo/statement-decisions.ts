import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, parseEntityId } from "@cubby/schemas/identifiers";
import {
  statementDecisionInput,
  type StatementDecisionInput,
  type StatementDecisionOut,
} from "@cubby/schemas/statement-decision";
import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers/core";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  financialTransaction,
  financialTransactionAllocation,
  sourceOccurrence,
  sourceTransactionRecord,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import type { DecisionInput, Outcome } from "~/server/kernel/api";
import { jsonSnapshot } from "~/server/lib/canonical-json";

const gapsOf = (outcomes: readonly Outcome[]) =>
  outcomes.flatMap((outcome) =>
    outcome.error ? [outcome.error] : outcome.gaps.map((gap) => gap.input),
  );

/** A member's apply, attach or book is a set of durable decisions about current evidence. */
export async function decideStatement(
  db: Database,
  actor: ActorContext,
  raw: StatementDecisionInput,
): Promise<StatementDecisionOut> {
  const input = statementDecisionInput.parse(raw);
  const {
    decide,
    emitWrites,
    merge,
    reconcileNow,
    recordSubject,
    resolveForRead,
  } = await import("~/server/kernel/api");
  const { updateBankTransactions } =
    await import("~/server/domains/financial-transaction/repo/bank-mutations");
  return withTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const [observation] = await q
      .select()
      .from(sourceTransactionRecord)
      .where(eq(sourceTransactionRecord.shortcode, input.observationId));
    const [occurrence] = observation
      ? await q
          .select()
          .from(sourceOccurrence)
          .where(eq(sourceOccurrence.id, observation.occurrenceId))
      : [];
    if (
      !observation ||
      !occurrence ||
      occurrence.deletedAt ||
      occurrence.currentObservationId !== observation.id
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Review the source occurrence's current observation before applying it.",
      );
    const scope = { kind: "bankEvent", key: occurrence.id };
    const subject = `bank:${occurrence.id}`;
    if (input.application.action === "reject") {
      const [owner] = await q
        .select()
        .from(recordKey)
        .where(
          and(
            eq(recordKey.scopeKind, scope.kind),
            eq(recordKey.scopeKey, scope.key),
            eq(recordKey.entity, "financialTransaction"),
          ),
        );
      const recorded = owner ? await resolveForRead(tx, owner.entityId) : null;
      const slices = recorded
        ? await q
            .select()
            .from(financialTransactionAllocation)
            .where(
              and(
                eq(
                  financialTransactionAllocation.transactionId,
                  parseEntityId("financialTransaction", recorded.id),
                ),
                isNull(financialTransactionAllocation.deletedAt),
              ),
            )
        : [];
      const decisions: DecisionInput[] = [
        { channel: "rejection", kind: "reject", subject, scopes: [scope] },
      ];
      const [transaction] = recorded
        ? await q
            .select()
            .from(financialTransaction)
            .where(
              eq(
                financialTransaction.id,
                parseEntityId("financialTransaction", recorded.id),
              ),
            )
        : [];
      const removable =
        recorded &&
        owner?.minted &&
        !owner.mergedAt &&
        !slices.length &&
        !transaction?.ledgerTransferId;
      if (removable)
        decisions.push({
          channel: "rejection",
          kind: "reject",
          subject: recordSubject("financialTransaction", recorded.id),
        });
      await decide(tx, actor, decisions);
      await reconcileNow(tx, [scope]);
      return {
        status: "rejected",
        transactionId: recorded
          ? parseShortcodeFor("financialTransaction", recorded.shortcode)
          : null,
        gaps:
          recorded && !removable
            ? [
                "Accepted spending or transfer evidence is retained. Review its records before changing the ledger.",
              ]
            : [],
      };
    }
    const assignments: DecisionInput[] = [];
    if (input.accountId)
      assignments.push({
        channel: "assignment",
        kind: "set",
        subject,
        field: "accountId",
        value: input.accountId,
        scopes: [scope],
      });
    if (input.application.kindOverride)
      assignments.push({
        channel: "assignment",
        kind: "set",
        subject,
        field: "kind",
        value: input.application.kindOverride,
        scopes: [scope],
      });
    await decide(tx, actor, assignments);
    const bank = await reconcileNow(tx, [scope]);
    const [owned] = await q
      .select()
      .from(recordKey)
      .where(
        and(
          eq(recordKey.scopeKind, scope.kind),
          eq(recordKey.scopeKey, scope.key),
          eq(recordKey.entity, "financialTransaction"),
        ),
      );
    let identity = owned ? await resolveForRead(tx, owned.entityId) : null;
    if (!identity)
      return { status: "waiting", transactionId: null, gaps: gapsOf(bank) };
    let id = parseEntityId("financialTransaction", identity.id);
    const action = input.application.action;
    if (action === "attach" || action === "supersede") {
      if (!input.application.transactionId)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Attach needs the reviewed financial transaction.",
        );
      const target = await resolveForRead(tx, input.application.transactionId);
      if (!target || target.entity !== "financialTransaction")
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "The reviewed financial transaction is not live.",
        );
      const [source] = await q
        .select()
        .from(financialTransaction)
        .where(eq(financialTransaction.id, id));
      if (!source)
        throw new Error("The bank event has no financial transaction");
      const targetId = parseEntityId("financialTransaction", target.id);
      const values = Object.fromEntries(
        input.application.fields.map((field) => [field, source[field]]),
      );
      if (input.application.kindOverride)
        Object.assign(values, { kind: input.application.kindOverride });
      if (input.application.fields.includes("amount")) {
        const slices = await q
          .select()
          .from(financialTransactionAllocation)
          .where(
            and(
              eq(financialTransactionAllocation.transactionId, targetId),
              isNull(financialTransactionAllocation.deletedAt),
            ),
          );
        if (
          slices.length &&
          slices.reduce((sum, slice) => sum + slice.amountMinor, 0n) !==
            source.amount
        )
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Reconcile the target's allocation split before changing its movement.",
          );
      }
      await updateBankTransactions(tx, [{ id: targetId, values }], actor);
      if (id !== targetId) {
        await decide(tx, actor, [
          {
            channel: "identity",
            kind: "same",
            subject: recordSubject("financialTransaction", id),
            field: recordSubject("financialTransaction", targetId),
          },
        ]);
        const { bankTransactionWrites } =
          await import("~/server/domains/financial-transaction/repo/bank-event");
        const result = await merge(tx, {
          target: bankTransactionWrites,
          a: id,
          b: targetId,
          basis: "decision",
          actor,
        });
        if (!result.merged)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `The reviewed bank events could not be attached: ${result.reason}`,
          );
        identity = await resolveForRead(tx, id);
        id = parseEntityId("financialTransaction", identity!.id);
      }
    }
    if (action === "void")
      await updateBankTransactions(
        tx,
        [{ id, values: { status: "void" } }],
        actor,
      );
    await q
      .update(sourceOccurrence)
      .set({ acceptedTransactionId: id })
      .where(eq(sourceOccurrence.id, occurrence.id));
    await emitWrites(tx, {
      table: sourceOccurrence,
      ids: [occurrence.id],
      columns: ["acceptedTransactionId"],
    });
    const purchaseScope = { kind: "purchaseEvent", key: id };
    const booking: DecisionInput[] = [];
    for (const [field, value] of Object.entries(
      input.application.booking ?? {},
    )) {
      if (value !== undefined)
        booking.push({
          channel: "assignment",
          kind: value === null ? "none" : "set",
          subject: `purchaseEvent:${id}`,
          field: field === "reviewedVendorName" ? "vendorName" : field,
          value: jsonSnapshot.parse(value),
          scopes: [purchaseScope],
        });
    }
    if (action === "book")
      booking.push({
        channel: "assignment",
        kind: "set",
        subject: `purchaseEvent:${id}`,
        field: "book",
        value: true,
        scopes: [purchaseScope],
      });
    for (const code of input.application.rejectedCandidateIds) {
      const other = await resolveForRead(tx, code);
      if (other?.entity === "financialTransaction" && other.id !== id)
        booking.push({
          channel: "identity",
          kind: "distinct",
          subject: recordSubject("financialTransaction", id),
          field: recordSubject("financialTransaction", other.id),
          scopes: [scope],
        });
    }
    await decide(tx, actor, booking);
    const settled = await reconcileNow(tx, [purchaseScope]);
    return {
      status: settled.some((outcome) => outcome.gaps.length || outcome.error)
        ? "waiting"
        : "applied",
      transactionId: parseShortcodeFor(
        "financialTransaction",
        identity!.shortcode,
      ),
      gaps: gapsOf(settled),
    };
  });
}
