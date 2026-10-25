import { activityIconEntity } from "@cubby/schemas/activity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { describeJobRollup } from "@cubby/schemas/job";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { RunFilters, RunOut } from "@cubby/schemas/run";
import { runOut } from "@cubby/schemas/run";
import { runPurpose, runStatus, runWorkLabel } from "@cubby/schemas/run-fields";
import {
  runWorkSamples,
  readRunWorkPhase,
} from "@cubby/schemas/run-work-progress";
import { and, desc, eq, inArray } from "drizzle-orm";

import { formatDuration } from "~/lib/format-duration";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  notDeleted,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { run as runTable } from "~/server/db/schema";
import {
  defineRepository,
  listOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import {
  createEntityReader,
  createEntityRowFetcher,
  listReadOn,
} from "~/server/entity-kernel/repo/repository";
import { readRunRollups } from "~/server/generic/jobs/repo/job-queue";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  selectedListProjection,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";

import { listRunStepsForRuns } from "./run-step";
import { readRunStepWorkProgress, usesStepWorkProgress } from "./work-progress";

/**
 * The manifest read side of an import run. Writes stay in
 * `purchase-import/run-service.ts`; this file only projects the row.
 */
type RunRow = typeof runTable.$inferSelect;
// includes-deleted: immutable Run history retains account, actor and lineage identities.
const runRead = {
  media: true,
  references: {
    vendorAccountId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    vendorId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
      consumers: ["displayName", "iconEntity"],
    },
    ledgerPartyId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
      consumers: ["displayName", "iconEntity"],
    },
    predecessorRunId: { kind: "lookup", missing: "null", includeDeleted: true },
    parentRunId: { kind: "lookup", missing: "null", includeDeleted: true },
  },
  bindings: (bind) => {
    const steps = bind.batch(async ({ db, rows }) => {
      const loaded = await listRunStepsForRuns(
        db,
        rows
          .filter((row) => usesStepWorkProgress(runPurpose.parse(row.purpose)))
          .map((row) => row.id),
      );
      const byRun = new Map<string, typeof loaded>();
      for (const step of loaded) {
        const group = byRun.get(step.runId) ?? [];
        group.push(step);
        byRun.set(step.runId, group);
      }
      return { byRun, now: new Date() };
    });
    const lineage = bind.batch(async ({ db, rows }) => {
      const ids = rows.map((row) => row.id);
      const [successors, rollups] = await Promise.all([
        ids.length
          ? unwrapDb(db)
              .select({
                predecessorRunId: runTable.predecessorRunId,
                shortcode: runTable.shortcode,
              })
              .from(runTable)
              .where(
                and(
                  inArray(runTable.predecessorRunId, ids),
                  notDeleted(runTable),
                ),
              )
              .orderBy(desc(runTable.startedAt))
          : Promise.resolve([]),
        readRunRollups(
          isTransaction(db) ? databaseForTransaction(db) : db,
          rows,
        ),
      ]);
      const successorOf = new Map<string, string>();
      // Newest first: the first successor seen for a Run is its latest retry.
      for (const entry of successors)
        if (entry.predecessorRunId && !successorOf.has(entry.predecessorRunId))
          successorOf.set(entry.predecessorRunId, entry.shortcode);
      return {
        successorOf,
        rollupOf: new Map(rollups.map((rollup) => [rollup.runId, rollup])),
      };
    });
    return [
      lineage.fields(
        runOut.pick({
          successorRunId: true,
          waitingOn: true,
          stalled: true,
          displayStatus: true,
        }),
        (row, { successorOf, rollupOf }) => {
          const successor = successorOf.get(row.id) ?? null;
          const rollup = rollupOf.get(parseShortcodeFor("run", row.shortcode));
          return {
            successorRunId: successor
              ? parseShortcodeFor("run", successor)
              : null,
            waitingOn: rollup
              ? describeJobRollup(rollup.counts, rollup.expiredLeases)
              : null,
            stalled: rollup?.stalled ?? false,
            displayStatus: runDisplayStatusOf(row, successor !== null),
          };
        },
      ),
      bind(
        runOut.pick({ displayName: true, iconEntity: true }),
        (row, { references }) => {
          const vendor = references.get("vendorId");
          const party = references.get("ledgerPartyId");
          return {
            displayName: `${vendor?.name ?? party?.name ?? row.actorName} · ${runWorkLabel(row)}`,
            iconEntity: activityIconEntity({
              kind: runPurpose.parse(row.purpose),
              subjectId: vendor?.id ?? null,
              ledgerPartyId: party?.id ?? null,
            }),
          };
        },
      ),
      bind(runOut.pick({ wallTime: true }), (row) => ({
        wallTime: row.endedAt
          ? formatDuration(
              Math.max(0, row.endedAt.getTime() - row.startedAt.getTime()),
            )
          : "In progress",
      })),
      steps.fields(
        runOut.pick({ workProgress: true, activityAt: true }),
        (row, { byRun, now }) => {
          const runSteps = byRun.get(row.id) ?? [];
          const samples = runWorkSamples.safeParse(row.liveProgress?.work).data;
          const workProgress =
            readRunStepWorkProgress(runSteps, row.status, row.startedAt, now) ??
            (samples
              ? {
                  current: readRunWorkPhase(samples.current, row.status, now),
                  completed: samples.completed.map((sample) =>
                    readRunWorkPhase(sample, "completed", now),
                  ),
                }
              : null);
          const activityAt =
            [
              row.heartbeatAt?.toISOString(),
              row.liveProgress?.createdAt,
              ...runSteps.map((step) => step.updatedAt.toISOString()),
            ]
              .filter((value) => value !== undefined)
              .sort((a, b) => Date.parse(a) - Date.parse(b))
              .at(-1) ?? null;
          return { workProgress, activityAt };
        },
      ),
    ];
  },
} satisfies ListReadOptions<RunRow>;

/**
 * What a Run reads as. A review stop or failure whose open work a retry
 * successor carried reads `retried` (the successor holds that work; member
 * findings stay on this Run's own sections), and a stop by the AI funding
 * window reads as waiting for funding rather than review or authorization.
 */
function runDisplayStatusOf(
  row: Pick<RunRow, "status" | "failureCode">,
  hasSuccessor: boolean,
) {
  const status = runStatus.parse(row.status);
  if (
    row.failureCode === "execution_limit" &&
    (status === "needs_review" || status === "paused_auth")
  )
    return "waiting_for_funding" as const;
  if (hasSuccessor && (status === "needs_review" || status === "failed"))
    return "retried" as const;
  return status;
}
const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: RunRow[],
): Promise<RunOut[]> =>
  (
    await listReadPlan<RunRow>("run", runRead).read(db, rows, { kind: "full" })
  ).map((row) => runOut.parse(row));

const scaffold = listScaffold("run", runTable);

export const listRunsRead = (
  db: Database,
  filters: RunFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    { read: runRead },
  );
export const listRuns = completeListReader(runOut, listRunsRead);

const reader = createEntityReader<
  RunRow,
  RunOut,
  "run",
  Database | DrizzleTransaction
>({
  entity: "run",
  fetchById: createEntityRowFetcher(runTable),
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getRunByShortcode = reader.getByShortcode;
export const getRunByID = reader.getByID;

/** Import status needs the shared projection, without unrelated entity-quality hydration. */
export async function getRunHeaderByShortcode(db: Database, shortcode: string) {
  const [row] = await unwrapDb(db)
    .select()
    .from(runTable)
    .where(
      and(
        eq(runTable.shortcode, parseShortcodeFor("run", shortcode)),
        notDeleted(runTable),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  const schema = runOut.omit({ dataQuality: true });
  return schema.parse(
    (
      await listReadPlan<RunRow>("run", runRead).read(
        db,
        [row],
        selectedListProjection("run", Object.keys(schema.shape)),
      )
    )[0],
  );
}

/** Declared `lifecycle: "readOnly"`: the run service and importers own writes. */
export const runRepository = defineRepository("run", {
  get: onDb(getRunByShortcode),
  list: listOn(listRuns),
  listRead: listReadOn(listRunsRead),
});

/** One transaction for a Run's work step; services compose repo writes inside it. */
export async function withRunTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
}
