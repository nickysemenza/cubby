import {
  DERIVED_REFRESH_ROOT_PAGE,
  derivedRefreshCapture,
  derivedRefreshState,
  derivedRefreshPhase,
  type DerivedRefreshCapture,
} from "@cubby/schemas/derived-refresh";
import type { Entity } from "@cubby/schemas/entity-core";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import {
  repositoryQueries as unwrapDb,
  repositoryAfterCommit,
  repositoryBeforeCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  derivedRefreshCaptureInbox,
  derivedRefreshRevision,
  derivedRefreshScope,
  derivedRefreshWork,
} from "~/server/db/schema";
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";
import { publishInBackground } from "~/server/workflows/background-tasks/publish";

import {
  refreshDependencyRoutes,
  refreshEndpointDependencyRoutes,
} from "./dependencies";
import { refreshInputKeys } from "./input-keys";

export type RefreshCapture = DerivedRefreshCapture;

// Execution-ledger changes are outputs, not new household inputs. Excluding
// these prevents refresh Runs and their own progress from perpetually waking work.
const executionEntities = new Set<Entity>(["run"]);

/** Capture only roots and already-known OLD/NEW endpoints, never dependents. */
export async function captureDerivedRefresh(
  db: RepositoryQueryInput,
  captures: readonly RefreshCapture[],
  options: { invalidate?: boolean; revisionKeys?: readonly string[] } = {},
): Promise<void> {
  const inputs = captures.filter(
    (ref) => !executionEntities.has(ref.entityKind),
  );
  if (inputs.length === 0 && !options.revisionKeys?.length) return;
  await repositoryBeforeCommit(
    db,
    (tx) => flushDerivedRefresh(tx, inputs, options),
    {
      changedKeys: [
        ...(options.revisionKeys ?? []),
        ...inputs.flatMap((ref) => [
          `kind:${ref.entityKind}`,
          `entity:${ref.entityKind}:${ref.entityId}`,
        ]),
      ],
    },
  );
}

async function flushDerivedRefresh(
  db: RepositoryQueryInput,
  captures: readonly RefreshCapture[],
  options: { invalidate?: boolean; revisionKeys?: readonly string[] },
): Promise<void> {
  const byRoot = new Map<string, RefreshCapture>();
  for (const entry of captures) {
    if (executionEntities.has(entry.entityKind)) continue;
    const key = `${entry.entityKind}:${entry.entityId}`;
    const previous = byRoot.get(key);
    byRoot.set(
      key,
      previous
        ? {
            ...entry,
            scopes: [...(previous.scopes ?? []), ...(entry.scopes ?? [])],
            changedFields:
              previous.changedFields && entry.changedFields
                ? [
                    ...new Set([
                      ...previous.changedFields,
                      ...entry.changedFields,
                    ]),
                  ]
                : undefined,
          }
        : entry,
    );
  }
  const entries = [...byRoot.values()];
  const client = unwrapDb(db);
  const keys = new Set([
    "all",
    ...(options.revisionKeys ?? []),
    ...entries.flatMap((entry) => [
      `kind:${entry.entityKind}`,
      `entity:${entry.entityKind}:${entry.entityId}`,
    ]),
  ]);
  if (options.invalidate !== false)
    await client
      .insert(derivedRefreshRevision)
      .values([...keys].map((key) => ({ key, revision: 1 })))
      .onConflictDoUpdate({
        target: derivedRefreshRevision.key,
        set: { revision: sql`${derivedRefreshRevision.revision} + 1` },
      });
  else
    await client
      .insert(derivedRefreshRevision)
      .values({ key: "all", revision: 0 })
      .onConflictDoNothing();
  if (entries.length === 0) {
    await repositoryAfterCommit(db, (committedDb) =>
      publishInBackground(
        committedDb,
        [
          {
            kind: "derived-refresh.wakeup",
            requestedAt: new Date().toISOString(),
          },
        ],
        { source: "derived-refresh.context" },
      ),
    );
    return;
  }
  const revisions = new Map(
    await readInputRevisions(
      db,
      entries.flatMap((entry) => refreshInputKeys(entry.entityKind)),
    ),
  );
  const values = await Promise.all(
    entries.map(async (change) => ({
      entityKind: change.entityKind,
      entityId: change.entityId,
      change,
      inputFingerprint: await sha256Hex(
        JSON.stringify(
          refreshInputKeys(change.entityKind).map((key) => [
            key,
            revisions.get(key) ?? 0,
          ]),
        ),
      ),
      force: options.invalidate !== false,
    })),
  );
  await client.insert(derivedRefreshCaptureInbox).values(values);
  await repositoryAfterCommit(db, (committedDb) =>
    publishInBackground(
      committedDb,
      [
        {
          kind: "derived-refresh.wakeup",
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "derived-refresh.capture" },
    ),
  );
}

/** Fold and acknowledge exactly one locked page; rollback retains every capture. */
export async function foldDerivedRefreshCaptures(
  db: Database,
): Promise<number> {
  // Most frontier pages have no new inputs. Avoid opening a write transaction
  // for an empty inbox; a later capture has its own wake-up and periodic repair.
  const [pending] = await unwrapDb(db)
    .select({ id: derivedRefreshCaptureInbox.id })
    .from(derivedRefreshCaptureInbox)
    .limit(1);
  if (!pending) return 0;
  return withTransactionDatabase(db, async (tx) => {
    const client = unwrapDb(tx);
    const page = await client
      .select()
      .from(derivedRefreshCaptureInbox)
      .orderBy(
        asc(derivedRefreshCaptureInbox.createdAt),
        asc(derivedRefreshCaptureInbox.id),
      )
      .limit(DERIVED_REFRESH_ROOT_PAGE)
      .for("update", { skipLocked: true });
    // Match Work/Scope lock order across concurrent folders.
    for (const row of page.sort((a, b) =>
      `${a.entityKind}:${a.entityId}`.localeCompare(
        `${b.entityKind}:${b.entityId}`,
      ),
    )) {
      const capture = derivedRefreshCapture.parse(row.change);
      const value = {
        entityKind: capture.entityKind,
        entityId: capture.entityId,
        auditId: capture.auditId,
        changedFields: capture.changedFields
          ? Object.fromEntries(
              capture.changedFields.map((field) => [field, true]),
            )
          : null,
        inputFingerprint: row.inputFingerprint,
      };
      await materializeCapture(tx, capture, value, row.force);
    }
    if (page.length)
      await client.delete(derivedRefreshCaptureInbox).where(
        inArray(
          derivedRefreshCaptureInbox.id,
          page.map((row) => row.id),
        ),
      );
    return page.length;
  });
}

async function materializeCapture(
  db: RepositoryQueryInput,
  capture: RefreshCapture,
  input: {
    entityKind: Entity;
    entityId: string;
    auditId?: string;
    changedFields: Record<string, boolean> | null;
    inputFingerprint: string;
  },
  force: boolean,
) {
  const client = unwrapDb(db);
  const value = input;
  // A worker publishes output, then scopes, then its Work acknowledgement.
  // An existing root must therefore receive new scopes before its Work changes.
  const [created] = await client
    .insert(derivedRefreshWork)
    .values(value)
    .onConflictDoNothing({
      target: [derivedRefreshWork.entityKind, derivedRefreshWork.entityId],
    })
    .returning({ id: derivedRefreshWork.id });
  const [existing] = created
    ? []
    : await client
        .select({ id: derivedRefreshWork.id })
        .from(derivedRefreshWork)
        .where(
          and(
            eq(derivedRefreshWork.entityKind, value.entityKind),
            eq(derivedRefreshWork.entityId, value.entityId),
          ),
        )
        .limit(1);
  const owner = created ?? existing;
  if (!owner)
    throw new Error("Derived refresh root disappeared during capture");
  const endpointScopes = new Map(
    (capture.scopes ?? [])
      .filter(
        (scope) =>
          scope.entityKind !== value.entityKind ||
          scope.entityId !== value.entityId,
      )
      .map((scope) => [`${scope.entityKind}:${scope.entityId}`, scope]),
  );
  const scopes = [
    {
      entityKind: value.entityKind,
      entityId: value.entityId,
      traverse: true,
    },
    ...[...endpointScopes.values()].map((scope) => ({
      ...scope,
      // Endpoint identity changed; the endpoint's own inputs did not.
      // Only declared reverse dependencies (for example Product pricing)
      // or a narrower saved-endpoint frontier may continue through its graph.
      traverse:
        refreshEndpointDependencyRoutes(value.entityKind, scope.entityKind) !==
          undefined ||
        refreshDependencyRoutes(value.entityKind).some(
          (route) => route.entity === scope.entityKind && route.transitive,
        ),
    })),
  ]
    .sort((a, b) =>
      `${a.entityKind}:${a.entityId}`.localeCompare(
        `${b.entityKind}:${b.entityId}`,
      ),
    )
    .map((scope) => ({ workId: owner.id, ...scope }));
  await client
    .insert(derivedRefreshScope)
    .values(scopes)
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
  if (created) return;
  const changedFields =
    value.changedFields === null
      ? sql`NULL`
      : sql`${JSON.stringify(value.changedFields)}::jsonb`;
  await client
    .update(derivedRefreshWork)
    .set({
      version: sql`${derivedRefreshWork.version}+1`,
      inputFingerprint: value.inputFingerprint,
      auditId: value.auditId,
      changedFields: sql`CASE WHEN ${derivedRefreshWork.state}=${derivedRefreshState.enum.completed} THEN ${changedFields}
        WHEN ${derivedRefreshWork.changedFields} IS NULL OR ${changedFields} IS NULL THEN NULL
        ELSE ${derivedRefreshWork.changedFields} || ${changedFields} END`,
      state: "pending",
      attempts: 0,
      hasFailures: false,
      lastError: null,
      availableAt: sql`now()`,
      publishing: false,
      publishAfter: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(derivedRefreshWork.id, owner.id),
        !force
          ? or(
              eq(derivedRefreshWork.state, derivedRefreshState.enum.completed),
              sql`${derivedRefreshWork.inputFingerprint} IS DISTINCT FROM ${value.inputFingerprint}`,
            )
          : undefined,
      ),
    )
    .returning({ id: derivedRefreshWork.id });
}
