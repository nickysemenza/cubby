import { DERIVED_REFRESH_MAX_FAILURES } from "@cubby/schemas/derived-refresh";
import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  entityEmbedding,
  entityIdentity,
  searchDocument,
} from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { assertInputRevision } from "~/server/generic/derived-refresh/repo/freshness";
import {
  readPhaseFailure,
  recordPhaseFailure,
} from "~/server/generic/derived-refresh/repo/phase-failure";
import { advanceInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";

import type { EntityEmbeddingUpsert } from "./entity-embedding-refresh";

export type EmbeddingArtifact = typeof entityEmbedding.$inferSelect;
export const vectorPayloadHash = (values: readonly number[]) =>
  sha256Hex(JSON.stringify(values.map(Math.fround)));
const failureInput = (input: EntityEmbeddingUpsert) => ({
  entityKind: input.entityKind,
  entityId: input.entityId,
  phase: "embedding",
  fingerprint: input.embeddingHash,
});
const sameConfiguration = (input: EntityEmbeddingUpsert) =>
  and(
    eq(entityEmbedding.entityKind, input.entityKind),
    eq(entityEmbedding.entityId, input.entityId),
    eq(entityEmbedding.provider, input.config.provider),
    eq(entityEmbedding.model, input.config.model),
    eq(entityEmbedding.dimensions, input.config.dimensions),
  );

export type EmbeddingClaim =
  | { kind: "selected" | "pending" | "claimed"; artifact: EmbeddingArtifact }
  | { kind: "busy" }
  | { kind: "blocked"; error: string };

/** Commit an intent before any provider/Vectorize call. A retired ID is never reused. */
export async function claimEmbeddingArtifact(
  db: Database,
  input: EntityEmbeddingUpsert,
): Promise<EmbeddingClaim> {
  try {
    return await withTransactionDatabase(db, async (tx) => {
      // includes-deleted: pending physical artifacts stay hidden until selection.
      const [pending] = await getDb(tx)
        .select()
        .from(entityEmbedding)
        .where(
          and(
            sameConfiguration(input),
            inArray(entityEmbedding.artifactState, [
              "prepared",
              "submitting",
              "submitted",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      if (pending) {
        if (pending.artifactHash === input.embeddingHash) {
          if (pending.artifactState === "submitted")
            return { kind: "pending", artifact: pending };
          if (pending.leaseExpiresAt && pending.leaseExpiresAt > new Date())
            return { kind: "busy" };
          await recordPhaseFailure(
            tx,
            failureInput(input),
            "Embedding submission owner expired before completing its durable handoff",
          );
        }
        await getDb(tx)
          .update(entityEmbedding)
          .set({
            artifactState: "retired",
            deletedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            availableAt: sql`now()`,
          })
          .where(eq(entityEmbedding.id, pending.id));
      }
      const [selected] = await getDb(tx)
        .select()
        .from(entityEmbedding)
        .where(
          and(
            sameConfiguration(input),
            eq(entityEmbedding.artifactState, "selected"),
            isNull(entityEmbedding.deletedAt),
          ),
        )
        .limit(1);
      if (selected?.artifactHash === input.embeddingHash)
        return { kind: "selected", artifact: selected };
      const failure = await readPhaseFailure(tx, failureInput(input));
      if (failure && failure.attempts >= DERIVED_REFRESH_MAX_FAILURES)
        return { kind: "blocked", error: failure.lastError };
      const [artifact] = await getDb(tx)
        .insert(entityEmbedding)
        .values({
          entityKind: input.entityKind,
          entityId: input.entityId,
          embeddingText: input.embeddingText,
          embeddingHash: input.embeddingHash,
          artifactHash: input.embeddingHash,
          provider: input.config.provider,
          model: input.config.model,
          dimensions: input.config.dimensions,
          artifactState: "prepared",
          deletedAt: new Date(),
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: sql`now() + interval '1 minute'`,
        })
        .returning();
      if (!artifact) throw new Error("Embedding intent was not stored");
      return { kind: "claimed", artifact };
    });
  } catch (error) {
    if (isUniqueViolation(error, "EntityEmbedding_one_submission_key"))
      return { kind: "busy" };
    throw error;
  }
}

export async function markEmbeddingSubmitting(
  db: Database,
  artifact: EmbeddingArtifact,
  vectorHash: string,
) {
  if (!artifact.leaseToken)
    throw new Error("Embedding intent has no submission owner");
  // includes-deleted: this physical intent is not a selected projection yet.
  const rows = await getDb(db)
    .update(entityEmbedding)
    .set({ artifactState: "submitting", vectorHash })
    .where(
      and(
        eq(entityEmbedding.id, artifact.id),
        eq(entityEmbedding.artifactState, "prepared"),
        eq(entityEmbedding.leaseToken, artifact.leaseToken),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function recordEmbeddingSubmission(
  db: Database,
  artifact: EmbeddingArtifact,
  submissionId: string,
) {
  if (!artifact.leaseToken)
    throw new Error("Embedding intent has no submission owner");
  // includes-deleted: acceptance does not make an artifact selected or observed.
  const rows = await getDb(db)
    .update(entityEmbedding)
    .set({
      artifactState: "submitted",
      submissionId,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: sql`now()`,
      visibilityAttempts: 0,
    })
    .where(
      and(
        eq(entityEmbedding.id, artifact.id),
        eq(entityEmbedding.artifactState, "submitting"),
        eq(entityEmbedding.leaseToken, artifact.leaseToken),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function failEmbeddingSubmission(
  db: Database,
  artifact: EmbeddingArtifact,
  input: EntityEmbeddingUpsert,
  error: UnparsedError,
) {
  const message = JSON.stringify(
    describeErrorCauses(error, { includeStacks: true }),
  );
  return withTransactionDatabase(db, async (tx) => {
    // includes-deleted: retain ambiguous submissions so delayed uploads stay rejected.
    const changed = await getDb(tx)
      .update(entityEmbedding)
      .set({
        artifactState: "retired",
        deletedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: message,
        availableAt: sql`now()`,
      })
      .where(
        and(
          eq(entityEmbedding.id, artifact.id),
          inArray(entityEmbedding.artifactState, [
            "prepared",
            "submitting",
            "selected",
          ]),
        ),
      )
      .returning({ id: entityEmbedding.id });
    if (changed.length)
      return (await recordPhaseFailure(tx, failureInput(input), message))
        .attempts;
    return (await readPhaseFailure(tx, failureInput(input)))?.attempts ?? 0;
  });
}

export async function deferEmbeddingVisibility(
  db: Database,
  artifact: EmbeddingArtifact,
  input: EntityEmbeddingUpsert,
  diagnostic?: string,
) {
  return withTransactionDatabase(db, async (tx) => {
    // includes-deleted: observe submitted physical work before exposing its row.
    const [current] = await getDb(tx)
      .select()
      .from(entityEmbedding)
      .where(
        and(
          eq(entityEmbedding.id, artifact.id),
          eq(entityEmbedding.artifactState, "submitted"),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) return;
    const attempts = current.visibilityAttempts + 1;
    if (attempts < 6) {
      await getDb(tx)
        .update(entityEmbedding)
        .set({
          visibilityAttempts: attempts,
          lastError: diagnostic ?? current.lastError,
          availableAt: sql`now() + interval '10 seconds'`,
        })
        .where(eq(entityEmbedding.id, current.id));
      return;
    }
    const message =
      diagnostic ??
      current.lastError ??
      `Vectorize submission ${current.submissionId} has unconfirmed storage/ANN visibility for artifact ${current.id}`;
    const failure = await recordPhaseFailure(tx, failureInput(input), message);
    await getDb(tx)
      .update(entityEmbedding)
      .set({
        artifactState:
          failure.attempts >= DERIVED_REFRESH_MAX_FAILURES
            ? "failed"
            : "submitted",
        visibilityAttempts: 0,
        lastError: message,
        availableAt: sql`now() + interval '1 minute'`,
      })
      .where(eq(entityEmbedding.id, current.id));
  });
}

/** Selection is a current-input publication; remote acceptance alone is insufficient. */
export async function selectEmbeddingArtifact(
  db: Database,
  artifact: EmbeddingArtifact,
  input: EntityEmbeddingUpsert,
) {
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx).execute(sql`SET LOCAL lock_timeout='100ms'`);
    // includes-deleted: lock the hidden intent before atomically selecting it.
    const [current] = await getDb(tx)
      .select()
      .from(entityEmbedding)
      .where(eq(entityEmbedding.id, artifact.id))
      .limit(1)
      .for("update");
    if (
      !current ||
      current.artifactState !== "submitted" ||
      current.artifactHash !== input.embeddingHash
    )
      return false;
    const [live] = await getDb(tx)
      .select({ id: searchDocument.id })
      .from(searchDocument)
      .innerJoin(
        entityIdentity,
        and(
          eq(entityIdentity.id, searchDocument.entityId),
          eq(entityIdentity.kind, searchDocument.entityKind),
        ),
      )
      .where(
        and(
          eq(searchDocument.entityKind, input.entityKind),
          eq(searchDocument.entityId, input.entityId),
          eq(searchDocument.semanticText, input.embeddingText),
          isNull(searchDocument.deletedAt),
          isNull(entityIdentity.deletedAt),
        ),
      )
      .limit(1);
    if (!live) return false;
    await getDb(tx)
      .update(entityEmbedding)
      .set({
        artifactState: "retired",
        deletedAt: new Date(),
        availableAt: sql`now()`,
      })
      .where(and(sameConfiguration(input), isNull(entityEmbedding.deletedAt)));
    await getDb(tx)
      .update(entityEmbedding)
      .set({
        artifactState: "selected",
        deletedAt: null,
        observedAt: sql`now()`,
        indexedAt: sql`now()`,
        availableAt: sql`now() + interval '1 day'`,
        lastError: null,
      })
      .where(eq(entityEmbedding.id, current.id));
    await advanceInputRevisions(tx, [`embedding:${input.entityKind}`]);
    await assertInputRevision(tx, input.inputRevision);
    return true;
  });
}

/** Retain the tombstone even after a delete submission; old uploads can still arrive. */
export async function retireEmbeddingArtifact(
  db: Database,
  artifact: EmbeddingArtifact,
) {
  await getDb(db)
    .update(entityEmbedding)
    .set({
      artifactState: "retired",
      deletedAt: new Date(),
      availableAt: sql`now()`,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(eq(entityEmbedding.id, artifact.id));
}

export async function retireMissingEmbeddingSelections(
  db: Database,
  refs: readonly SearchableEntityRef[],
) {
  if (!refs.length) return;
  await getDb(db)
    .update(entityEmbedding)
    .set({
      artifactState: "retired",
      deletedAt: new Date(),
      availableAt: sql`now()`,
    })
    .where(
      and(
        or(
          isNull(entityEmbedding.deletedAt),
          inArray(entityEmbedding.artifactState, [
            "prepared",
            "submitting",
            "submitted",
          ]),
        ),
        or(
          ...refs.map((ref) =>
            and(
              eq(entityEmbedding.entityKind, ref.entityKind),
              eq(entityEmbedding.entityId, ref.entityId),
            ),
          ),
        ),
      ),
    );
}

/** Physical maintenance is paged independently of authoritative-input snapshots. */
export async function embeddingArtifactRecoveryPage(db: Database) {
  // includes-deleted: hidden intents and permanent remote tombstones need recovery.
  return getDb(db)
    .select()
    .from(entityEmbedding)
    .where(
      and(
        sql`${entityEmbedding.availableAt} <= now()`,
        or(
          inArray(entityEmbedding.artifactState, [
            "submitted",
            "retired",
            "legacy",
            "selected",
            "failed",
          ]),
          and(
            inArray(entityEmbedding.artifactState, ["prepared", "submitting"]),
            sql`${entityEmbedding.leaseExpiresAt} <= now()`,
          ),
        ),
      ),
    )
    .orderBy(asc(entityEmbedding.availableAt), asc(entityEmbedding.id))
    .limit(100);
}

export async function nextPendingEmbeddingWake(db: Database) {
  // includes-deleted: unfinished physical intents have not been selected yet.
  const [row] = await getDb(db)
    .select({
      availableAt: entityEmbedding.availableAt,
      leaseExpiresAt: entityEmbedding.leaseExpiresAt,
    })
    .from(entityEmbedding)
    .where(
      inArray(entityEmbedding.artifactState, [
        "prepared",
        "submitting",
        "submitted",
      ]),
    )
    .orderBy(
      sql`greatest(${entityEmbedding.availableAt}, coalesce(${entityEmbedding.leaseExpiresAt}, ${entityEmbedding.availableAt}))`,
      asc(entityEmbedding.id),
    )
    .limit(1);
  return row
    ? new Date(
        Math.max(row.availableAt.getTime(), row.leaseExpiresAt?.getTime() ?? 0),
      )
    : null;
}

export async function recordArtifactCleanup(
  db: Database,
  artifact: EmbeddingArtifact,
  outcome: { mutationId: string } | { error: unknown },
) {
  await withTransactionDatabase(db, async (tx) => {
    if ("error" in outcome) {
      const message = JSON.stringify(
        describeErrorCauses(outcome.error, { includeStacks: true }),
      );
      const failure = await recordPhaseFailure(
        tx,
        {
          entityKind: artifact.entityKind,
          entityId: artifact.entityId,
          phase: "embedding_cleanup",
          fingerprint: artifact.id,
        },
        message,
      );
      // includes-deleted: cleanup exhaustion preserves the permanent tombstone.
      await getDb(tx)
        .update(entityEmbedding)
        .set({
          lastError: message,
          availableAt:
            failure.attempts >= DERIVED_REFRESH_MAX_FAILURES
              ? new Date("9999-12-31T00:00:00.000Z")
              : sql`now() + interval '1 minute' * ${failure.attempts}`,
        })
        .where(eq(entityEmbedding.id, artifact.id));
    } else {
      // includes-deleted: recheck retired IDs later because an old sender can outlive a delete.
      await getDb(tx)
        .update(entityEmbedding)
        .set({
          deletionId: outcome.mutationId,
          lastError: null,
          availableAt: sql`now() + interval '7 days'`,
        })
        .where(eq(entityEmbedding.id, artifact.id));
    }
  });
}

export async function retryEmbeddingArtifactFailures(db: Database) {
  // includes-deleted: manual retry gives failed submissions a fresh physical incarnation.
  await getDb(db)
    .update(entityEmbedding)
    .set({
      artifactState: sql`CASE WHEN ${entityEmbedding.artifactState}=${embeddingArtifactState.enum.failed} THEN ${embeddingArtifactState.enum.retired} ELSE ${entityEmbedding.artifactState} END`,
      visibilityAttempts: 0,
      availableAt: sql`now()`,
      lastError: null,
    })
    .where(inArray(entityEmbedding.artifactState, ["failed", "retired"]));
}

export async function deferArtifactRecovery(
  db: Database,
  ids: readonly string[],
  error: string | null = null,
) {
  if (!ids.length) return;
  // includes-deleted: maintenance scheduling also belongs to retained tombstones.
  await getDb(db)
    .update(entityEmbedding)
    .set({ availableAt: sql`now() + interval '1 day'`, lastError: error })
    .where(inArray(entityEmbedding.id, [...ids]));
}
