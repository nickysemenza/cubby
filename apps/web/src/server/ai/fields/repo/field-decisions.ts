/**
 * A person's field writes are decisions (ADR 0029 section 1, ADR 0028 item
 * 4). An edit records an assignment; an edit over a value Cubby held is also
 * the correction: it rules Cubby's value out for that record and rechecks at
 * most 25 records where Cubby holds the same value, those sharing a parent
 * first. An import's write is a decision of the system actor and grades
 * nothing.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { undecidedFieldValue } from "@cubby/schemas/field-suggestion-policy";
import { FIELDS_SCOPE, recordScopeKey } from "@cubby/schemas/kernel/capability";
import {
  decisionChannel,
  decisionKind,
  type DecisionKind,
} from "@cubby/schemas/kernel/stage";
import { getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";

import type { FieldValue } from "~/server/ai/policy/field-rules";
import type { DrizzleTransaction } from "~/server/db";
import { Database } from "~/server/db/database";
import { databaseForTransaction } from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import type { DecisionInput, ScopeRef } from "~/server/kernel/api";
import { recordSubject } from "~/server/kernel/keys";

/** The kernel's runtime, loaded on use so entity writers do not load its graph. */
const kernel = () => import("~/server/kernel/api");

import {
  fieldsPlanOf,
  type EntityFieldsPlan,
  type FieldPlan,
  type FieldsChanges,
  type FieldsRow,
} from "./plan";

/** Records one correction rechecks (ADR 0028 item 5). */
const RECHECK_LIMIT = 25;

const ASSIGNMENT = sqlEnumConstant(decisionChannel, "assignment");
const RELEASE = sqlEnumConstant(decisionKind, "release");

type FieldEdit = {
  field: string;
  /** The stored value before the edit, as JSON. */
  from: FieldValue;
  /** The value the person chose, as JSON. */
  to: FieldValue;
};

const isPerson = (actor: ActorContext) => actor.channel !== "system";

/** The newest assignment kind in force per field of one record. */
export async function assignmentsInForce(
  db: Database,
  entity: ShortcodeEntity,
  recordId: string,
  fields: readonly string[],
): Promise<Map<string, { kind: DecisionKind; value: unknown }>> {
  if (!fields.length) return new Map();
  const rows = z
    .array(
      z.object({ slot: z.string(), kind: decisionKind, value: z.unknown() }),
    )
    .parse(
      (
        await repositoryQueries(db).execute<FieldsRow>(sql`
          SELECT DISTINCT ON (d.slot) d.slot, d.kind, d.value FROM "Decision" d
          WHERE d.channel = ${ASSIGNMENT}
            AND d.subject = ${recordSubject(entity, recordId)}
            AND d.slot = ANY(${textArrayParam(fields)})
          ORDER BY d.slot, d.at DESC, d.id DESC`)
      ).rows,
    );
  return new Map(
    rows
      .filter((row) => row.kind !== "release")
      .map((row) => [row.slot, { kind: row.kind, value: row.value }]),
  );
}

/** Up to 25 records where Cubby holds `value`, records sharing a parent first. */
async function recheckScopes(
  db: Database,
  plan: EntityFieldsPlan,
  field: FieldPlan,
  recordId: string,
  value: FieldValue,
): Promise<ScopeRef[]> {
  const columns = getTableColumns(plan.table);
  const column = (key: string) => sql.identifier(columns[key]!.name);
  const shares = field.parents.length
    ? sql.join(
        field.parents.map(
          (key) => sql`t.${column(key)} = subject.${column(key)}`,
        ),
        sql` OR `,
      )
    : sql`false`;
  const live = plan.hasDeletedAt
    ? sql`AND t.${column("deletedAt")} IS NULL`
    : sql``;
  const rows = z.array(z.object({ id: z.string() })).parse(
    (
      await repositoryQueries(db).execute<FieldsRow>(sql`
          SELECT t.id::text AS id FROM ${plan.table} t
          JOIN ${plan.table} subject ON subject.id = ${recordId}::uuid
          WHERE t.id <> subject.id AND t.${column(field.key)}::text = ${String(value)} ${live}
            AND COALESCE((
              SELECT d.kind FROM "Decision" d
              WHERE d.channel = ${ASSIGNMENT}
                AND d.subject = ${`${plan.entity}:`} || t.id::text AND d.slot = ${field.key}
              ORDER BY d.at DESC, d.id DESC LIMIT 1), ${RELEASE}) = ${RELEASE}
          ORDER BY (${shares}) DESC, t.id
          LIMIT ${RECHECK_LIMIT}`)
    ).rows,
  );
  return rows.map((row) => ({
    kind: FIELDS_SCOPE,
    key: recordScopeKey(plan.entity, row.id),
  }));
}

/**
 * Record a person's or an import's edits of `fields` columns as decisions in
 * the caller's transaction. Returns the record's `fields` scope when an edit
 * names a column only the scope writes, so the caller applies it now.
 */
async function recordFieldEdits(
  db: Database,
  actor: ActorContext,
  plan: EntityFieldsPlan,
  recordId: string,
  edits: readonly FieldEdit[],
): Promise<ScopeRef | null> {
  const fields = edits.flatMap((edit) => {
    const field = plan.fields.find((candidate) => candidate.key === edit.field);
    return field ? [{ field, edit }] : [];
  });
  if (!fields.length) return null;
  const subject = recordSubject(plan.entity, recordId);
  const held = await assignmentsInForce(
    db,
    plan.entity,
    recordId,
    fields.map(({ field }) => field.key),
  );
  const decisions: DecisionInput[] = [];
  const rechecks: ScopeRef[] = [];
  for (const { field, edit } of fields) {
    const none = undecidedFieldValue(plan.entity, field.key, edit.to);
    decisions.push({
      channel: "assignment",
      kind: none ? "none" : "set",
      subject,
      field: field.key,
      value: none ? null : edit.to,
    });
    const correctsCubby =
      isPerson(actor) &&
      field.apply === "auto" &&
      !held.has(field.key) &&
      !undecidedFieldValue(plan.entity, field.key, edit.from) &&
      String(edit.from) !== String(edit.to);
    if (!correctsCubby) continue;
    decisions.push({
      channel: "veto",
      kind: "veto",
      subject,
      field: field.key,
      value: edit.from,
    });
    rechecks.push(
      ...(await recheckScopes(db, plan, field, recordId, edit.from)),
    );
  }
  if (rechecks.length) decisions[0] = { ...decisions[0]!, scopes: rechecks };
  await (await kernel()).decide(db, actor, decisions);
  return fields.some(({ field }) => field.apply === "auto")
    ? { kind: FIELDS_SCOPE, key: recordScopeKey(plan.entity, recordId) }
    : null;
}

/**
 * Split an entity write's values: authored columns stay in the write, and the
 * `fields` columns this scope writes become decisions ({@link settleFieldEdits}).
 */
export type SplitFieldsValues<V> = { authored: V; owned: FieldsRow };

export function splitFieldsValues<V extends object>(
  plan: EntityFieldsPlan | undefined,
  values: V,
): SplitFieldsValues<V> {
  if (!plan?.writes.length) return { authored: values, owned: {} };
  const owned = new Set(plan.writes);
  const entries = Object.entries(values);
  return {
    // SAFETY: a subset of the caller's own keys and values.
    authored: Object.fromEntries(
      entries.filter(([key]) => !owned.has(key)),
    ) as V,
    owned: Object.fromEntries(
      entries.filter(([key, value]) => owned.has(key) && value !== undefined),
    ),
  };
}

const toJson = (value: unknown): FieldValue => {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  // SAFETY: fill fields are scalar columns (enums, references, text).
  return value as FieldValue;
};

/**
 * Record an entity write's field edits as decisions and apply the owned ones
 * now, in the writer's transaction: `owned` are the `fields` columns the write
 * named, `changes` its audited diff of the other columns.
 */
export async function settleFieldEdits(
  db: Database,
  actor: ActorContext,
  plan: EntityFieldsPlan | undefined,
  recordId: string,
  before: Readonly<FieldsRow>,
  owned: Readonly<FieldsRow>,
  changes?: FieldsChanges,
): Promise<void> {
  if (!plan) return;
  const edits: FieldEdit[] = [
    ...Object.entries(owned).flatMap(([field, value]) =>
      String(toJson(before[field])) === String(toJson(value))
        ? []
        : [{ field, from: toJson(before[field]), to: toJson(value) }],
    ),
    ...Object.entries(changes ?? {}).flatMap(([field, change]) =>
      plan.fields.some((candidate) => candidate.key === field) &&
      !Object.hasOwn(owned, field)
        ? [{ field, from: toJson(change.from), to: toJson(change.to) }]
        : [],
    ),
  ];
  const scope = await recordFieldEdits(db, actor, plan, recordId, edits);
  if (scope) {
    const outcomes = await (
      await kernel()
    ).reconcileNow(db, [scope], { waitMs: 2_000 });
    const failed = outcomes.find((outcome) => outcome.status === "failed");
    if (failed)
      throw (
        failed.cause ??
        new Error(failed.error ?? "Field assignment could not be applied")
      );
  }
}

/**
 * An entity writer's values with the `fields` columns held back: write
 * `values` (a create leaves the held columns DEFAULT), then call `settle` in
 * the same transaction, which emits the write's kernel keys, records the
 * edits as decisions and applies the held columns through the `fields` scope.
 * A create passes no `before`. For the shared writers, which emit their own
 * keys, use {@link splitFieldsValues} and {@link settleFieldEdits}.
 */
export type HeldFieldsValues<V> = {
  values: V;
  /** The `fields` columns held back from the write. */
  held: readonly string[];
  settle(
    db: Database | DrizzleTransaction,
    actor: ActorContext,
    recordId: string,
    before?: Readonly<FieldsRow>,
    changes?: FieldsChanges,
  ): Promise<void>;
};

export function holdFieldsValues<V extends object>(
  entity: string,
  written: V,
  mode: "create" | "update" = "update",
): HeldFieldsValues<V> {
  const plan = fieldsPlanOf(entity);
  const { authored, owned } = splitFieldsValues(plan, written);
  return {
    values: authored,
    held: Object.keys(owned),
    async settle(db, actor, recordId, before, changes) {
      const database = db instanceof Database ? db : databaseForTransaction(db);
      if (plan)
        await (
          await kernel()
        ).emitWrites(database, {
          table: plan.table,
          ids: [recordId],
          columns: Object.entries(authored).flatMap(([key, value]) =>
            value === undefined ? [] : [key],
          ),
          entity,
          created: mode === "create",
        });
      await settleFieldEdits(
        database,
        actor,
        plan,
        recordId,
        before ??
          (mode === "update" && plan && Object.keys(owned).length
            ? ((await (
                await import("./stored-field")
              ).readStoredColumns(
                database,
                plan,
                recordId,
                Object.keys(owned),
              )) ?? {})
            : {}),
        owned,
        changes ??
          (mode === "create"
            ? Object.fromEntries(
                Object.entries(authored).flatMap(([key, value]) =>
                  value === null || value === undefined
                    ? []
                    : [[key, { from: null, to: value }] as const],
                ),
              )
            : undefined),
      );
    },
  };
}
