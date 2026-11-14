/**
 * The `fields` reconciler (ADR 0029 section 2): one implementation for every
 * entity whose manifest declares AI fill-in. A scope is one record, keyed
 * `entity:id`. Its load reads the record's basis and field columns, the
 * field's earlier values and its precedents; its reconcile reads the
 * assignment and veto decisions and the field Asks' Answers, applies ADR
 * 0028's rules ({@link decideField}) and patches the `apply: "auto"` columns,
 * including a person's assignment, which only this scope may write.
 *
 * Asked: open or Cubby-held `auto` and `review` fields with a usable basis,
 * except a value Cubby held at cutover whose basis and value are unchanged
 * and that no person has since ruled out on another record. A blank field's
 * ask is a fill: a version sweep files it rather than proposing Drift.
 * `offer` fields only read an existing answer for the picker. A person-held
 * field and a `fillOnly` field Cubby already filled are not asked here; declared prune reviews may propose removals from a person-held
 * array and always wait for a decision.
 */
import { auditLogActionSchema } from "@cubby/schemas/audit";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { undecidedFieldValue } from "@cubby/schemas/field-suggestion-policy";
import { FIELDS_SCOPE } from "@cubby/schemas/kernel/capability";
import type { MachineryCapability } from "@cubby/schemas/kernel/capability";
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { ModelInput } from "~/server/ai/model-asks";
import {
  decideField,
  fieldJson,
  valueKey,
  type FieldValue,
} from "~/server/ai/policy/field-rules";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { decision } from "~/server/db/kernel-schema";
import { auditLog } from "~/server/db/retained-tables";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  defineReconciler,
  recordSubject,
  source,
  writes,
  type AskKind,
  type ColumnRef,
  type Reads,
  type Reconciler,
} from "~/server/kernel/api";

import { analysisSources, analysisAsk, loadAnalysis } from "./analysis";
import { fieldAsk, fieldBaselineAsk, type FieldAskInput } from "./ask";
import type { FieldAnswer } from "./repo/field-answer";
import {
  fieldsPlanOf,
  fieldsPlans,
  type EntityFieldsPlan,
  type FieldPlan,
  type FieldsRow,
} from "./repo/plan";
import {
  correctedSql,
  PRECEDENT_LIMIT,
  personHoldsSql,
  type Precedent,
} from "./repo/precedents";

/** The version of the rules below; a change is swept, never re-asked (ADR 0029 section 11). */
const FIELDS_VERSION = 2;

type Row = FieldsRow;

type FieldsInput = {
  entity: ShortcodeEntity;
  id: string;
  row: Row | null;
  analysis: ModelInput | null;
  /** Values each field held before a later write replaced them. */
  replaced: ReadonlyMap<string, readonly string[]>;
  precedents: ReadonlyMap<string, readonly Precedent[]>;
  /** Values a person ruled out on another record of the entity since this record's last assignment. */
  ruledOutSince: ReadonlyMap<string, readonly string[]>;
  questions?: ReadonlyMap<string, FieldAskInput["questions"]>;
};

// Catalog membership, reference labels and inherited contexts used by field preparation.
const fieldSourceTables = [...new Set(Object.values(SHORTCODE_TABLE))];
const moneyHistoryTables = new Set<PgTable>([
  SHORTCODE_TABLE.purchase,
  SHORTCODE_TABLE.expense,
  SHORTCODE_TABLE.financialTransaction,
]);
function fieldSources(plan: EntityFieldsPlan, field: FieldPlan) {
  const tables = new Set<import("drizzle-orm/pg-core").PgTable>();
  if (field.reference) tables.add(SHORTCODE_TABLE[field.reference]);
  if (field.parents.length) tables.add(plan.table);
  if (plan.entity === "productCategory" && field.key === "feature")
    tables.add(plan.table);
  for (const basis of field.basis) {
    const model = entityFieldModels[plan.entity].fields.find(
      (model) => model.key === basis,
    );
    const ref = model && "reference" in model ? model.reference : null;
    if (
      ref &&
      "entity" in ref &&
      typeof ref.entity === "string" &&
      Object.hasOwn(SHORTCODE_TABLE, ref.entity)
    ) {
      // SAFETY: Object.hasOwn above proves this target belongs to the generated table map.
      tables.add(SHORTCODE_TABLE[ref.entity as keyof typeof SHORTCODE_TABLE]);
    }
  }
  return [...tables];
}
function fieldInput(input: FieldsInput, field: FieldPlan): FieldAskInput {
  return {
    entity: input.entity,
    field: field.key,
    recordId: input.id,
    row: Object.fromEntries(
      [...new Set([...field.basis, field.key])].map((key) => [
        key,
        fieldJson(input.row![key]),
      ]),
    ),
    precedents: [...(input.precedents.get(field.key) ?? [])],
  };
}
const SCOPE_KEY = /^([A-Za-z][\w-]*):([0-9a-f-]{36})$/u;

/** The record a `fields` scope key names. */
function fieldsScopeRecord(
  key: string,
): { entity: ShortcodeEntity; id: string } | null {
  const match = SCOPE_KEY.exec(key);
  const plan = match ? fieldsPlanOf(match[1]!) : undefined;
  return match && plan ? { entity: plan.entity, id: match[2]! } : null;
}

const columnOf = (plan: EntityFieldsPlan, key: string): SQL => {
  const column = getTableColumns(plan.table)[key];
  if (!column) throw new Error(`${plan.tableName} has no column ${key}`);
  return sql`${sql.identifier(column.name)}`;
};

const labelOf = (value: unknown) => (typeof value === "string" ? value : null);

const auditChanges = z.record(
  z.string(),
  z.object({ from: z.unknown().optional() }).passthrough(),
);

/** One statement per entity: the values each field held before a write replaced them. */
async function loadReplaced(
  reads: Reads,
  plan: EntityFieldsPlan,
  ids: readonly string[],
): Promise<Map<string, Map<string, string[]>>> {
  const fields = plan.fields.map((field) => field.key);
  const rows = await reads.select(
    auditLog,
    [],
    sql`${auditLog.entityKind} = ${plan.entity} AND ${auditLog.entityId} = ANY(${uuidArrayParam(ids)})
      AND ${auditLog.action} = ${auditLogActionSchema.enum.update} AND ${auditLog.changes} ?| ${sql`ARRAY[${sql.join(
        fields.map((field) => sql`${field}`),
        sql`, `,
      )}]::text[]`}`,
  );
  const byRecord = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const changes = auditChanges.safeParse(row.changes);
    if (!changes.success) continue;
    const record = byRecord.get(row.entityId) ?? new Map<string, string[]>();
    for (const field of fields) {
      const from = changes.data[field]?.from;
      if (from === undefined || from === null || from === "") continue;
      record.set(field, [...(record.get(field) ?? []), valueKey(from)]);
    }
    byRecord.set(row.entityId, record);
  }
  return byRecord;
}

/**
 * Two statements per entity: per record and field, the values a person vetoed
 * on another record of the entity after this record's newest assignment. A
 * correction rechecks the records where Cubby holds the corrected value; this
 * is the newer member evidence that releases the cutover's hold on them.
 */
async function loadRuledOutSince(
  reads: Reads,
  plan: EntityFieldsPlan,
  ids: readonly string[],
): Promise<Map<string, Map<string, string[]>>> {
  const fields = plan.fields.map((field) => field.key);
  const byRecord = new Map<string, Map<string, string[]>>();
  if (!fields.length || !ids.length) return byRecord;
  const subjects = ids.map((id) => recordSubject(plan.entity, id));
  const [vetoes, assignments] = await Promise.all([
    reads.select(
      decision,
      [],
      sql`${decision.channel} = ${"veto"} AND ${decision.kind} = ${"veto"}
        AND ${decision.field} = ANY(${textArrayParam(fields)})
        AND starts_with(${decision.subject}, ${`${plan.entity}:`})`,
    ),
    reads.select(
      decision,
      [],
      sql`${decision.channel} = ${"assignment"} AND ${decision.subject} = ANY(${textArrayParam(subjects)})`,
    ),
  ]);
  if (!vetoes.length) return byRecord;
  const assigned = new Map<string, number>();
  for (const row of assignments) {
    const slot = `${row.subject}\u0000${row.slot}`;
    assigned.set(slot, Math.max(assigned.get(slot) ?? 0, row.at.getTime()));
  }
  for (const [index, id] of ids.entries()) {
    const subject = subjects[index]!;
    const record = new Map<string, string[]>();
    for (const veto of vetoes)
      if (
        veto.subject !== subject &&
        veto.field &&
        veto.at.getTime() > (assigned.get(`${subject}\u0000${veto.field}`) ?? 0)
      )
        record.set(veto.field, [
          ...(record.get(veto.field) ?? []),
          valueKey(veto.value),
        ]);
    if (record.size) byRecord.set(id, record);
  }
  return byRecord;
}

/**
 * Two statements per field with parents: each subject's newest person-held
 * values on records sharing a parent, and the corrected ones among them.
 */
async function loadPrecedents(
  reads: Reads,
  plan: EntityFieldsPlan,
  field: FieldPlan,
  subjects: readonly Row[],
): Promise<Map<string, Precedent[]>> {
  const ids = subjects.map((row) => String(row.id));
  const sameParent = sql.join(
    field.parents.map(
      (key) => sql`c.${columnOf(plan, key)} = s.${columnOf(plan, key)}`,
    ),
    sql` OR `,
  );
  const target = columnOf(plan, field.key);
  const live = plan.hasDeletedAt
    ? sql`AND c.${columnOf(plan, "deletedAt")} IS NULL`
    : sql``;
  const newest = plan.hasUpdatedAt
    ? sql`date_trunc('milliseconds', c."updatedAt") DESC NULLS LAST, c.id`
    : sql`c.id`;
  const candidates = (corrected: boolean) =>
    reads.select(
      plan.table,
      [],
      sql`${plan.table.id} IN (
        SELECT p.id FROM ${plan.table} s
        CROSS JOIN LATERAL (
          SELECT c.id FROM ${plan.table} c
          WHERE c.id <> s.id AND (${sameParent}) ${live}
            AND c.${target} IS NOT NULL
            AND ${personHoldsSql(plan.entity, field.key, sql`c.id`)}
            ${corrected ? sql`AND ${correctedSql(plan.entity, field.key, sql`c.id`)}` : sql``}
          ORDER BY ${newest}
          LIMIT ${PRECEDENT_LIMIT}
        ) p
        WHERE s.id = ANY(${uuidArrayParam(ids)}))`,
    );
  const [corrected, all] = await Promise.all([
    candidates(true),
    candidates(false),
  ]);
  const correctedIds = new Set(corrected.map((row) => String(row.id)));
  const updatedAt = (row: Row) => {
    const time = new Date(String(row.updatedAt)).getTime();
    return Number.isFinite(time) ? time : -Infinity;
  };
  // Match SQL's timestamp precision and identity tie-break across batch sizes.
  const newestFirst = (rows: readonly Row[]) =>
    [...rows].sort(
      (a, b) =>
        (plan.hasUpdatedAt ? updatedAt(b) - updatedAt(a) : 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const ordered = [
    ...newestFirst(corrected),
    ...newestFirst(all.filter((row) => !correctedIds.has(String(row.id)))),
  ];
  return new Map(
    subjects.map((subject) => [
      String(subject.id),
      ordered
        .filter(
          (row) =>
            row.id !== subject.id &&
            field.parents.some(
              (key) =>
                subject[key] !== null &&
                subject[key] !== undefined &&
                valueKey(row[key]) === valueKey(subject[key]),
            ),
        )
        .slice(0, PRECEDENT_LIMIT)
        .map((row) => ({
          label: plan.label ? labelOf(row[plan.label]) : null,
          value: fieldJson(row[field.key]),
          corrected: correctedIds.has(String(row.id)),
        })),
    ]),
  );
}

async function load(
  reads: Reads,
  keys: readonly string[],
  prepare = false,
): Promise<Map<string, FieldsInput>> {
  const inputs = new Map<string, FieldsInput>();
  const groups = new Map<ShortcodeEntity, { key: string; id: string }[]>();
  for (const key of keys) {
    const record = fieldsScopeRecord(key);
    if (!record) continue;
    groups.set(record.entity, [
      ...(groups.get(record.entity) ?? []),
      { key, id: record.id },
    ]);
  }
  await Promise.all(
    [...groups].map(async ([entity, items]) => {
      const plan = fieldsPlans().get(entity)!;
      const ids = items.map((item) => item.id);
      const held = prepare
        ? await reads.select(
            decision,
            [],
            sql`${decision.channel}=${"assignment"} AND ${decision.subject}=ANY(${textArrayParam(items.map((item) => `${entity}:${item.id}`))})`,
          )
        : [];
      held.sort(
        (a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id),
      );
      const assignments = new Map<string, string>();
      for (const row of held)
        if (!assignments.has(`${row.subject}:${row.field}`))
          assignments.set(`${row.subject}:${row.field}`, row.kind);
      const [rows, replaced, ruledOutSince] = await Promise.all([
        Promise.all(
          items.map(
            async (item): Promise<Row | null> =>
              (await reads.for(item.key).rows(plan.table, [item.id])).get(
                item.id,
              ) ?? null,
          ),
        ),
        loadReplaced(reads, plan, ids),
        loadRuledOutSince(reads, plan, ids),
      ]);
      const live: Row[] = rows.flatMap((row) =>
        row && !(plan.hasDeletedAt && row.deletedAt) ? [row] : [],
      );
      const precedentsByField = new Map(
        await Promise.all(
          plan.fields
            .filter((field) => field.parents.length && live.length)
            .map(
              async (field) =>
                [
                  field.key,
                  await loadPrecedents(reads, plan, field, live),
                ] as const,
            ),
        ),
      );
      for (const [index, item] of items.entries()) {
        const row = rows[index] ?? null;
        inputs.set(item.key, {
          entity,
          id: item.id,
          row: row && live.includes(row) ? row : null,
          replaced: replaced.get(item.id) ?? new Map(),
          ruledOutSince: ruledOutSince.get(item.id) ?? new Map(),
          analysis: row
            ? await loadAnalysis(
                reads.for(item.key),
                entity,
                item.id,
                String(row.name ?? "this location"),
              )
            : null,
          precedents: new Map(
            [...precedentsByField].map(([field, bySubject]) => [
              field,
              bySubject.get(item.id) ?? [],
            ]),
          ),
        });
      }
      if (!prepare || entity === "run") return;
      const requests: {
        field: string;
        input: FieldAskInput;
        questions: Map<string, FieldAskInput["questions"]>;
      }[] = [];
      for (const item of items) {
        const loaded = inputs.get(item.key)!;
        if (!loaded.row) continue;
        const questions = new Map<string, FieldAskInput["questions"]>();
        loaded.questions = questions;
        const fields = plan.fields.filter(
          (field) =>
            (field.mode !== "prune" || !blank(loaded.row![field.key])) &&
            (field.mode === "prune" ||
              !assignments.has(`${entity}:${item.id}:${field.key}`) ||
              assignments.get(`${entity}:${item.id}:${field.key}`) ===
                "release") &&
            (blank(loaded.row![field.key]) || !field.fillOnly) &&
            field.basis.some((key) => !blank(loaded.row![key])),
        );
        // Capture before shared I/O; later scopes reuse already seen revisions.
        await reads
          .for(item.key)
          .prepare(
            [...new Set(fields.flatMap((field) => fieldSources(plan, field)))],
            async () => {},
          );
        for (const field of fields)
          requests.push({
            field: field.key,
            input: fieldInput(loaded, field),
            questions,
          });
      }
      // Capture each scope's roster revisions before the shared data read.
      // A source write during preparation then fails the publication fence.
      if (!requests.length) return;
      const prepared = await reads.prepare([], async (db) =>
        (await import("~/server/ai/fields/produce")).prepareFieldQuestions(
          db,
          requests.map((request) => request.input),
        ),
      );
      // Preparation preserves request order and returns one list per input.
      for (const [index, request] of requests.entries())
        request.questions.set(request.field, prepared[index]!);
    }),
  );
  return inputs;
}

const blank = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/**
 * The `fields` reconciler and its column declarations, built from the
 * manifest; `ask` is the field Ask (a test binds a stand-in producer).
 */
export function fieldsReconciler(
  ask: AskKind<FieldAskInput, FieldAnswer> = fieldAsk,
): Reconciler<FieldsInput> {
  const plans = [...fieldsPlans().values()];
  const writeRefs = new Map<ShortcodeEntity, ColumnRef>(
    plans.flatMap((plan) =>
      plan.writes.length
        ? [
            [
              plan.entity,
              // SAFETY: the plan lists only columns of this table.
              writes(plan.table, plan.writes as never[], {
                entity: plan.entity,
              }),
            ] as const,
          ]
        : [],
    ),
  );
  return defineReconciler<FieldsInput>({
    scope: FIELDS_SCOPE,
    lane: "catalog",
    version: FIELDS_VERSION,
    reads: [
      // SAFETY: as above.
      ...fieldSourceTables.map((table) =>
        (moneyHistoryTables.has(table) ? source.history : source.table)(
          table,
          Object.keys(getTableColumns(table)) as never[],
        ),
      ),
      source.table(auditLog, ["changes"]),
      source.table(decision, ["subject", "field", "channel", "kind", "at"]),
      ...analysisSources,
    ],
    writes: [...writeRefs.values()],
    asks: [ask, fieldBaselineAsk, analysisAsk("location"), analysisAsk("run")],
    load: (reads, keys) => load(reads, keys, ask === fieldAsk),
    reconcile(input, c) {
      const plan = fieldsPlans().get(input.entity)!;
      // Fields patch an authored identity; imported legacy keys remain accepted
      // even when the field has no answer or the payload was soft-deleted.
      const target = writeRefs.get(input.entity);
      if (target)
        for (const key of c.existing(target)) c.retire(target, key, "keep");
      const row = input.row;
      if (!row) return c.done();
      if (input.analysis) c.answer(analysisAsk(input.entity), input.analysis);
      const subject = recordSubject(input.entity, input.id);
      for (const field of plan.fields) {
        if (field.mode === "prune" && blank(row[field.key])) continue;
        const assignment = c.decision("assignment", subject, field.key);
        const vetoed = (
          c.decision("veto", subject, field.key)?.values ?? []
        ).map(valueKey);
        const raw = row[field.key];
        // SAFETY: fill fields are scalar columns (enums, references, text).
        const current = fieldJson(raw) as FieldValue;
        const currentUndecided = undecidedFieldValue(
          input.entity,
          field.key,
          raw,
        );
        const ruledOut =
          !currentUndecided && vetoed.includes(valueKey(current));
        const prune = field.mode === "prune";
        const asked =
          (assignment === null || prune) &&
          (prune || currentUndecided || ruledOut || !field.fillOnly) &&
          field.basis.some((key) => !blank(row[key]));
        let proposal = null;
        if (asked) {
          const askInput: FieldAskInput = {
            entity: input.entity,
            field: field.key,
            recordId: input.id,
            row: Object.fromEntries(
              [...new Set([...field.basis, field.key])].map((key) => [
                key,
                fieldJson(row[key]),
              ]),
            ),
            precedents: [...(input.precedents.get(field.key) ?? [])],
            questions: input.questions?.get(field.key),
          };
          // The cutover's value stands while its basis and value are unchanged
          // and no person has since ruled that value out on another record.
          const baseline = c.answer(
            fieldBaselineAsk,
            { entity: input.entity, recordId: input.id, field: field.key },
            { request: false },
          );
          const held =
            baseline.status === "answered" &&
            !(input.ruledOutSince.get(field.key) ?? []).includes(
              valueKey(current),
            ) &&
            Object.entries(askInput.row).every(
              ([key, value]) =>
                valueKey(fieldJson(baseline.output.record[key])) ===
                valueKey(value),
            );
          // Asking for a blank field changes no accepted record.
          const answer = held
            ? null
            : c.answer(ask, askInput, {
                request: field.apply !== "offer",
                fill: currentUndecided && !prune,
              });
          if (answer?.status === "answered") proposal = answer.output.proposal;
        }
        // A person's decision on a column this scope owns is applied here;
        // the entity's writer applies only authored columns (decide).
        if (assignment && target && field.apply === "auto") {
          // SAFETY: an assignment's value is the field's scalar JSON.
          const setValue = assignment.value as FieldValue;
          const decided =
            assignment.kind === "set" ? setValue : field.undecided;
          if (valueKey(decided) !== valueKey(current))
            c.patch(target, input.id, { [field.key]: decided });
          continue;
        }
        const verdict = decideField({
          apply: field.apply,
          fillOnly: field.fillOnly,
          current,
          currentUndecided,
          personHolds: !prune && assignment !== null,
          vetoed,
          replaced: (input.replaced.get(field.key) ?? []).filter(
            (value) => value !== valueKey(current),
          ),
          proposal,
        });
        if (verdict.kind === "write" && target)
          c.patch(target, input.id, { [field.key]: verdict.value });
        else if (
          proposal &&
          field.apply !== "offer" &&
          (!assignment || prune) &&
          !vetoed.includes(valueKey(proposal.value)) &&
          valueKey(proposal.value) !== valueKey(current)
        )
          c.gap.decision(
            `Review ${entityFieldModels[plan.entity].fields.find((candidate) => candidate.key === field.key)?.label ?? "this value"}`,
            {
              actions: [
                {
                  channel: "assignment",
                  kind: "set",
                  subject,
                  field: field.key,
                  value: proposal.value,
                  label: "Use this value",
                },
                {
                  channel: "veto",
                  kind: "veto",
                  subject,
                  field: field.key,
                  value: proposal.value,
                  label: "Wrong",
                },
              ],
            },
          );
      }
      return c.done();
    },
  });
}

/** The machinery capability of every authored entity with a `fields` scope. */
export function fieldsCapabilities(): MachineryCapability[] {
  return [...fieldsPlans().keys()].map((entity) => ({
    entity,
    owning: null,
    fields: true,
    quality: false,
  }));
}
