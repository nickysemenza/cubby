import type { SearchableEntity } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { assessmentState } from "~/server/db/schema";
import { publishAssessment, recordFeedback } from "~/server/repo/assessment";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Versioned positional input deliberately avoids free-form JSON key ordering.
 * A schema change bumps the kind/version rather than silently missing a prior
 * dismissal.
 */
export async function suggestionCandidateKey(
  kind: string,
  values: readonly (string | number | boolean | null)[],
): Promise<string> {
  const tuple = [kind, ...values]
    .map((value) => String(value ?? ""))
    .join("\u001f");
  return `v1:${await sha256Hex(tuple)}`;
}

export async function dismissSuggestion(
  db: Database,
  input: {
    entityKind: SearchableEntity;
    entityId: string;
    suggestionKind: string;
    candidateKey: string;
  },
): Promise<void> {
  const prediction = await publishAssessment(db, {
    publicationKey: `recommendation:${input.entityKind}:${input.entityId}:${input.suggestionKind}:${input.candidateKey}`,
    family: "recommendation",
    subject: {
      kind: "recommendation",
      entity: input.entityKind,
      recordId: input.entityId,
      scope: input.suggestionKind,
      candidateKey: input.candidateKey,
    },
    judgment: { candidateKey: input.candidateKey },
    producer: null,
    fingerprint: null,
    evidence: null,
  });
  const suppression = {
    scope: input.suggestionKind,
    candidateKey: input.candidateKey,
    fingerprint: null,
  };
  await recordFeedback(db, {
    assessmentId: prediction.id,
    operationId: `dismiss:${crypto.randomUUID()}`,
    verdict: "dismissed",
    authority: "member",
    actorUserId: null,
    suppression,
  });
  await getDb(db)
    .update(assessmentState)
    .set({ suppression, status: "resolved" })
    .where(eq(assessmentState.id, prediction.id));
}

export async function getActiveSuggestionDismissalKeys(
  db: Database,
  input: {
    entityKind: SearchableEntity;
    entityId: string;
    suggestionKind: string;
  },
): Promise<Set<string>> {
  const rows = await getDb(db)
    .select({ suppression: assessmentState.suppression })
    .from(assessmentState)
    .where(
      and(
        eq(assessmentState.entity, input.entityKind),
        eq(assessmentState.recordId, input.entityId),
        eq(assessmentState.active, true),
        eq(assessmentState.family, "recommendation"),
      ),
    );
  return new Set(
    rows.flatMap(({ suppression }) =>
      suppression?.scope === input.suggestionKind
        ? [suppression.candidateKey]
        : [],
    ),
  );
}

/** Retire current targets across families; immutable subjects and Feedback remain original. */
export async function softDeleteSuggestionDismissalsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  entityIds: readonly string[],
): Promise<void> {
  if (!entityIds.length) return;
  await tx
    .update(assessmentState)
    .set({
      active: false,
      status: "superseded",
      confirmedValue: null,
      suppression: null,
    })
    .where(
      and(
        or(
          and(
            eq(assessmentState.entity, entityKind),
            or(
              inArray(assessmentState.recordId, [...entityIds]),
              inArray(sql`${assessmentState.data}->>'otherId'`, [...entityIds]),
            ),
          ),
          entityKind === "purchase"
            ? and(
                eq(assessmentState.family, "email_link"),
                inArray(sql`${assessmentState.data}->>'purchaseId'`, [
                  ...entityIds,
                ]),
              )
            : undefined,
        ),
      ),
    );
}

export async function repointAssessmentTargetsTx(
  tx: DrizzleTransaction,
  entity: string,
  keepId: string,
  loserIds: readonly string[],
) {
  if (!loserIds.length) return;
  await tx
    .update(assessmentState)
    .set({ recordId: keepId, status: "superseded", confirmedValue: null })
    .where(
      and(
        eq(assessmentState.entity, entity),
        inArray(assessmentState.recordId, [...loserIds]),
        eq(assessmentState.family, "field"),
      ),
    );
  if (entity === "purchase") {
    const rows = await tx
      .select()
      .from(assessmentState)
      .where(
        and(
          eq(assessmentState.family, "email_link"),
          eq(assessmentState.active, true),
          inArray(sql`${assessmentState.data}->>'purchaseId'`, [
            keepId,
            ...loserIds,
          ]),
        ),
      )
      .orderBy(assessmentState.id)
      .for("update");
    const events = new Map<string, typeof rows>();
    const linkTarget = z
      .object({
        eventId: z.uuid(),
        purchaseId: z.uuid(),
        decision: z.enum(["linked", "dismissed"]),
      })
      .passthrough();
    for (const row of rows) {
      const data = linkTarget.parse(row.data);
      const values = events.get(data.eventId) ?? [];
      values.push(row);
      events.set(data.eventId, values);
    }
    for (const values of events.values()) {
      const winner =
        values.find(
          (row) => linkTarget.parse(row.data).decision === "linked",
        ) ??
        values.find(
          (row) => linkTarget.parse(row.data).purchaseId === keepId,
        ) ??
        values[0]!;
      for (const row of values)
        if (row.id !== winner.id)
          await tx
            .update(assessmentState)
            .set({ active: false, status: "superseded" })
            .where(eq(assessmentState.id, row.id));
      await tx
        .update(assessmentState)
        .set({
          data: sql`jsonb_set(${assessmentState.data},'{purchaseId}',to_jsonb(${keepId}::text))`,
        })
        .where(eq(assessmentState.id, winner.id));
    }
  }
}
