import {
  DERIVED_REFRESH_MAX_FAILURES,
  DERIVED_REFRESH_PAGE,
  derivedRefreshPhase,
} from "@cubby/schemas/derived-refresh";
import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  isEmbeddableEntity,
  searchableEntitySchema,
} from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  derivedRefreshScope,
  derivedRefreshWork,
  derivedRefreshFailure,
} from "~/server/db/schema";
import { markProductConversionCoverageStale } from "~/server/domains/product/repo/conversion-coverage";
import {
  commitRecipeTotals,
  markRecipesStale,
} from "~/server/domains/recipe/repo/totals";
import { findPgError } from "~/server/errors/db-errors";
import { ALL_INPUT_REVISION_KEY } from "~/server/generic/derived-refresh/repo/revisions";
import {
  prepareSearchDocuments,
  publishPreparedSearchDocuments,
} from "~/server/generic/search/repo/search-document";

import type { DerivedRefreshPorts } from "../refresh-ports.boundary";
import {
  prepareAssessmentRetirement,
  publishAssessmentRetirement,
} from "./assessment-retirement";
import {
  readRefreshDependencyPage,
  refreshDependencyRoutes,
} from "./dependencies";
import {
  currentInputRevision,
  assertInputRevision,
  DerivedInputsChanged,
} from "./freshness";
import {
  phaseAfterFailure,
  readPhaseFailure,
  recordPhaseFailure,
  type PhaseFailureInput,
} from "./phase-failure";

/** Work failures survive transport retries and newly created Run attempts. */
export async function retryDerivedRefreshFailures(db: Database) {
  await withTransactionDatabase(db, async (tx) => {
    await getDb(tx).update(derivedRefreshFailure).set({ attempts: 0 });
    await getDb(tx)
      .update(derivedRefreshWork)
      .set({
        state: "pending",
        version: sql`${derivedRefreshWork.version}+1`,
        attempts: 0,
        hasFailures: false,
        publishing: false,
        publishAfter: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null,
        availableAt: sql`now()`,
      })
      .where(eq(derivedRefreshWork.state, "failed"));
  });
}

export async function nextDerivedRefreshWork(
  db: Database,
  options: { frontierOnly?: boolean } = {},
) {
  const [row] = await getDb(db)
    .select()
    .from(derivedRefreshWork)
    .where(
      and(
        eq(derivedRefreshWork.state, "pending"),
        options.frontierOnly
          ? eq(derivedRefreshWork.publishing, false)
          : undefined,
        sql`${derivedRefreshWork.availableAt} <= now()`,
        sql`(${derivedRefreshWork.leaseExpiresAt} IS NULL OR ${derivedRefreshWork.leaseExpiresAt} <= now())`,
      ),
    )
    .orderBy(asc(derivedRefreshWork.availableAt), asc(derivedRefreshWork.id))
    .limit(1);
  return row ?? null;
}

/** A future retry retains its existing Run owner instead of creating new Runs. */
export async function nextDerivedRefreshWake(db: Database) {
  const [row] = await getDb(db)
    .select({ availableAt: derivedRefreshWork.availableAt })
    .from(derivedRefreshWork)
    .where(eq(derivedRefreshWork.state, "pending"))
    .orderBy(asc(derivedRefreshWork.availableAt))
    .limit(1);
  return row?.availableAt ?? null;
}

function projectedEmbeddingRefs(
  scopes: (typeof derivedRefreshScope.$inferSelect)[],
) {
  return scopes.flatMap((scope) => {
    const kind = searchableEntitySchema.safeParse(scope.entityKind);
    return scope.projected && kind.success && isEmbeddableEntity(kind.data)
      ? [{ entityKind: kind.data, entityId: scope.entityId }]
      : [];
  });
}

/** Frontier preparation has no provider ports and does not retain row locks. */
async function prepareFrontierPage(
  db: Database,
  scope: typeof derivedRefreshScope.$inferSelect | undefined,
  version: number,
) {
  const searchable =
    scope && searchableEntitySchema.safeParse(scope.entityKind);
  const prepared =
    scope &&
    (scope.version !== version || scope.phase === "projection") &&
    searchable?.success
      ? await prepareSearchDocuments(db, [
          { entityKind: searchable.data, entityId: scope.entityId },
        ])
      : null;
  const retirement =
    scope?.phase === "assessment" && scope.version === version
      ? await prepareAssessmentRetirement(db, scope)
      : null;
  const route =
    scope?.phase === "dependencies" &&
    scope.version === version &&
    scope.traverse
      ? refreshDependencyRoutes(scope.entityKind)[scope.route]
      : undefined;
  const dependencyRefs =
    route && scope
      ? await readRefreshDependencyPage(db, route, scope.entityId, scope.after)
      : [];
  return { prepared, retirement, route, dependencyRefs };
}

/** One bounded frontier/retirement/publication page, shared by queue and Run. */
export async function processDerivedRefreshPage(
  db: Database,
  ports: DerivedRefreshPorts,
  options: { frontierOnly?: boolean } = {},
): Promise<{ done: boolean; processed: number; errors: string[] }> {
  const candidate = await nextDerivedRefreshWork(db, options);
  if (!candidate) return { done: true, processed: 0, errors: [] };
  const [work] = await getDb(db)
    .update(derivedRefreshWork)
    .set({
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    .where(
      and(
        eq(derivedRefreshWork.id, candidate.id),
        eq(derivedRefreshWork.version, candidate.version),
        eq(derivedRefreshWork.state, "pending"),
        sql`(${derivedRefreshWork.leaseExpiresAt} IS NULL OR ${derivedRefreshWork.leaseExpiresAt} <= now())`,
      ),
    )
    .returning();
  if (!work?.leaseToken) return { done: false, processed: 0, errors: [] };
  const owned = and(
    eq(derivedRefreshWork.id, work.id),
    eq(derivedRefreshWork.version, work.version),
    eq(derivedRefreshWork.leaseToken, work.leaseToken),
    eq(derivedRefreshWork.state, "pending"),
  );
  let scope: typeof derivedRefreshScope.$inferSelect | undefined;
  let publicationScope: typeof derivedRefreshScope.$inferSelect | undefined;
  let failureInput: PhaseFailureInput = {
    entityKind: work.entityKind,
    entityId: work.entityId,
    phase: "publication",
    fingerprint: "unprepared-publication-v1",
  };
  try {
    // Expensive reads never retain a metadata/output lock or a DB connection.
    const inputRevision = await currentInputRevision(db);
    const publicationPage = work.publishing
      ? await getDb(db)
          .select()
          .from(derivedRefreshScope)
          .where(
            and(
              eq(derivedRefreshScope.workId, work.id),
              work.publishAfter
                ? gt(derivedRefreshScope.id, work.publishAfter)
                : undefined,
            ),
          )
          .orderBy(asc(derivedRefreshScope.id))
          .limit(DERIVED_REFRESH_PAGE)
      : [];
    const recipePosition = publicationPage.findIndex(
      (entry) => entry.entityKind === "recipe",
    );
    const publication =
      recipePosition < 0
        ? publicationPage
        : publicationPage.slice(0, recipePosition + 1);
    publicationScope = publication.at(-1);
    const recipe =
      publicationScope?.entityKind === "recipe"
        ? await ports.prepareRecipe(
            db,
            parseEntityId("recipe", publicationScope.entityId),
          )
        : null;
    if (recipe && publicationScope)
      failureInput = {
        entityKind: publicationScope.entityKind,
        entityId: publicationScope.entityId,
        phase: "recipe",
        fingerprint: recipe.fingerprint,
      };
    const recipeFailure = recipe
      ? await readPhaseFailure(db, failureInput)
      : null;
    const recipeBlocked =
      recipeFailure && recipeFailure.attempts >= DERIVED_REFRESH_MAX_FAILURES
        ? recipeFailure
        : null;
    const recipeTotals =
      recipe && !recipeBlocked ? await recipe.compute() : null;
    const embeddingRefs = projectedEmbeddingRefs(publication);
    const embeddings = embeddingRefs.length
      ? await ports.refreshEmbeddings(db, embeddingRefs)
      : new Map();
    const embeddingStates = embeddingRefs.map((ref) => {
      const state = embeddings.get(entityRefKey(ref.entityKind, ref.entityId));
      if (!state)
        throw new Error(
          `Missing embedding refresh result for ${ref.entityKind}:${ref.entityId}`,
        );
      return state;
    });
    const publicationErrors = [
      ...(recipeBlocked ? [recipeBlocked.lastError] : []),
      ...embeddingStates.flatMap((state) =>
        state.state === "failed" ? [state.error] : [],
      ),
    ];
    [scope] = work.publishing
      ? []
      : await getDb(db)
          .select()
          .from(derivedRefreshScope)
          .where(
            and(
              eq(derivedRefreshScope.workId, work.id),
              or(
                eq(derivedRefreshScope.done, false),
                ne(derivedRefreshScope.version, work.version),
              ),
            ),
          )
          .orderBy(asc(derivedRefreshScope.id))
          .limit(1);
    const phase = scope?.version === work.version ? scope.phase : "projection";
    if (scope)
      failureInput = {
        entityKind: scope.entityKind,
        entityId: scope.entityId,
        phase,
        fingerprint: await sha256Hex(
          JSON.stringify([
            "unprepared-phase-v1",
            scope.entityKind,
            scope.entityId,
            phase,
            scope.route,
            scope.after,
          ]),
        ),
      };
    const { prepared, retirement, route, dependencyRefs } =
      await prepareFrontierPage(db, scope, work.version);
    if (!work.publishing)
      failureInput = {
        ...failureInput,
        fingerprint: await sha256Hex(
          JSON.stringify([
            "prepared-phase-v1",
            failureInput.entityKind,
            failureInput.entityId,
            phase,
            prepared ??
              (retirement
                ? {
                    targets: retirement.targets.map((row) => ({
                      id: row.id,
                      status: row.status,
                      data: row.data,
                      fingerprint: row.fingerprint,
                    })),
                    after: retirement.after,
                  }
                : phase === "dependencies"
                  ? [scope?.route, scope?.after, dependencyRefs]
                  : null),
          ]),
        ),
      };
    const previousFailure = await readPhaseFailure(db, failureInput);
    const blocked =
      previousFailure &&
      previousFailure.attempts >= DERIVED_REFRESH_MAX_FAILURES
        ? previousFailure
        : null;
    const selectedScope = scope;
    await withTransactionDatabase(db, async (tx) => {
      const scope = selectedScope;
      await getDb(tx).execute(sql`SET LOCAL lock_timeout='100ms'`);
      await getDb(tx).execute(sql`SET LOCAL statement_timeout='1s'`);
      const metadata: (() => Promise<void>)[] = [];
      const updateScope = (
        values: Partial<typeof derivedRefreshScope.$inferInsert>,
      ) => {
        if (!scope) throw new Error("Missing derived refresh scope");
        metadata.push(async () => {
          await getDb(tx)
            .update(derivedRefreshScope)
            .set(values)
            .where(eq(derivedRefreshScope.id, scope.id));
        });
      };
      const current = work;
      let next: PgUpdateSetSource<typeof derivedRefreshWork> = {
        availableAt: sql`now()`,
      };
      const process = async () => {
        if (current.publishing) {
          if (publicationScope?.entityKind === "recipe" && recipeTotals) {
            const id = parseEntityId("recipe", publicationScope.entityId);
            await commitRecipeTotals(tx, {
              updates: [{ id, totals: recipeTotals }],
              freshOnlyIds: [],
              changedIds: [],
              processedIds: [id],
              inputRevision,
              cascadeParents: false,
            });
          }
          const failed = current.hasFailures || publicationErrors.length > 0;
          if (publicationErrors.length)
            next = {
              ...next,
              hasFailures: true,
              lastError: publicationErrors.join("\n"),
              attempts: DERIVED_REFRESH_MAX_FAILURES,
            };
          if (embeddingStates.some((state) => state.state === "pending")) {
            next = { ...next, availableAt: sql`now() + interval '10 seconds'` };
            return;
          }
          next = {
            ...next,
            publishAfter: publication.at(-1)?.id ?? current.publishAfter,
            ...(publication.length === 0
              ? { state: failed ? "failed" : "completed" }
              : {}),
          };
          if (!failed && publication.length)
            metadata.push(async () => {
              await getDb(tx)
                .delete(derivedRefreshScope)
                .where(
                  and(
                    eq(derivedRefreshScope.workId, work.id),
                    inArray(
                      derivedRefreshScope.id,
                      publication.map((scope) => scope.id),
                    ),
                  ),
                );
            });
          return;
        }
        if (!scope) {
          next = { ...next, publishing: true };
          return;
        }
        if (blocked) {
          const nextPhase = phaseAfterFailure(failureInput.phase);
          updateScope({
            version: current.version,
            phase: nextPhase,
            after: null,
            done: nextPhase === "completed",
            ...(scope.version !== current.version
              ? { route: 0, projected: false }
              : {}),
          });
          next = {
            ...next,
            hasFailures: true,
            attempts: Math.max(current.attempts, blocked.attempts),
            lastError: blocked.lastError,
          };
          return;
        }
        const parsedPhase = derivedRefreshPhase.safeParse(
          scope.version === current.version ? scope.phase : "projection",
        );
        if (!parsedPhase.success)
          throw new Error(`Invalid derived refresh phase: ${scope.phase}`, {
            cause: parsedPhase.error,
          });
        const phase = parsedPhase.data;
        if (scope.version !== current.version)
          updateScope({
            version: current.version,
            phase: "projection",
            after: null,
            route: 0,
            done: false,
            projected: false,
          });
        const advance = async (next: typeof phase) => {
          updateScope({
            phase: next,
            after: null,
            ...(next === "completed" ? { done: true } : {}),
          });
        };
        if (phase === "projection") {
          if (scope.entityKind === "recipe")
            await markRecipesStale(
              tx,
              [parseEntityId("recipe", scope.entityId)],
              inputRevision,
            );
          if (scope.entityKind === "product")
            await markProductConversionCoverageStale(tx, [
              parseEntityId("product", scope.entityId),
            ]);
          if (prepared)
            await publishPreparedSearchDocuments(tx, prepared, inputRevision);
          updateScope({ projected: true });
          await advance("assessment");
          return;
        }
        if (phase === "assessment") {
          if (!retirement)
            throw new Error("Missing prepared assessment retirement");
          await publishAssessmentRetirement(tx, retirement);
          if (retirement.done) await advance("recipe");
          else updateScope({ after: retirement.after });
          return;
        }
        if (phase === "recipe") {
          await advance("dependencies");
          return;
        }
        if (phase === "dependencies") {
          if (!route) {
            await advance("completed");
            return;
          }
          const refs = dependencyRefs;
          if (refs.length > 0)
            metadata.push(async () => {
              await getDb(tx)
                .insert(derivedRefreshScope)
                .values(refs.map((ref) => ({ ...ref, workId: work.id })))
                .onConflictDoUpdate({
                  target: [
                    derivedRefreshScope.workId,
                    derivedRefreshScope.entityKind,
                    derivedRefreshScope.entityId,
                  ],
                  set: {
                    traverse: true,
                    phase: sql`CASE WHEN ${derivedRefreshScope.done} THEN ${derivedRefreshPhase.enum.dependencies} ELSE ${derivedRefreshScope.phase} END`,
                    route: sql`CASE WHEN ${derivedRefreshScope.done} THEN 0 ELSE ${derivedRefreshScope.route} END`,
                    after: sql`CASE WHEN ${derivedRefreshScope.done} THEN NULL ELSE ${derivedRefreshScope.after} END`,
                    done: false,
                  },
                  setWhere: sql`NOT ${derivedRefreshScope.traverse} AND excluded.traverse`,
                });
            });
          updateScope(
            refs.length < DERIVED_REFRESH_PAGE
              ? { route: scope.route + 1, after: null }
              : { after: refs.at(-1)?.entityId },
          );
          return;
        }
        await advance("completed");
      };
      await process();
      await assertInputRevision(tx, inputRevision);
      await getDb(tx).execute(sql`SET LOCAL statement_timeout='250ms'`);
      for (const write of metadata) await write();
      // The target predicates are rechecked after waiting on a concurrent edit.
      // Zero rows rolls every output/cursor change back, including expired owners.
      const acknowledged = await getDb(tx)
        .update(derivedRefreshWork)
        .set({ ...next, leaseToken: null, leaseExpiresAt: null })
        .where(
          and(
            owned,
            sql`coalesce((SELECT revision FROM "DerivedRefreshRevision" WHERE key=${ALL_INPUT_REVISION_KEY}),0) = ${inputRevision}`,
          ),
        )
        .returning({ id: derivedRefreshWork.id });
      if (acknowledged.length === 0) throw new DerivedInputsChanged();
    });
    return {
      done: false,
      processed: 1,
      errors: work.hasFailures ? [] : publicationErrors,
    };
  } catch (error) {
    if (
      error instanceof DerivedInputsChanged ||
      ["55P03", "40P01"].includes(findPgError(error)?.code ?? "")
    ) {
      await getDb(db)
        .update(derivedRefreshWork)
        .set({ leaseToken: null, leaseExpiresAt: null })
        .where(owned);
      return { done: false, processed: 0, errors: [] };
    }
    const message = JSON.stringify(
      describeErrorCauses(error, { includeStacks: true }),
    );
    try {
      await withTransactionDatabase(db, async (tx) => {
        const failure = await recordPhaseFailure(tx, failureInput, message);
        const exhausted = failure.attempts >= DERIVED_REFRESH_MAX_FAILURES;
        if (exhausted && scope) {
          const nextPhase = phaseAfterFailure(failureInput.phase);
          await getDb(tx)
            .update(derivedRefreshScope)
            .set({
              version: work.version,
              phase: nextPhase,
              after: null,
              done: nextPhase === "completed",
              ...(scope.version !== work.version
                ? { route: 0, projected: false }
                : {}),
            })
            .where(eq(derivedRefreshScope.id, scope.id));
        }
        const acknowledged = await getDb(tx)
          .update(derivedRefreshWork)
          .set({
            attempts: Math.max(work.attempts, failure.attempts),
            lastError: message,
            hasFailures: work.hasFailures || exhausted,
            state:
              exhausted && !scope && !publicationScope ? "failed" : "pending",
            ...(exhausted && publicationScope
              ? { publishAfter: publicationScope.id }
              : {}),
            availableAt: exhausted
              ? sql`now()`
              : sql`now() + interval '1 minute' * ${failure.attempts}`,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(owned)
          .returning({ id: derivedRefreshWork.id });
        if (acknowledged.length === 0) throw new DerivedInputsChanged();
      });
    } catch (recordingError) {
      if (recordingError instanceof DerivedInputsChanged)
        return { done: false, processed: 0, errors: [] };
      throw recordingError;
    }
    return { done: false, processed: 0, errors: [message] };
  }
}
