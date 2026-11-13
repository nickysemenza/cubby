import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { fieldAnswer } from "~/server/ai/fields/repo/field-answer";
import { fieldReviewPlan } from "~/server/ai/fields/repo/plan";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { ask, answer, decision } from "~/server/db/kernel-schema";
import { decideConnection } from "~/server/domains/connection/repo/entity-connections";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { authoredFieldWriter } from "~/server/generic/machinery/repo/field-decisions";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import type { Review } from "./review";

/** Gap reviews append intent. The reconciler and ordinary field writer apply it. */
export async function reviewGap(
  db: Database,
  context: EntityKernelContext,
  input: Review,
) {
  if (!input.suggestionId) return null;
  const { hashCanonical } = await import("~/server/kernel/keys");
  const operationKey = await hashCanonical({
    actor: context.actorContext.userId,
    operationId: input.operationId,
  });
  const commandHash = await hashCanonical(input);
  const proposalHash = `${operationKey}:${commandHash}`;
  const [replayed] = await getDb(db)
    .select({
      id: decision.id,
      proposalHash: decision.proposalHash,
      subject: decision.subject,
    })
    .from(decision)
    .where(
      sql`left(${decision.proposalHash}, 64)=${operationKey} AND ${decision.actorId}=${context.actorContext.userId}`,
    )
    .limit(1);
  if (replayed && replayed.proposalHash !== proposalHash)
    throw new Error("Operation already used for a different review");
  if (replayed)
    return {
      suggestionId: input.suggestionId,
      feedbackId: replayed.id,
      status: replayed.subject.startsWith("connection/")
        ? "decided"
        : "waiting",
      applied: true,
    };
  const [stored] = await getDb(db)
    .select({
      id: ask.id,
      inputHash: ask.inputHash,
      input: ask.input,
      output: answer.output,
    })
    .from(ask)
    .innerJoin(answer, eq(answer.askId, ask.id))
    .where(
      sql`${ask.id}=${input.suggestionId}::uuid AND ${ask.feature}=${"field-suggestion"}`,
    )
    .limit(1);
  if (stored) {
    const captured = z
      .object({
        input: z.object({
          entity: z.string(),
          recordId: z.uuid(),
          field: z.string(),
        }),
      })
      .parse(stored.input).input;
    const plan = fieldReviewPlan(captured.entity, captured.field);
    if (!plan) throw new Error("The field is not declared");
    if (
      input.expectedFingerprint &&
      ![stored.id, stored.inputHash].includes(input.expectedFingerprint)
    )
      throw new Error("Field Answer changed since review");
    const scope = {
      kind: "fields",
      key: `${captured.entity}:${captured.recordId}`,
    };
    const current = await getDb(db).execute<{
      current: boolean;
    }>(sql`SELECT EXISTS (
      SELECT 1 FROM "ScopeState" s, jsonb_array_elements(s.inputs) used
      WHERE s."scopeKind"=${scope.kind} AND s."scopeKey"=${scope.key} AND used->>${"inputHash"}=${stored.inputHash}
      AND NOT EXISTS (SELECT 1 FROM "ScopeDirty" changed WHERE changed."scopeKind"=s."scopeKind" AND changed."scopeKey"=s."scopeKey")) AS current`);
    if (!current.rows[0]?.current)
      throw new Error("Field inputs changed since review");
    const proposal = fieldAnswer.parse(stored.output).proposal;
    if (!proposal) throw new Error("This Answer proposes no value");
    if (input.verdict === "correct" && input.intent !== "apply")
      throw new Error("Accept a field through its form or its apply action");
    if (
      input.verdict !== "correct" &&
      input.verdict !== "wrong" &&
      input.verdict !== "dismissed"
    )
      throw new Error("A field gap accepts a value, a correction or a veto");
    const value = input.correction.present
      ? input.correction.value
      : proposal.value;
    const resolved =
      plan.field.reference &&
      typeof value === "string" &&
      !z.uuid().safeParse(value).success
        ? await resolveOrThrow(db, plan.field.reference, value)
        : value;
    return withTransactionDatabase(db, async (tx) => {
      const { decide } = await import("~/server/kernel/api");
      const subject = `${captured.entity}:${captured.recordId}`;
      const decisions = [];
      if (input.verdict === "wrong" || input.verdict === "dismissed")
        decisions.push({
          channel: "veto" as const,
          kind: "veto" as const,
          subject,
          field: captured.field,
          value: proposal.value,
          proposalHash,
        });
      if (input.verdict === "correct" || input.correction.present)
        decisions.push({
          channel: "assignment" as const,
          kind: resolved == null ? ("none" as const) : ("set" as const),
          subject,
          field: captured.field,
          value: resolved,
          proposalHash,
        });
      const written = await decide(tx, context.actorContext, decisions, {
        field: authoredFieldWriter(context),
      });
      // decide dirties this scope and wakes it after commit. Do not load or
      // prepare its model questions while the member's review holds the transaction.
      return {
        suggestionId: stored.id,
        feedbackId: written[0]!.id,
        status: "waiting",
        applied: true,
      };
    });
  }
  if (input.correction.present) return null;
  if (!["correct", "wrong", "dismissed"].includes(input.verdict))
    throw new Error("Choose a connection action");
  if (input.verdict === "correct" && input.intent !== "apply")
    throw new Error("Link through its apply action");
  const connection = await decideConnection(db, context.actorContext, {
    id: input.suggestionId,
    fingerprint: input.expectedFingerprint ?? "",
    accept: input.verdict === "correct",
    operationId: proposalHash,
  });
  return connection
    ? {
        suggestionId: input.suggestionId,
        feedbackId: connection.id,
        status: "decided",
        applied: true,
      }
    : null;
}
