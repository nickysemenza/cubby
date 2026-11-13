/**
 * The evidence-facts kernel's storage (ADR 0029 section 4). None of these
 * tables is an entity: they carry no shortcode and nothing links to them.
 * They address records by kernel keys (`<entity>:<uuid>` subjects, scope
 * refs, fact refs), so they hold no foreign keys into entity tables; the
 * kernel's writers own their integrity.
 */
import {
  askProducer,
  askState,
  bindingBasis,
  kernelLane,
  kernelWaitCause,
  type AskProducer,
  type AskState,
  type BindingBasis,
  type KernelLane,
  type KernelJson,
  type KernelWaitCause,
  type ScopeInputRef,
} from "@cubby/schemas/kernel/machinery";
import {
  decisionActorKind,
  decisionChannel,
  decisionKind,
  type DecisionActorKind,
  kernelStage,
  type DecisionChannel,
  type DecisionKind,
  type KernelGap,
  type KernelStage,
} from "@cubby/schemas/kernel/stage";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { z } from "zod";

import { sqlEnumConstant } from "./sql-enum";

const enumCheck = <const V extends Record<string, string>>(
  name: string,
  column: AnyPgColumn,
  schema: z.ZodEnum<V>,
): ReturnType<typeof check> =>
  check(
    name,
    sql`${column} IN (${sql.join(
      schema.options.map((value) => sqlEnumConstant(schema, value)),
      sql`, `,
    )})`,
  );

const createdAt = () =>
  timestamp("createdAt", { mode: "date" }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updatedAt", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** The claim columns one module owns for `ScopeDirty`, `Ask` and `Pass`. */
const claimColumns = () => ({
  claimToken: uuid("claimToken"),
  claimDeadline: timestamp("claimDeadline", { mode: "date" }),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("availableAt", { mode: "date" })
    .notNull()
    .defaultNow(),
  waitCause: text("waitCause").$type<KernelWaitCause>(),
  lastError: text("lastError"),
});

const waitCauseCheck = (column: AnyPgColumn): SQL =>
  sql`${column} IS NULL OR ${column} IN (${sql.join(
    kernelWaitCause.options.map((value) =>
      sqlEnumConstant(kernelWaitCause, value),
    ),
    sql`, `,
  )})`;

/**
 * Member and agent decisions in four channels, each resolved by its newest
 * row per `(subject, channel, slot)`. `slot` is the channel's resolution key
 * within the subject: the field (assignment), the field and value key (veto),
 * the other subject of an unordered pair (identity), or empty (rejection).
 */
export const decision = pgTable(
  "Decision",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    channel: text("channel").$type<DecisionChannel>().notNull(),
    subject: text("subject").notNull(),
    slot: text("slot").notNull(),
    field: text("field"),
    kind: text("kind").$type<DecisionKind>().notNull(),
    value: jsonb("value").$type<KernelJson>(),
    /** An identity decision's other subject; `subject` sorts first. */
    other: text("other"),
    actorKind: text("actorKind").$type<DecisionActorKind>().notNull(),
    actorId: text("actorId"),
    /** A drift approval's bound proposal. */
    proposalHash: text("proposalHash"),
    at: timestamp("at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("Decision_slot_idx").on(
      table.subject,
      table.channel,
      table.slot,
      table.at.desc(),
      table.id.desc(),
    ),
    index("Decision_other_idx").on(table.other),
    enumCheck("Decision_channel_check", table.channel, decisionChannel),
    enumCheck("Decision_kind_check", table.kind, decisionKind),
    enumCheck("Decision_actorKind_check", table.actorKind, decisionActorKind),
  ],
);

/** One producer result per `inputHash`; the raw response is capped at 256 KB. */
export const answer = pgTable(
  "Answer",
  {
    inputHash: text("inputHash").primaryKey(),
    feature: text("feature").notNull(),
    producer: text("producer").$type<AskProducer>().notNull(),
    promptVersion: text("promptVersion").notNull(),
    output: jsonb("output").$type<KernelJson>().notNull(),
    model: text("model"),
    tier: text("tier"),
    costMicros: bigint("costMicros", { mode: "number" }),
    raw: text("raw"),
    askId: uuid("askId"),
    claimToken: uuid("claimToken"),
    executor: text("executor"),
    runId: uuid("runId"),
    createdAt: createdAt(),
  },
  (table) => [
    index("Answer_feature_idx").on(table.feature, table.createdAt),
    enumCheck("Answer_producer_check", table.producer, askProducer),
    check(
      "Answer_raw_size_check",
      sql`${table.raw} IS NULL OR octet_length(${table.raw}) <= 262144`,
    ),
  ],
);

/** One owed producer call per `inputHash`. */
export const ask = pgTable(
  "Ask",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    inputHash: text("inputHash").notNull().unique("Ask_inputHash_unique"),
    feature: text("feature").notNull(),
    producer: text("producer").$type<AskProducer>().notNull(),
    promptVersion: text("promptVersion").notNull(),
    /** The canonical input envelope the hash covers. */
    input: jsonb("input").notNull(),
    state: text("state").$type<AskState>().notNull().default("queued"),
    ...claimColumns(),
    claimPartition: text("claimPartition"),
    executor: text("executor"),
    maxAttempts: integer("maxAttempts").notNull().default(3),
    cancelledAt: timestamp("cancelledAt", { mode: "date" }),
    sentAt: timestamp("sentAt", { mode: "date" }),
    answeredAt: timestamp("answeredAt", { mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("Ask_claim_idx").on(table.state, table.availableAt),
    index("Ask_sent_deadline_idx")
      .on(table.claimDeadline)
      .where(sql`${table.state} = ${sqlEnumConstant(askState, "sent")}`),
    enumCheck("Ask_state_check", table.state, askState),
    enumCheck("Ask_producer_check", table.producer, askProducer),
    check("Ask_waitCause_check", waitCauseCheck(table.waitCause)),
    check(
      "Ask_attempts_check",
      sql`${table.attempts} >= 0 AND ${table.maxAttempts} > 0`,
    ),
  ],
);

/** Which scopes, and which Run if any, wait on which ask. */
export const askScope = pgTable(
  "AskScope",
  {
    askId: uuid("askId")
      .notNull()
      .references((): AnyPgColumn => ask.id, {
        name: "AskScope_askId_Ask_id_fk",
        onDelete: "cascade",
      }),
    /** A Run waiting with no scope uses kind `run` keyed by the Run id. */
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    runId: uuid("runId"),
    receipt: jsonb("receipt").$type<KernelJson>(),
    sequence: integer("sequence"),
    cancelledAt: timestamp("cancelledAt", { mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "AskScope_pkey",
      columns: [table.askId, table.scopeKind, table.scopeKey],
    }),
    index("AskScope_scope_idx").on(table.scopeKind, table.scopeKey),
    index("AskScope_run_idx").on(table.runId),
  ],
);

/** The keys each evidence, answer, decision or readable row is read by. */
export const factKey = pgTable(
  "FactKey",
  {
    key: text("key").notNull(),
    factKind: text("factKind").notNull(),
    factId: text("factId").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "FactKey_pkey",
      columns: [table.key, table.factKind, table.factId],
    }),
    index("FactKey_fact_idx").on(table.factKind, table.factId),
  ],
);

/** One revision per key: the serialization point between mutation and dependency registration. */
export const keyRev = pgTable("KeyRev", {
  key: text("key").primaryKey(),
  rev: bigint("rev", { mode: "number" }).notNull().default(0),
});

/** One row per scope that must run. */
export const scopeDirty = pgTable(
  "ScopeDirty",
  {
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    lane: text("lane").$type<KernelLane>().notNull(),
    seq: bigint("seq", { mode: "number" }).notNull().default(1),
    reason: text("reason").notNull(),
    /** The `seq` this claim loaded at; the apply fence compares it. */
    claimedSeq: bigint("claimedSeq", { mode: "number" }),
    /** Consecutive `seq`/`rev` conflicts; three switch to a locked run. */
    conflicts: integer("conflicts").notNull().default(0),
    ...claimColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "ScopeDirty_pkey",
      columns: [table.scopeKind, table.scopeKey],
    }),
    index("ScopeDirty_claim_idx").on(
      table.lane,
      table.scopeKind,
      table.availableAt,
      table.seq,
    ),
    enumCheck("ScopeDirty_lane_check", table.lane, kernelLane),
    check("ScopeDirty_waitCause_check", waitCauseCheck(table.waitCause)),
  ],
);

/** The keys a scope read on its last run. */
export const scopeDep = pgTable(
  "ScopeDep",
  {
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    key: text("key").notNull(),
  },
  (table) => [
    primaryKey({
      name: "ScopeDep_pkey",
      columns: [table.scopeKind, table.scopeKey, table.key],
    }),
    index("ScopeDep_key_idx").on(table.key),
  ],
);

/** The last outcome per scope; `stage` and `nextActor` are list-projection caches. */
export const scopeState = pgTable(
  "ScopeState",
  {
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    version: integer("version").notNull(),
    /** The reconciler version and ask prompt versions this outcome was derived under. */
    rules: text("rules").notNull(),
    gaps: jsonb("gaps").$type<KernelGap[]>().notNull().default([]),
    /** The inputs the last run used, in use order. */
    inputs: jsonb("inputs").$type<ScopeInputRef[]>().notNull().default([]),
    stage: text("stage").$type<KernelStage>().notNull(),
    nextActor: text("nextActor"),
    /** The first gap's member-facing input, for list pages. */
    firstGap: text("firstGap"),
    inputsHash: text("inputsHash"),
    durationMs: integer("durationMs"),
    errorClass: text("errorClass"),
    error: text("error"),
    reconciledAt: timestamp("reconciledAt", { mode: "date" }),
    inputsChangedAt: timestamp("inputsChangedAt", { mode: "date" }),
    /** A scope whose record merged into another scope's: it is Ended and runs as that scope. */
    mergedIntoKey: text("mergedIntoKey"),
  },
  (table) => [
    primaryKey({
      name: "ScopeState_pkey",
      columns: [table.scopeKind, table.scopeKey],
    }),
    index("ScopeState_stage_idx").on(table.stage, table.nextActor),
    index("ScopeState_rules_idx").on(table.scopeKind, table.rules),
    enumCheck("ScopeState_stage_check", table.stage, kernelStage),
  ],
);

/**
 * `(scope, entity, naturalKey) → entityId`. A record's id never comes from its
 * contents; cutover records carry `legacy:<uuid>` keys.
 */
export const recordKey = pgTable(
  "RecordKey",
  {
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    entity: text("entity").notNull(),
    naturalKey: text("naturalKey").notNull(),
    entityId: uuid("entityId").notNull(),
    /** The kernel minted this id: Cubby created the record. */
    minted: boolean("minted").notNull().default(false),
    /** A `reject` decision: the record is not created again from its evidence. */
    rejectedAt: timestamp("rejectedAt", { mode: "date" }),
    /** The record merged into another scope's survivor; this scope no longer writes it. */
    mergedAt: timestamp("mergedAt", { mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "RecordKey_pkey",
      columns: [
        table.scopeKind,
        table.scopeKey,
        table.entity,
        table.naturalKey,
      ],
    }),
    index("RecordKey_entity_idx").on(table.entity, table.entityId),
  ],
);

/** Which evidence belongs to which purchase event, and on what basis. */
export const evidenceBinding = pgTable(
  "EvidenceBinding",
  {
    factKind: text("factKind").notNull(),
    factId: text("factId").notNull(),
    basis: text("basis").$type<BindingBasis>().notNull(),
    eventKey: text("eventKey").notNull(),
    /** The scope whose apply owns this row. */
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "EvidenceBinding_pkey",
      columns: [table.factKind, table.factId, table.basis],
    }),
    index("EvidenceBinding_event_idx").on(table.eventKey),
    index("EvidenceBinding_scope_idx").on(table.scopeKind, table.scopeKey),
    enumCheck("EvidenceBinding_basis_check", table.basis, bindingBasis),
  ],
);

/** One row per registered pass instance. */
export const kernelPass = pgTable(
  "Pass",
  {
    name: text("name").notNull(),
    key: text("key").notNull(),
    cursor: jsonb("cursor"),
    durationHistory: jsonb("durationHistory")
      .$type<{ ms: number; at: string }[]>()
      .notNull()
      .default([]),
    ...claimColumns(),
    wakeVersion: integer("wakeVersion").notNull().default(0),
    claimPartition: text("claimPartition"),
    maxAttempts: integer("maxAttempts").notNull().default(5),
    runId: uuid("runId"),
    doneAt: timestamp("doneAt", { mode: "date" }),
    cancelledAt: timestamp("cancelledAt", { mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ name: "Pass_pkey", columns: [table.name, table.key] }),
    index("Pass_claim_idx")
      .on(table.availableAt)
      .where(sql`${table.doneAt} IS NULL AND ${table.cancelledAt} IS NULL`),
    check("Pass_waitCause_check", waitCauseCheck(table.waitCause)),
  ],
);

/** One proposal per scope that a version change alone would alter. */
export const drift = pgTable(
  "Drift",
  {
    scopeKind: text("scopeKind").notNull(),
    scopeKey: text("scopeKey").notNull(),
    version: integer("version").notNull(),
    /** The rules the proposal was derived under; a newer deploy re-proposes. */
    rules: text("rules").notNull(),
    proposalHash: text("proposalHash").notNull(),
    inputsHash: text("inputsHash").notNull(),
    difference: jsonb("difference").notNull(),
    askCount: integer("askCount").notNull().default(0),
    estimatedCostMicros: bigint("estimatedCostMicros", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "Drift_pkey",
      columns: [table.scopeKind, table.scopeKey],
    }),
  ],
);
