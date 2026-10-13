import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey, type Entity } from "@cubby/schemas/entity";
import {
  type EntityFieldModel,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import type {
  EntitySourceInput,
  EntitySourceRead,
} from "@cubby/schemas/entity-source";
import { parseEntityRef, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { extractShortcodeFromScan, getShortcodeUrl } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { device, entityIdentity, entitySource, run } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";

import { unwrapDb } from "./database-helpers";
import { identityShortcodes, resolveEntityIdentity } from "./entity-identity";
import { lookupEntityLabels } from "./shortcode-resolver";

const cubbyOrigin = new URL(getShortcodeUrl("")).origin;

/** Only Cubby's own origin may turn a URL into an internal citation. */
function internalSourceCode(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  if (parsed.origin !== cubbyOrigin) return undefined;
  return extractShortcodeFromScan(url)?.shortcode;
}

/**
 * Sources (terminology "Source"): where a fact about an entity was seen. One
 * generic child of every entity, written by the entity kernel in the same
 * transaction as the mutation, and by image attach.
 */

type JsonValue = z.infer<ReturnType<typeof z.json>>;

const fieldsOf = (entity: Entity): EntityFieldModel =>
  entityFieldModels[entity];

/**
 * A field-scoped source must name a field the caller can write and the detail
 * read returns, so its value can be fingerprinted now and compared later.
 */
export function assertEntitySourceFieldPaths(
  entity: Entity,
  sources: readonly EntitySourceInput[] | undefined,
): void {
  const model = fieldsOf(entity);
  const writable = new Set<string>([...model.create, ...model.update]);
  for (const source of sources ?? []) {
    if (source.fieldPath === undefined) continue;
    const field = model.fields.find((field) => field.key === source.fieldPath);
    if (!writable.has(source.fieldPath) || !field?.readKey)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Source fieldPath ${source.fieldPath} is not a writable ${entityInspectorMetadata[entity].singular} field.`,
      );
  }
}

/**
 * A detail row as JSON — dates become ISO strings — the one shape both the
 * write path and the read path fingerprint.
 */
export const entityDetailJson = z.preprocess(
  (value) => JSON.parse(JSON.stringify(value ?? null)),
  z.json(),
);

const jsonObject = z.record(z.string(), z.json());

/** Order-independent JSON for objects. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = jsonObject.safeParse(value);
  if (!object.success) return JSON.stringify(value);
  return `{${Object.keys(object.data)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object.data[key]!)}`)
    .join(",")}}`;
}

/**
 * The fingerprint of one field's value on a detail row (the repository
 * `get` shape, as JSON). Writes and reads both fingerprint that same shape,
 * so a source supports the current value exactly while the field is
 * unchanged.
 */
function entityFieldFingerprint(
  entity: Entity,
  detail: JsonValue,
  fieldPath: string,
): Promise<string> {
  const readKey =
    fieldsOf(entity).fields.find((field) => field.key === fieldPath)?.readKey ??
    fieldPath;
  const fields = jsonObject.safeParse(detail);
  const value = fields.success ? (fields.data[readKey] ?? null) : null;
  return sha256Hex(canonicalJson(value));
}

const sameText = (column: PgColumn, value: string | null): SQL =>
  value === null ? isNull(column) : eq(column, value);

/**
 * Insert sources for one entity, skipping any identical to a row it already
 * has (same field, url, quote, variant, observation time and value). The
 * recorder is always the actor, never caller input.
 */
export async function recordEntitySources(
  db: Database | DrizzleTransaction,
  args: {
    entityKind: Entity;
    entityId: string;
    sources: readonly EntitySourceInput[];
    recorder: ActorContext;
    /** The entity's detail row after the write; needed for field-scoped sources. */
    detail?: JsonValue;
  },
): Promise<void> {
  if (args.sources.length === 0) return;
  assertEntitySourceFieldPaths(args.entityKind, args.sources);
  const client = unwrapDb(db);
  for (const source of args.sources) {
    const sourceCode = source.sourceEntity ?? internalSourceCode(source.url);
    const target = sourceCode
      ? await resolveEntityIdentity(db, sourceCode)
      : null;
    if (target?.state === "missing") {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Source entity not found: ${sourceCode}`,
      );
    }
    const sourceEntityId =
      target === null
        ? null
        : target.state === "redirected"
          ? target.canonicalId
          : target.id;
    const sourceEntityKind = target === null ? null : target.kind;
    const valueFingerprint =
      source.fieldPath === undefined
        ? null
        : await entityFieldFingerprint(
            args.entityKind,
            args.detail ?? null,
            source.fieldPath,
          );
    const row = {
      entityId: args.entityId,
      entityKind: args.entityKind,
      fieldPath: source.fieldPath ?? null,
      url: sourceCode ? null : (source.url ?? null),
      sourceEntityId,
      sourceEntityKind,
      quote: source.quote ?? null,
      observedAt: source.observedAt ?? null,
      selectedVariant: source.selectedVariant ?? null,
      valueFingerprint,
    };
    const [duplicate] = await client
      .select({ id: entitySource.id })
      .from(entitySource)
      .where(and(eq(entitySource.entityId, row.entityId), sameSource(row)))
      .limit(1);
    if (duplicate) continue;
    await client.insert(entitySource).values({
      ...row,
      userId: args.recorder.userId,
      channel: args.recorder.channel,
      oauthClientId: args.recorder.oauthClientId,
      deviceId: args.recorder.deviceId,
      runId: args.recorder.runId,
    });
  }
}

type SourceIdentity = Pick<
  typeof entitySource.$inferSelect,
  | "fieldPath"
  | "url"
  | "sourceEntityId"
  | "sourceEntityKind"
  | "quote"
  | "observedAt"
  | "selectedVariant"
  | "valueFingerprint"
>;

const sameSource = (row: SourceIdentity): SQL =>
  and(
    sameText(entitySource.fieldPath, row.fieldPath),
    sameText(entitySource.url, row.url),
    sameText(entitySource.sourceEntityId, row.sourceEntityId),
    sameText(entitySource.sourceEntityKind, row.sourceEntityKind),
    sameText(entitySource.quote, row.quote),
    sameText(entitySource.selectedVariant, row.selectedVariant),
    sameText(entitySource.valueFingerprint, row.valueFingerprint),
    row.observedAt === null
      ? isNull(entitySource.observedAt)
      : eq(entitySource.observedAt, row.observedAt),
  )!;

/**
 * Merge: the losers' sources follow the survivor; one identical to a source
 * the survivor already has is dropped rather than kept twice.
 */
export async function repointEntitySources(
  tx: DrizzleTransaction,
  args: { keepId: string; loserIds: readonly string[] },
): Promise<void> {
  if (args.loserIds.length === 0) return;
  // Citations are historical incoming edges: every merge repoints them without
  // treating them as live dependencies that can refuse deletion.
  const citations = await tx
    .select()
    .from(entitySource)
    .where(inArray(entitySource.sourceEntityId, [...args.loserIds]))
    .orderBy(asc(entitySource.createdAt), asc(entitySource.id));
  for (const citation of citations) {
    const moved = { ...citation, sourceEntityId: args.keepId };
    const [duplicate] = await tx
      .select({ id: entitySource.id })
      .from(entitySource)
      .where(
        and(eq(entitySource.entityId, citation.entityId), sameSource(moved)),
      )
      .limit(1);
    if (duplicate)
      await tx.delete(entitySource).where(eq(entitySource.id, citation.id));
    else
      await tx
        .update(entitySource)
        .set({ sourceEntityId: args.keepId })
        .where(eq(entitySource.id, citation.id));
  }
  const moving = await tx
    .select()
    .from(entitySource)
    .where(inArray(entitySource.entityId, [...args.loserIds]))
    .orderBy(asc(entitySource.createdAt), asc(entitySource.id));
  for (const row of moving) {
    const [duplicate] = await tx
      .select({ id: entitySource.id })
      .from(entitySource)
      .where(and(eq(entitySource.entityId, args.keepId), sameSource(row)))
      .limit(1);
    if (duplicate) {
      await tx.delete(entitySource).where(eq(entitySource.id, row.id));
      continue;
    }
    await tx
      .update(entitySource)
      .set({ entityId: args.keepId })
      .where(eq(entitySource.id, row.id));
  }
}

/**
 * Detail read: every source of each entity, newest first, each field-scoped
 * one marked by whether it still supports the field's current value.
 */
export async function loadEntitySources(
  db: Database | DrizzleTransaction,
  entityKind: Entity,
  details: ReadonlyArray<{ entityId: string; detail: JsonValue }>,
): Promise<Map<string, EntitySourceRead[]>> {
  const result = new Map<string, EntitySourceRead[]>();
  if (details.length === 0) return result;
  const rows = await unwrapDb(db)
    .select({
      entityId: entitySource.entityId,
      fieldPath: entitySource.fieldPath,
      url: entitySource.url,
      sourceEntityId: entitySource.sourceEntityId,
      sourceEntityKind: entitySource.sourceEntityKind,
      quote: entitySource.quote,
      observedAt: entitySource.observedAt,
      selectedVariant: entitySource.selectedVariant,
      valueFingerprint: entitySource.valueFingerprint,
      channel: entitySource.channel,
      oauthClientId: entitySource.oauthClientId,
      runShortcode: run.shortcode,
      deviceShortcode: device.shortcode,
      createdAt: entitySource.createdAt,
    })
    .from(entitySource)
    // includes-deleted: a recorder Run or Device that was removed still names who recorded.
    .leftJoin(run, eq(run.id, entitySource.runId))
    .leftJoin(device, eq(device.id, entitySource.deviceId))
    .where(
      and(
        eq(entitySource.entityKind, entityKind),
        inArray(
          entitySource.entityId,
          details.map((detail) => detail.entityId),
        ),
      ),
    )
    .orderBy(sql`${entitySource.createdAt} DESC`, asc(entitySource.id));
  const targets = await loadEntitySourceTargets(db, rows);
  const fingerprints = new Map<string, Promise<string>>();
  const currentFingerprint = (entityId: string, fieldPath: string) => {
    const key = `${entityId}\u0000${fieldPath}`;
    let fingerprint = fingerprints.get(key);
    if (!fingerprint) {
      const detail =
        details.find((item) => item.entityId === entityId)?.detail ?? null;
      fingerprint = entityFieldFingerprint(entityKind, detail, fieldPath);
      fingerprints.set(key, fingerprint);
    }
    return fingerprint;
  };
  for (const row of rows) {
    const list = result.get(row.entityId) ?? [];
    list.push({
      fieldPath: row.fieldPath,
      url: row.url,
      sourceEntity: row.sourceEntityId
        ? (targets.get(row.sourceEntityId) ?? null)
        : null,
      quote: row.quote,
      observedAt: row.observedAt,
      selectedVariant: row.selectedVariant,
      supportsCurrentValue:
        row.fieldPath === null
          ? null
          : row.valueFingerprint ===
            (await currentFingerprint(row.entityId, row.fieldPath)),
      recorder: {
        channel: row.channel,
        oauthClientId: row.oauthClientId,
        runId: row.runShortcode
          ? parseShortcodeFor("run", row.runShortcode)
          : null,
        deviceId: row.deviceShortcode
          ? parseShortcodeFor("device", row.deviceShortcode)
          : null,
      },
      createdAt: row.createdAt,
    });
    result.set(row.entityId, list);
  }
  return result;
}

/** Durable identity survives hard deletion; retained payloads supply past labels. */
export async function loadEntitySourceTargets(
  db: Database | DrizzleTransaction,
  rows: ReadonlyArray<{ sourceEntityId: string | null }>,
): Promise<Map<string, NonNullable<EntitySourceRead["sourceEntity"]>>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) => (row.sourceEntityId ? [row.sourceEntityId] : [])),
    ),
  ];
  if (ids.length === 0) return new Map();
  const identities = await identityShortcodes(db, ids);
  const refs = [...identities].map(([id, identity]) =>
    parseEntityRef(identity.kind, id),
  );
  const labels = await lookupEntityLabels(db, refs);
  // includes-deleted: Source citations deliberately survive target removal.
  const states = await unwrapDb(db)
    .select({ id: entityIdentity.id, deletedAt: entityIdentity.deletedAt })
    .from(entityIdentity)
    .where(inArray(entityIdentity.id, ids));
  const deleted = new Set(
    states.filter((row) => row.deletedAt !== null).map((row) => row.id),
  );
  const targets = new Map<
    string,
    NonNullable<EntitySourceRead["sourceEntity"]>
  >();
  for (const [id, identity] of identities) {
    if (!identity.shortcode) continue;
    targets.set(id, {
      entityKind: identity.kind,
      entityId: identity.canonicalShortcode ?? identity.shortcode,
      name: labels.get(entityRefKey(identity.kind, id)) ?? null,
      deleted: deleted.has(id),
    });
  }
  return targets;
}
