/**
 * Decisions (ADR 0029 section 1): four independent channels, each resolved
 * by its newest row. A later assignment never removes a veto, and one
 * identity decision never removes another pair's. The insert takes the
 * gate first; the scopes that read the subject are dirtied in the same
 * transaction. A
 * decision on an authored entity's field is applied by that entity's own
 * writer in the same transaction, and a `reject` runs the record's delete
 * policy and marks its `RecordKey` so its evidence does not recreate it.
 */
import type { ActorContext } from "@cubby/schemas/context";
import {
  FIELDS_SCOPE,
  QUALITY_SCOPE,
  recordScopeKey,
} from "@cubby/schemas/kernel/capability";
import { DECISION_KINDS } from "@cubby/schemas/kernel/stage";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { isShortcodeEntity } from "~/server/entity-kernel/repo/entity-identity";

import { settleAskOutcome } from "./ask";
import { askOfSubject, askOutcomes, ASK_OUTCOME_FIELD } from "./ask-gap";
import type { DecisionInput, DecisionRef, ScopeRef } from "./define";
import { markDirty } from "./dirty";
import { takeHouseholdGate } from "./gate";
import { clearRejected, markRejected, removeRecords } from "./identity";
import { decisionKey, hashCanonical, VETO_SEPARATOR } from "./keys";
import { KernelContractError } from "./reads";
import type { KernelRegistry } from "./registry";

export type StoredDecision = DecisionInput & {
  id: string;
  slot: string;
  other: string | null;
};

/**
 * The entity writers a caller supplies: the authored entity's ordinary writer
 * for a field decision, or its delete policy for a rejection of a record no
 * reconciler owns.
 */
export type DecisionWriters = {
  field?(tx: Database, decision: StoredDecision): Promise<void>;
  reject?(tx: Database, decision: StoredDecision): Promise<void>;
};

const actorKind = (actor: ActorContext) =>
  actor.channel === "system"
    ? "system"
    : actor.oauthClientId
      ? "agent"
      : "member";

/** `entity:id` → its parts; subjects that are not records return null. */
const recordOf = (subject: string, registry: KernelRegistry) => {
  const match = /^([A-Za-z][\w-]*):([0-9a-f-]{36})$/u.exec(subject);
  if (!match) return null;
  const entity = match[1]!;
  return isShortcodeEntity(entity) ||
    [...registry.reconcilers.values()].some((reconciler) =>
      reconciler.writes.some(
        (target) => (target.entity ?? target.name) === entity,
      ),
    )
    ? { entity, id: match[2]! }
    : null;
};

/** Whether a registered reconciler owns `entity.field` (a `fields` scope's column, say). */
const ownsField = (registry: KernelRegistry, entity: string, field: string) =>
  [...registry.reconcilers.values()].some((reconciler) =>
    reconciler.writes.some(
      (ref) =>
        (ref.entity ?? ref.name) === entity && ref.columns.includes(field),
    ),
  );

async function normalize(decision: DecisionInput) {
  const allowed: readonly string[] = DECISION_KINDS[decision.channel];
  if (!allowed.includes(decision.kind))
    throw new KernelContractError(
      `${decision.kind} is not a ${decision.channel} decision`,
    );
  switch (decision.channel) {
    case "assignment":
      if (!decision.field)
        throw new KernelContractError("An assignment names its field");
      return { subject: decision.subject, slot: decision.field, other: null };
    case "veto":
      if (!decision.field)
        throw new KernelContractError("A veto names its field");
      return {
        subject: decision.subject,
        slot: `${decision.field}${VETO_SEPARATOR}${await hashCanonical(decision.value ?? null)}`,
        other: null,
      };
    case "identity": {
      if (!decision.field || decision.field === decision.subject)
        throw new KernelContractError(
          "An identity decision names two subjects",
        );
      const [subject, other] = [decision.subject, decision.field].sort();
      return { subject: subject!, slot: other!, other: other! };
    }
    case "rejection":
      return { subject: decision.subject, slot: "", other: null };
  }
}

export async function decide(
  db: Database,
  registry: KernelRegistry,
  actor: ActorContext,
  decisions: readonly DecisionInput[],
  writers: DecisionWriters = {},
): Promise<DecisionRef[]> {
  if (!decisions.length) return [];
  const normalized = await Promise.all(decisions.map(normalize));
  return repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const rows = decisions.map((decision, index) => ({
      id: crypto.randomUUID(),
      channel: decision.channel,
      subject: normalized[index]!.subject,
      slot: normalized[index]!.slot,
      field: decision.channel === "identity" ? null : (decision.field ?? null),
      kind: decision.kind,
      value: decision.value ?? null,
      other: normalized[index]!.other,
      actorKind: actorKind(actor),
      actorId: actor.userId,
      proposalHash: decision.proposalHash ?? null,
    }));
    // The newest decision in a slot wins. One clock reading per statement
    // orders separate calls; each row's ordinal orders one call's rows.
    await q.execute(sql`
      WITH gate AS MATERIALIZED (SELECT ${takeHouseholdGate}),
        base AS MATERIALIZED (SELECT clock_timestamp() AS at FROM gate)
      INSERT INTO "Decision" (id, channel, subject, slot, field, kind, value, other, "actorKind", "actorId", "proposalHash", at)
      SELECT d.id, d.channel, d.subject, d.slot, d.field, d.kind, d.value, d.other, d."actorKind", d."actorId", d."proposalHash",
        base.at + d.ord * interval '1 microsecond'
      FROM base, ROWS FROM (jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS (
        id uuid, channel text, subject text, slot text, field text, kind text, value jsonb,
        other text, "actorKind" text, "actorId" text, "proposalHash" text))
        WITH ORDINALITY AS d(id, channel, subject, slot, field, kind, value, other,
          "actorKind", "actorId", "proposalHash", ord)`);
    const stored: StoredDecision[] = decisions.map((decision, index) => ({
      ...decision,
      ...normalized[index]!,
      id: rows[index]!.id,
    }));
    const discovered: ScopeRef[] = [];
    // A record's own scopes rerun on any decision about it, including one
    // they never read before (its first decision).
    const records = stored.flatMap((decision) =>
      [decision.subject, decision.other].flatMap((subject) => {
        const record = subject ? recordOf(subject, registry) : null;
        return record ? [record] : [];
      }),
    );
    if (records.length) {
      const owners = await q.execute<{ kind: string; key: string }>(sql`
        SELECT DISTINCT rk."scopeKind" AS kind, rk."scopeKey" AS key FROM "RecordKey" rk
        JOIN jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS r(entity text, id uuid)
          ON rk.entity = r.entity AND rk."entityId" = r.id`);
      discovered.push(...owners.rows);
      for (const record of records) {
        const capability = registry.machinery.get(record.entity);
        if (capability?.fields)
          discovered.push({
            kind: FIELDS_SCOPE,
            key: recordScopeKey(record.entity, record.id),
          });
        if (capability?.quality)
          discovered.push({
            kind: QUALITY_SCOPE,
            key: recordScopeKey(record.entity, record.id),
          });
      }
    }
    for (const decision of stored) {
      discovered.push(...(decision.scopes ?? []));
      const record = recordOf(decision.subject, registry);
      if (decision.channel === "rejection" && record) {
        if (decision.kind === "reject") {
          const owners = await markRejected(q, record.entity, record.id);
          discovered.push(...owners);
          const target = [...registry.reconcilers.values()]
            .flatMap((reconciler) => reconciler.writes)
            .find((ref) => (ref.entity ?? ref.name) === record.entity);
          if (target && owners.length) {
            const owner = owners[0]!;
            // The kernel removes its own record; the delete rows carry the decision.
            await withKernelApply(
              {
                scope: owner,
                version: registry.reconcilers.get(owner.kind)?.version ?? 0,
                inputs: [
                  {
                    kind: "decision",
                    id: decision.id,
                    subject: decision.subject,
                  },
                ],
              },
              () => removeRecords(tx, target, [record.id]),
            );
          } else if (writers.reject) await writers.reject(tx, decision);
          else
            throw new KernelContractError(
              `No reconciler owns ${decision.subject} and no delete policy was supplied`,
            );
        } else
          discovered.push(
            ...(await clearRejected(q, record.entity, record.id)),
          );
      }
      const askHash = askOfSubject(decision.subject);
      if (askHash && decision.channel === "assignment") {
        const outcome = askOutcomes.find((value) => value === decision.value);
        if (decision.field !== ASK_OUTCOME_FIELD || !outcome)
          throw new KernelContractError(
            `An ask decision sets ${ASK_OUTCOME_FIELD} to one of ${askOutcomes.join(", ")}`,
          );
        await settleAskOutcome(tx, registry, askHash, outcome);
        continue;
      }
      // A column a reconciler owns takes its decision through that
      // reconciler; the entity's writer applies only authored columns.
      if (
        decision.channel === "assignment" &&
        writers.field &&
        !(
          record &&
          decision.field &&
          ownsField(registry, record.entity, decision.field)
        )
      )
        await writers.field(tx, decision);
    }
    await markDirty(q, registry, {
      keys: [
        ...new Set(
          stored.flatMap((decision) => [
            decisionKey(decision.subject),
            ...(decision.other ? [decisionKey(decision.other)] : []),
          ]),
        ),
      ],
      discovers: discovered,
      reason: "decision",
    });
    return stored.map((decision) => ({
      id: decision.id,
      subject: decision.subject,
    }));
  });
}
