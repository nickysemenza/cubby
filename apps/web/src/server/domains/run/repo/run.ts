import { activityIconEntity } from "@cubby/schemas/activity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { describeJobRollup } from "@cubby/schemas/job";
import { runPurpose, runStatus, runWorkLabel } from "@cubby/schemas/run-fields";
import { rawRunOut } from "@cubby/schemas/run-raw-read";
import {
  runWorkSamples,
  readRunWorkPhase,
} from "@cubby/schemas/run-work-progress";
import { and, desc, inArray, sql } from "drizzle-orm";

import { formatDuration } from "~/lib/format-duration";
import { aiCostSummarySql } from "~/server/ai/repo/ai-usage";
import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  notDeleted,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { aiUsage } from "~/server/db/schema";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import {
  readRunRollups,
  runStalledSql,
  runNeedsAttentionSql,
} from "~/server/generic/jobs/repo/job-queue";
import { listReadValue } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  selectedListProjection,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

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
    },
    ledgerPartyId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    predecessorRunId: { kind: "lookup", missing: "null", includeDeleted: true },
    parentRunId: { kind: "lookup", missing: "null", includeDeleted: true },
  },
  bindings: (bind) => {
    const actors = bind.batch(async ({ db, rows }) => {
      const [vendors, parties] = await Promise.all([
        lookupEntityReferences(
          db,
          "vendor",
          rows.map((row) => row.vendorId),
          {
            includeDeleted: true,
          },
        ),
        lookupEntityReferences(
          db,
          "ledgerParty",
          rows.map((row) => row.ledgerPartyId),
          { includeDeleted: true },
        ),
      ]);
      return { vendors, parties };
    });
    const costs = bind.batch(async ({ db, rows }) => {
      const values = rows.length
        ? await unwrapDb(db)
            .select({ runId: aiUsage.runId, ...aiCostSummarySql() })
            .from(aiUsage)
            .where(
              and(
                inArray(
                  aiUsage.runId,
                  rows.map((row) => row.id),
                ),
                notDeleted(aiUsage),
              ),
            )
            .groupBy(aiUsage.runId)
        : [];
      return new Map(values.map((row) => [row.runId, row.chargedCost]));
    });
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
      costs.fields(rawRunOut.pick({ chargedCost: true }), (row, loaded) => ({
        chargedCost: loaded.get(row.id) ?? 0,
      })),
      lineage.fields(
        rawRunOut.pick({
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
      actors.fields(
        rawRunOut.pick({ displayName: true, iconEntity: true }),
        (row, { vendors, parties }) => {
          const vendor = row.vendorId ? vendors.get(row.vendorId) : undefined;
          const party = row.ledgerPartyId
            ? parties.get(row.ledgerPartyId)
            : undefined;
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
      bind(rawRunOut.pick({ wallTime: true }), (row) => ({
        wallTime: row.endedAt
          ? formatDuration(
              Math.max(0, row.endedAt.getTime() - row.startedAt.getTime()),
            )
          : "In progress",
      })),
      steps.fields(
        rawRunOut.pick({ workProgress: true, activityAt: true }),
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
export const runScaffold = listScaffold("run", runTable, {
  derived: {
    stalled: listReadValue(() => runStalledSql()),
    needsAttention: listReadValue(() => runNeedsAttentionSql()),
  },
  read: { ...runRead, title: sql`${runTable.purpose}` },
});

const reader = createEntityReader({
  entity: "run",
  scaffold: runScaffold,
  output: rawRunOut,
});

/** One live Run by public code, or null. */
export const readRun = reader.getByShortcode;
/** One live Run by internal id; throws when absent. */
export const readRunById = reader.getByID;

/** Import status needs the shared projection, without unrelated entity-quality hydration. */
export async function getRunHeaderByShortcode(db: Database, shortcode: string) {
  const schema = rawRunOut.omit({ dataQuality: true });
  const [row] = (
    await runScaffold.get(
      db,
      [shortcode],
      selectedListProjection("run", Object.keys(schema.shape)),
    )
  ).data;
  return row === undefined ? undefined : schema.parse(row);
}

/** Declared `lifecycle: "readOnly"`: the run service and importers own writes. */
export const runRepository = defineRepository("run", {
  scaffold: runScaffold,
});

/** One transaction for a Run's work step; services compose repo writes inside it. */
export async function withRunTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
}
