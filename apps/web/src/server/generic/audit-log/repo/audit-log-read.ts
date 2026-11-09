import {
  auditEntitySchema,
  type AuditEntityKind,
  type AuditJsonValue,
  type AuditLogListOut,
} from "@cubby/schemas/audit";
import { auditChannelSchema, type AuditChannel } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  entityManifest,
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import {
  type DeviceId,
  type RunId,
  parseEntityRef,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { oauthClient } from "~/server/db/auth.schema";
import { EDGE_KEY_TARGET_ENTITY } from "~/server/db/entity-incoming-edges";
import { eqAny, unwrapDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { auditLog } from "~/server/db/schema";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { identityShortcodes } from "~/server/entity-kernel/repo/entity-identity";
import {
  type EntityRef,
  lookupEntityLabels,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  auditActionSchema,
  AuditChanges,
  readStoredChanges,
  isNonEmptyString,
  AuditLogRow,
  encodeAuditCursor,
  decodeAuditCursor,
} from "./audit-log";

/**
 * Every FK-shaped ref (target entity + raw uuid value) named inside a single
 * entry's `changes` diff — both the `from` and `to` side of each field that
 * `EDGE_KEY_TARGET_ENTITY` recognizes as a foreign key. Feeds the same batched
 * `lookupShortcodes` round-trip as the entry's own `entityId`, so a raw uuid
 * inside `changes` (e.g. `vendorId`, `purchaseId`) never reaches an MCP
 * payload any more than the top-level `entityId` does.
 */
const changeTargetEntity = (
  entityKind: AuditEntityKind,
  field: string,
): ShortcodeEntity | undefined => {
  const declaration = entityManifest[entityKind];
  const physical = declaration.dbTable
    ? EDGE_KEY_TARGET_ENTITY.get(`${declaration.dbTable}.${field}`)
    : undefined;
  if (physical) return physical;
  const relationship = declaration.relationships.find(
    (relation) => relation.key === field,
  );
  return shortcodeEntities.find((entity) => entity === relationship?.target);
};

function collectChangeRefs(
  entityKind: AuditEntityKind,
  changes: AuditChanges | null,
): EntityRef[] {
  if (!changes) return [];
  const dbTable = entityManifest[entityKind].dbTable;
  if (!dbTable) return [];

  const refs: EntityRef[] = [];
  for (const [field, diff] of Object.entries(changes)) {
    const targetEntity = changeTargetEntity(entityKind, field);
    if (!targetEntity) continue;
    for (const value of [diff.from, diff.to].flatMap((side) =>
      Array.isArray(side) ? side : [side],
    )) {
      if (isNonEmptyString(value) && z.uuid().safeParse(value).success)
        refs.push(parseEntityRef(targetEntity, value));
    }
  }
  return refs;
}

/**
 * Remap a single entry's `changes` diff, replacing any FK-shaped `from`/`to`
 * value with its resolved shortcode. Non-FK fields, and values that didn't
 * resolve (deleted rows, malformed data, anything not in `shortcodeByRef`),
 * pass through unchanged — never coerced to null. `shortcodeByRef` must
 * already contain every ref `collectChangeRefs` found for this entry.
 */
function remapChangeShortcodes(
  entityKind: AuditEntityKind,
  changes: AuditChanges | null,
  shortcodeByRef: Map<string, string>,
): Record<string, { from?: AuditJsonValue; to?: AuditJsonValue }> | null {
  if (!changes) return null;
  const resolveValue = (
    targetEntity: ShortcodeEntity,
    value: AuditJsonValue | undefined,
  ): AuditJsonValue | undefined =>
    Array.isArray(value)
      ? value.map((item) => resolveValue(targetEntity, item) ?? null)
      : isNonEmptyString(value)
        ? (shortcodeByRef.get(entityRefKey(targetEntity, value)) ?? value)
        : value;

  const remapped: Record<
    string,
    { from?: AuditJsonValue; to?: AuditJsonValue }
  > = {};
  for (const [field, diff] of Object.entries(changes)) {
    const targetEntity = changeTargetEntity(entityKind, field);
    remapped[field] = targetEntity
      ? {
          from: resolveValue(targetEntity, diff.from),
          to: resolveValue(targetEntity, diff.to),
        }
      : { from: diff.from, to: diff.to };
  }
  return remapped;
}

/** OAuth client display names, resolved at read time (clients can be renamed). */
async function lookupOauthClientNames(
  db: Database,
  clientIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (clientIds.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({ clientId: oauthClient.clientId, name: oauthClient.name })
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, [...new Set(clientIds)]));
  return new Map(rows.map((row) => [row.clientId, row.name]));
}

/**
 * Query audit log entries with pagination.
 */
export async function getAuditLog(
  db: Database,
  params: {
    entityKind?: AuditEntityKind;
    entityId?: string;
    /**
     * Repo-only cohort narrowing (uuids, not shortcodes): the entity timeline
     * reads one audit window for every record in a list scope. Never exposed
     * on the browser/MCP audit input, whose subject is a single shortcode.
     */
    entityIds?: readonly string[];
    channel?: AuditChannel | AuditChannel[];
    oauthClientId?: string;
    /** Device and Run uuids; the workflow resolves the public shortcodes. */
    deviceId?: DeviceId;
    runId?: RunId;
    // Both ISO date strings — inclusive bounds on `createdAt`.
    createdAtFrom?: string;
    createdAtTo?: string;
    limit: number;
    cursor?: string; // Opaque composite cursor from `encodeAuditCursor`
  },
): Promise<AuditLogListOut> {
  // Migration 0007 kept each Run's retired dispatch counter as a `run` row.
  // Run is not an audit subject, so reads expose only auditable kinds.
  const conditions: SQL[] = [
    inArray(auditLog.entityKind, auditEntitySchema.options),
  ];

  if (params.entityKind) {
    conditions.push(eq(auditLog.entityKind, params.entityKind));
  }

  if (params.entityId) {
    conditions.push(eq(auditLog.entityId, params.entityId));
  }

  if (params.entityIds) {
    if (params.entityIds.length === 0) return { entries: [] };
    conditions.push(inArray(auditLog.entityId, [...params.entityIds]));
  }

  const channelCondition = eqAny(auditLog.channel, params.channel);
  if (channelCondition) conditions.push(channelCondition);
  if (params.oauthClientId)
    conditions.push(eq(auditLog.oauthClientId, params.oauthClientId));
  if (params.deviceId) conditions.push(eq(auditLog.deviceId, params.deviceId));
  if (params.runId) conditions.push(eq(auditLog.runId, params.runId));

  if (params.createdAtFrom) {
    conditions.push(gte(auditLog.createdAt, new Date(params.createdAtFrom)));
  }

  if (params.createdAtTo) {
    conditions.push(lte(auditLog.createdAt, new Date(params.createdAtTo)));
  }

  // Cursor-based pagination: get entries older than cursor. ANDs with
  // `createdAtTo` above rather than reconciling the two — both are upper
  // bounds on the same indexed column, so the extra predicate is index-served
  // and simply narrows the window further.
  if (params.cursor) {
    const cursor = decodeAuditCursor(params.cursor);
    const cursorCondition = or(
      lt(auditLog.createdAt, cursor.createdAt),
      and(eq(auditLog.createdAt, cursor.createdAt), lt(auditLog.id, cursor.id)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const entries = await unwrapDb(db).query.auditLog.findMany({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          conditions.length > 0 ? and(...conditions) : undefined,
        ),
    },
    orderBy: (table: PgTable) =>
      [[desc(auditLog.createdAt), desc(auditLog.id)]]
        .flat()
        .map((value) => relationalSql(table, value)),
    limit: params.limit + 1, // Fetch one extra to determine if there's more
    with: {
      identity: {
        columns: { shortcode: true },
        with: { canonical: { columns: { shortcode: true } } },
      },
      user: {
        columns: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      device: { columns: { shortcode: true, name: true } },
      run: { columns: { shortcode: true } },
    },
  });

  // Determine if there are more entries
  const hasMore = entries.length > params.limit;
  const returnEntries: AuditLogRow[] = (
    hasMore ? entries.slice(0, params.limit) : entries
  ).map((entry) => ({
    ...entry,
    action: auditActionSchema.parse(entry.action),
    channel: auditChannelSchema.parse(entry.channel),
    changes: entry.changes == null ? null : readStoredChanges(entry.changes),
  }));
  const lastEntry = returnEntries.at(-1);
  const nextCursor =
    hasMore && lastEntry ? encodeAuditCursor(lastEntry) : undefined;

  const entryRefs: EntityRef[] = returnEntries.map((entry) =>
    parseEntityRef(entry.entityKind, entry.entityId),
  );
  const changeRefs = returnEntries.flatMap((entry) =>
    collectChangeRefs(entry.entityKind, entry.changes),
  );

  // AuditLog's identity FK guarantees every subject has an Entity row. Read
  // those codes once, including codes inside changes, instead of querying each
  // payload table again for the same shortcodes.
  // Change refs share the subject's label and image batches so a
  // relationship diff renders as the record it points at.
  const labelRefs = [...entryRefs, ...changeRefs];
  const [nameByRef, displayImageByRef, clientNames, identities] =
    await Promise.all([
      lookupEntityLabels(db, labelRefs),
      resolveEntityDisplayImages(
        db,
        labelRefs.map(({ entity, id }) => ({
          entityKind: entity,
          entityId: id,
        })),
      ),
      lookupOauthClientNames(
        db,
        returnEntries.flatMap((entry) => entry.oauthClientId ?? []),
      ),
      identityShortcodes(
        db,
        changeRefs.map((ref) => ref.id),
      ),
    ]);
  const shortcodeByRef = new Map(
    changeRefs.flatMap((ref) => {
      const identity = identities.get(ref.id);
      const shortcode =
        identity?.kind === ref.entity ? identity.shortcode : null;
      return shortcode
        ? [
            [
              entityRefKey(ref.entity, ref.id),
              parseShortcodeFor(ref.entity, shortcode),
            ] as const,
          ]
        : [];
    }),
  );
  return {
    entries: returnEntries.map(
      ({
        id,
        entityId,
        identity,
        changes,
        oauthClientId,
        deviceId: _deviceId,
        runId: _runId,
        device,
        run,
        ...entry
      }) => ({
        ...entry,
        oauthClient: oauthClientId
          ? { id: oauthClientId, name: clientNames.get(oauthClientId) ?? null }
          : null,
        device: device
          ? {
              id: parseShortcodeFor("device", device.shortcode),
              name: device.name,
            }
          : null,
        runId: run ? parseShortcodeFor("run", run.shortcode) : null,
        entryKey: encodeAuditCursor({ id, createdAt: entry.createdAt }),
        // `Entity` still knows a hard-deleted payload's code.
        entityId: identity?.shortcode ?? null,
        canonicalEntityId: identity?.canonical?.shortcode ?? null,
        entityName:
          nameByRef.get(entityRefKey(entry.entityKind, entityId)) ?? null,
        displayImage:
          displayImageByRef.get(entityRefKey(entry.entityKind, entityId)) ??
          null,
        changes: remapChangeShortcodes(
          entry.entityKind,
          changes,
          shortcodeByRef,
        ),
        references: Object.fromEntries(
          collectChangeRefs(entry.entityKind, changes).flatMap((ref) => {
            const key = entityRefKey(ref.entity, ref.id);
            const shortcode = shortcodeByRef.get(key);
            return shortcode
              ? [
                  [
                    shortcode,
                    {
                      name: nameByRef.get(key) ?? null,
                      displayImage: displayImageByRef.get(key) ?? null,
                    },
                  ],
                ]
              : [];
          }),
        ),
      }),
    ),
    nextCursor,
  };
}
