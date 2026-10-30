import type { DataCheck, DataQuality } from "@cubby/schemas/data-quality";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type {
  WorkAction,
  WorkExecutor,
  WorkFamily,
  WorkLink,
} from "@cubby/schemas/work-queue";
import { SQL, sql, type SQLWrapper } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";

/**
 * What one read admits. Sources apply it inside their own WHERE, so counts
 * and pages see only admitted rows and a record read never plans the whole
 * queue.
 */
export interface WorkScope {
  /** The record a detail strip reads; a source with another entity skips. */
  readonly record?: {
    readonly entity: ShortcodeEntity;
    readonly id: string;
    /** Fresh verdicts for this single-record read; never a publication. */
    readonly quality?: DataQuality;
  };
  /** Requested reason keys (any-of); a source keeps only these. */
  readonly reasons?: readonly string[];
  readonly reasonExclude?: readonly string[];
}

export interface WorkReason {
  readonly key: string;
  readonly label: string;
  /** The data check a gap reason stands for, when it is one. */
  readonly check?: DataCheck;
}

/** A shared CTE a source's candidates read, deduplicated by name. */
export interface WorkCte {
  readonly name: string;
  readonly sql: SQL;
}

/** One source's candidates: its Drizzle select plus any CTEs it reads. */
export interface WorkCandidates {
  readonly query: SQLWrapper;
  readonly ctes?: readonly WorkCte[];
}

/**
 * A domain's contribution to the Work queue. Domains export these and the
 * composer passes them in; the queue owns admission, the union, filters,
 * search, sorts, Group by, saved views, counts, paging and hydration.
 */
export interface WorkSource {
  /** Unique across composed sources; rows carry it as `source`. */
  readonly id: string;
  readonly family: WorkFamily;
  /** Every reason key this source can emit, with its filter label. */
  readonly reasons: readonly WorkReason[];
  /** Static when every row has one; `dynamic` when the select decides. */
  readonly executor: WorkExecutor | "dynamic";
  /** The record type of every row, or null when rows vary or have none. */
  readonly entity: ShortcodeEntity | null;
  readonly link: WorkLink;
  readonly actions?: readonly WorkAction[];
  /** Admits gap reasons only; a reason filter of data checks keeps it. */
  readonly carriesGaps?: boolean;
  readonly candidates: (
    db: Database,
    scope: WorkScope,
  ) => Promise<WorkCandidates | null>;
}

/** The value of one candidate column: a literal or an expression. */
type Value = string | number | boolean | null | SQL;

const literal = (value: Value, cast: string): SQL =>
  value instanceof SQL
    ? sql`(${value})${sql.raw(cast)}`
    : sql`${value}${sql.raw(cast)}`;

export interface WorkCandidateColumns {
  readonly entity: ShortcodeEntity | SQL | null;
  readonly id: SQL | null;
  readonly name: SQL;
  /** Unique per row within the source; defaults to `<source>:<id>`. */
  readonly key?: Value;
  readonly reason: Value;
  readonly reasonKeys: readonly string[] | SQL;
  readonly executor?: WorkExecutor | SQL;
  /** LedgerParty ids that can act; ignored when `shared`. */
  readonly owners: SQL;
  /** Current necessary owner: resolved `owners` must contain only this member.
   * Joint authorities omit it. This narrows reads, never grants access. */
  readonly exclusiveOwner?: SQL;
  readonly shared?: boolean | SQL;
  readonly amount?: SQL;
  readonly date?: SQL;
}

/**
 * The shared row shape every source's select projects, so the queue can
 * union them. Columns are typed and named once here.
 */
const workCandidateColumns = (
  source: Pick<WorkSource, "id" | "family" | "executor">,
  columns: WorkCandidateColumns,
) => {
  const executor =
    columns.executor ??
    (source.executor === "dynamic" ? null : source.executor);
  if (executor === null)
    throw new Error(
      `Work source ${source.id} has a dynamic executor but no column`,
    );
  const id = columns.id === null ? sql`NULL` : columns.id;
  return {
    source: sql<string>`${source.id}::text`.as("source"),
    entity: sql<string | null>`${literal(columns.entity, "::text")}`.as(
      "entity",
    ),
    id: sql<string | null>`(${id})::text`.as("id"),
    name: sql<string>`coalesce((${columns.name})::text, '')`.as("name"),
    key: sql<string>`${
      columns.key === undefined
        ? sql`${source.id + ":"}::text || coalesce((${id})::text, '')`
        : literal(columns.key, "::text")
    }`.as("key"),
    family: sql<string>`${source.family}::text`.as("family"),
    executor: sql<string>`${literal(executor, "::text")}`.as("executor"),
    reason: sql<string>`${literal(columns.reason, "::text")}`.as("reason"),
    reasonKeys: sql<string[]>`${
      columns.reasonKeys instanceof SQL
        ? sql`(${columns.reasonKeys})::text[]`
        : sql`ARRAY[${sql.join(
            columns.reasonKeys.map((key) => sql`${key}`),
            sql`, `,
          )}]::text[]`
    }`.as("reason_keys"),
    owners: sql<string[]>`(${columns.owners})::uuid[]`.as("owners"),
    exclusive_owner: sql<
      string | null
    >`${columns.exclusiveOwner ?? sql`NULL`}::uuid`.as("exclusive_owner"),
    shared: sql<boolean>`${literal(columns.shared ?? false, "::boolean")}`.as(
      "shared",
    ),
    amount: sql<
      number | null
    >`${columns.amount ?? sql`NULL`}::double precision`.as("amount"),
    date: sql<string | null>`${columns.date ?? sql`NULL`}::date`.as("date"),
  };
};

/** `select … from` over the shared row shape. */
export const selectWorkCandidates = (
  db: Database,
  source: Pick<WorkSource, "id" | "family" | "executor">,
  columns: WorkCandidateColumns,
) => getDb(db).select(workCandidateColumns(source, columns));

/** A typed, empty relation for a scope that admits no source. */
export const emptyWorkCandidates = (db: Database) =>
  selectWorkCandidates(
    db,
    { id: "none", family: "problem", executor: "human" },
    {
      entity: null,
      id: null,
      name: sql`NULL`,
      reason: null,
      reasonKeys: [],
      owners: sql`ARRAY[]::uuid[]`,
    },
  )
    .from(sql`(SELECT 1) none`)
    .where(sql`false`);

/** Whether a scope's reason filters leave any of a source's reasons. */
export const scopeAdmitsReasons = (
  scope: WorkScope,
  reasons: readonly WorkReason[],
): boolean => {
  const exclude = new Set(scope.reasonExclude ?? []);
  const include = scope.reasons ? new Set(scope.reasons) : undefined;
  return reasons.some(
    (reason) =>
      !exclude.has(reason.key) &&
      (include === undefined || include.has(reason.key)),
  );
};

/** The reasons of a source a scope still admits. */
export const admittedReasons = (
  scope: WorkScope,
  reasons: readonly WorkReason[],
): WorkReason[] =>
  reasons.filter(
    (reason) =>
      !(scope.reasonExclude ?? []).includes(reason.key) &&
      (scope.reasons === undefined || scope.reasons.includes(reason.key)),
  );
