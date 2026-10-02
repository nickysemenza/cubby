import { auditEntitySchema } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";
import { recordEmojiInput } from "@cubby/schemas/emoji";
import type { Entity } from "@cubby/schemas/entity";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";

import { logAuditEntry } from "./audit-log";
import { notDeleted, unwrapDb } from "./database-helpers";
import { SHORTCODE_TABLE } from "./generated/shortcode-tables.gen";

/** Every new identity write uses the shared emoji validation. */
export function normalizeRecordEmoji(entity: Entity, input: unknown) {
  const data = z.record(z.string(), z.unknown()).parse(input);
  const field = entityInspectorMetadata[entity].recordEmojiField;
  if (!field) return data;
  if (!Object.hasOwn(data, field)) return data;
  return { ...data, [field]: recordEmojiInput.parse(data[field]) };
}

/** The kernel owns identity persistence independently of repository domain patches. */
export function repositoryRecordInput(entity: Entity, input: unknown) {
  const data = { ...z.record(z.string(), z.unknown()).parse(input) };
  const field = entityInspectorMetadata[entity].recordEmojiField;
  if (!field) return data;
  delete data[field];
  return data;
}

export async function writeRecordEmoji(
  db: Database,
  entity: keyof typeof SHORTCODE_TABLE,
  id: string,
  input: unknown,
) {
  const field = entityInspectorMetadata[entity].recordEmojiField;
  if (!field) return;
  const data = z.record(z.string(), z.unknown()).parse(input);
  if (!Object.hasOwn(data, field)) return;
  const value = recordEmojiInput.parse(data[field]);
  const table = SHORTCODE_TABLE[entity];
  await unwrapDb(db).execute(
    sql`UPDATE ${table} SET ${sql.identifier(field)} = ${value} WHERE ${table.id} = ${id} AND ${table.deletedAt} IS NULL`,
  );
}

const identity = z.looseObject({ id: z.string() });
/** A single batched identity lookup, including readers that select explicit columns. */
export async function withRecordEmoji<Row>(
  db: Database | DrizzleTransaction,
  entity: keyof typeof SHORTCODE_TABLE,
  rows: readonly Row[],
): Promise<Row[]> {
  const field = entityInspectorMetadata[entity].recordEmojiField;
  if (!field || !rows.length) return [...rows];
  const codes = rows.map((row) => identity.parse(row).id);
  const table = SHORTCODE_TABLE[entity];
  const columns: Record<string, PgColumn> = getTableColumns(table);
  const column = columns[field];
  if (!column) throw new Error(`Missing declared emoji column for ${entity}`);
  const values = await unwrapDb(db)
    .select({ code: table.shortcode, emoji: sql<string | null>`${column}` })
    .from(table)
    .where(and(inArray(table.shortcode, codes), notDeleted(table)));
  const byCode = new Map(values.map((row) => [row.code, row.emoji]));
  return rows.map((row) => {
    const emoji = byCode.get(identity.parse(row).id) ?? null;
    return Object.assign({}, row, {
      [field]: emoji,
    });
  });
}

export async function recordEmojiBeforeUpdate(
  db: Database,
  entity: keyof typeof SHORTCODE_TABLE,
  code: string,
  input: unknown,
) {
  const field = entityInspectorMetadata[entity].recordEmojiField;
  if (
    !field ||
    !Object.hasOwn(z.record(z.string(), z.unknown()).parse(input), field)
  )
    return undefined;
  const table = SHORTCODE_TABLE[entity];
  const columns: Record<string, PgColumn> = getTableColumns(table);
  const column = columns[field];
  if (!column) throw new Error(`Missing declared emoji column for ${entity}`);
  const rows = await unwrapDb(db)
    .select({ value: sql<string | null>`${column}` })
    .from(table)
    .where(and(eq(table.shortcode, code), notDeleted(table)));
  return rows[0]?.value;
}
export async function auditRecordEmoji(
  db: Database,
  actor: ActorContext,
  entity: keyof typeof SHORTCODE_TABLE,
  id: string,
  previous: string | null | undefined,
  input: unknown,
) {
  const field = entityInspectorMetadata[entity].recordEmojiField;
  if (!field || previous === undefined) return;
  const value = recordEmojiInput.parse(
    z.record(z.string(), z.unknown()).parse(input)[field],
  );
  if (value !== previous)
    await logAuditEntry(db, actor, {
      entityKind: auditEntitySchema.parse(entity),
      entityId: id,
      action: "update",
      changes: { [field]: { from: previous, to: value } },
    });
}

/** A full-record edit may retain an unchanged legacy mark while editing another field. */
export async function normalizeSavedRecordEmoji(
  db: Database,
  entity: keyof typeof SHORTCODE_TABLE,
  code: string,
  input: unknown,
) {
  const data = z.record(z.string(), z.unknown()).parse(input);
  const presentation = entityInspectorMetadata[entity];
  const field = presentation.recordEmojiField;
  if (!field) return normalizeRecordEmoji(entity, data);
  if (
    Object.hasOwn(data, field) &&
    !recordEmojiInput.safeParse(data[field]).success
  ) {
    const previous = await recordEmojiBeforeUpdate(db, entity, code, {
      [field]: data[field],
    });
    if (previous === data[field])
      return Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== field),
      );
  }
  return normalizeRecordEmoji(entity, data);
}

/** Batched internal references also carry their record mark on search surfaces. */
export async function loadRecordEmojiReferences(
  db: Database,
  refs: readonly {
    entityKind: keyof typeof SHORTCODE_TABLE;
    entityId: string;
  }[],
): Promise<Map<string, string | null>> {
  const kinds = [...new Set(refs.map((ref) => ref.entityKind))];
  const values = await Promise.all(
    kinds.map(async (entity) => {
      const field = entityInspectorMetadata[entity].recordEmojiField;
      if (!field) return [];
      const table = SHORTCODE_TABLE[entity];
      const columns: Record<string, PgColumn> = getTableColumns(table);
      const column = columns[field];
      if (!column)
        throw new Error(`Missing declared emoji column for ${entity}`);
      const ids = refs
        .filter((ref) => ref.entityKind === entity)
        .map((ref) => ref.entityId);
      const rows = await unwrapDb(db)
        .select({
          id: sql<string>`${table.id}::text`,
          emoji: sql<string | null>`${column}`,
        })
        .from(table)
        .where(
          and(
            sql`${table.id}::text IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            notDeleted(table),
          ),
        );
      return rows.map((row) => [`${entity}:${row.id}`, row.emoji] as const);
    }),
  );
  return new Map(values.flat());
}
