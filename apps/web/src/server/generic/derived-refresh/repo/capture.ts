import {
  derivedRefreshState,
  type DerivedRefreshCapture,
} from "@cubby/schemas/derived-refresh";
import type { Entity } from "@cubby/schemas/entity-core";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, or, sql } from "drizzle-orm";

import {
  repositoryQueries as unwrapDb,
  repositoryAfterCommit,
  repositoryBeforeCommit,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  derivedRefreshRevision,
  derivedRefreshScope,
  derivedRefreshWork,
} from "~/server/db/schema";
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";
import { publishInBackground } from "~/server/workflows/background-tasks/publish";

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
    entries.map(async ({ entityKind, entityId, auditId, changedFields }) => ({
      entityKind,
      entityId,
      auditId,
      changedFields: changedFields
        ? Object.fromEntries(changedFields.map((field) => [field, true]))
        : null,
      inputFingerprint: await sha256Hex(
        JSON.stringify(
          refreshInputKeys(entityKind).map((key) => [
            key,
            revisions.get(key) ?? 0,
          ]),
        ),
      ),
    })),
  );
  let scheduled = false;
  // A worker publishes output, then scopes, then its Work acknowledgement.
  // An existing root must therefore receive new scopes before its Work changes.
  for (const value of values.sort((a, b) =>
    `${a.entityKind}:${a.entityId}`.localeCompare(
      `${b.entityKind}:${b.entityId}`,
    ),
  )) {
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
    const capture = byRoot.get(`${value.entityKind}:${value.entityId}`);
    const scopes = [
      { entityKind: value.entityKind, entityId: value.entityId },
      ...(capture?.scopes ?? []),
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
      .onConflictDoNothing();
    if (created) {
      scheduled = true;
      continue;
    }
    const changedFields =
      value.changedFields === null
        ? sql`NULL`
        : sql`${JSON.stringify(value.changedFields)}::jsonb`;
    const changed = await client
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
          options.invalidate === false
            ? or(
                eq(
                  derivedRefreshWork.state,
                  derivedRefreshState.enum.completed,
                ),
                sql`${derivedRefreshWork.inputFingerprint} IS DISTINCT FROM ${value.inputFingerprint}`,
              )
            : undefined,
        ),
      )
      .returning({ id: derivedRefreshWork.id });
    scheduled ||= changed.length > 0;
  }
  if (!scheduled) return;
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
