import type { SearchableEntity } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { assessmentState } from "~/server/db/retained-tables";

/**
 * Versioned positional input deliberately avoids free-form JSON key ordering.
 * A schema change bumps the kind/version rather than silently missing a prior
 * dismissal.
 */
export async function assessmentCandidateKey(
  kind: string,
  values: readonly (string | number | boolean | null)[],
): Promise<string> {
  const tuple = [kind, ...values]
    .map((value) => String(value ?? ""))
    .join("\u001f");
  return `v1:${await sha256Hex(tuple)}`;
}

export async function getActiveAssessmentSuppressionKeys(
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
export async function retireAssessmentTargetsTx(
  tx: DrizzleTransaction,
  entityKind: string,
  entityIds: readonly string[],
): Promise<void> {
  if (!entityIds.length) return;
  if (entityKind === "email")
    await tx
      .update(assessmentState)
      .set({
        entity: "orderMailEvent",
        recordId: sql`(${assessmentState.data}->>'eventId')::uuid`,
      })
      .where(
        and(
          eq(assessmentState.family, "email_link"),
          eq(assessmentState.entity, "email"),
          inArray(assessmentState.recordId, [...entityIds]),
        ),
      );
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
