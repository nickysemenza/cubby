import type { RunId } from "@cubby/schemas/identifiers";
import {
  jobState,
  jobWaitReason,
  type JobExecution,
  type JobPayload,
  type JobState,
  type JobWaitReason,
} from "@cubby/schemas/job";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { run } from "./generated/entity-table-definitions.gen";
import { sqlEnumConstant } from "./sql-enum";

/**
 * Durable background work with no natural owner row. It is not an entity: it has no
 * public code or identity, and nothing links to it.
 */
export const job = pgTable(
  "Job",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    state: text("state").$type<JobState>().notNull().default("queued"),
    runId: uuid("runId")
      .$type<RunId>()
      .references((): AnyPgColumn => run.id, {
        name: "Job_runId_Run_id_fk",
        onDelete: "set null",
      }),
    waitReason: text("waitReason").$type<JobWaitReason>(),
    input: jsonb("input").$type<JobPayload>().notNull(),
    cursor: jsonb("cursor").$type<JobPayload>(),
    generation: integer("generation").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").default(3),
    availableAt: timestamp("availableAt", { mode: "date" })
      .notNull()
      .default(sql`now()`),
    leaseToken: uuid("leaseToken"),
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date" }),
    lastClaimedAt: timestamp("lastClaimedAt", { mode: "date" }),
    error: text("error"),
    /** First failure of the current failing streak; cleared by any successful or deferred page. */
    failingSince: timestamp("failingSince", { mode: "date" }),
    /** The latest execution of this Job or drain unit (`jobExecution`). */
    lastExecution: jsonb("lastExecution").$type<JobExecution>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("Job_key_unique").on(table.key),
    index("Job_due_idx").on(table.state, table.availableAt, table.priority),
    index("Job_run_idx").on(table.runId),
    index("Job_kind_claimed_idx").on(table.kind, table.lastClaimedAt),
    index("Job_kind_state_idx").on(table.kind, table.state, table.availableAt),
    check(
      "Job_state_check",
      sql.raw(
        `"state" IN (${jobState.options.map((value) => `'${value}'`).join(", ")})`,
      ),
    ),
    check(
      "Job_kind_retired_check",
      sql`${table.kind} NOT IN ('image.cloud', 'image.device', 'image.device.wake', 'embedding.refresh', 'embedding.cleanup', 'ai.evaluation', 'assessment.correction', 'ai-refresh.activate', 'derived.drain', 'derived.reconcile', 'jobs.maintenance', 'discovery.connections')`,
    ),
    check(
      "Job_waitReason_check",
      sql`${table.waitReason} IN (${sql.join(
        jobWaitReason.options.map((value) =>
          sqlEnumConstant(jobWaitReason, value),
        ),
        sql`, `,
      )})`,
    ),
    check(
      "Job_attempts_check",
      sql`${table.attempts} >= 0 AND coalesce(${table.maxAttempts}, 1) > 0`,
    ),
  ],
);
