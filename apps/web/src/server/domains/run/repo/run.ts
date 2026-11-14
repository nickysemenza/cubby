import { activityIconEntity } from "@cubby/schemas/activity";
import { runRawOut as rawRunOut } from "@cubby/schemas/entity-contracts/run";
import { parseShortcodeFor, runEntityId } from "@cubby/schemas/identifiers";
import {
  mailResearchRunInput,
  runDisplayStatus,
  runPurpose,
  sweepRunInput,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import {
  runWorkSamples,
  readRunWorkPhase,
} from "@cubby/schemas/run-work-progress";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  runRepositoryReadSchema,
  runSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.run.gen";
import { formatDuration } from "~/lib/format-duration";
import { aiChargedCostSql } from "~/server/ai/repo/ai-usage";
import type { Database } from "~/server/db";
import { readRunAiSummaries } from "~/server/db/computed/run-ai-summary";
import { runDisplayStatusSql } from "~/server/db/computed/run-display-status";
import {
  databaseForTransaction,
  isTransaction,
  notDeleted,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { email as emailTable, run as runTable } from "~/server/db/schema";
import { aiUsage } from "~/server/db/schema";
import {
  readRunRollups,
  runStalledSql,
  runNeedsAttentionSql,
} from "~/server/domains/run/repo/run-rollup";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { listReadValue } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import { runCostLabel } from "~/server/generic/list/repo/list-display-labels";
import {
  selectedListProjection,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { AGENT_RETRYABLE, runActionReasons } from "../run-control-rules";
import {
  runOpenItems,
  runOutcomeLine,
  runProgressMeter,
  runStateReason,
  runTitle,
  runWhatLine,
  runWhyLine,
  type RunPhraseContext,
} from "../run-phrases";
import {
  runPurposeLifecycle,
  UNRESOLVED_TARGET_STATES,
} from "./purpose-lifecycle";
import { listRunStepsForRuns } from "./run-step";
import {
  emptyMailRunOutcomeCounts,
  readMailRunOutcomeCounts,
} from "./run-target";
import { readRunStepWorkProgress, usesStepWorkProgress } from "./work-progress";

/**
 * The manifest read side of an import run. Writes stay in
 * `run/repo/run-control.ts`; this file only projects the row.
 */
// The display status the phrases read, selected beside any projection.
const DISPLAY_STATUS_INPUT = "displayStatusInput";
type RunRow = typeof runTable.$inferSelect & {
  readonly [DISPLAY_STATUS_INPUT]?: unknown;
};
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
            .select({ runId: aiUsage.runId, ...aiChargedCostSql() })
            .from(aiUsage)
            .where(
              and(
                inArray(
                  aiUsage.runId,
                  rows.map((row) => row.id),
                ),
              ),
            )
            .groupBy(aiUsage.runId)
        : [];
      return new Map(values.map((row) => [row.runId, row]));
    });
    const outcomes = bind.batch(async ({ db, rows }) =>
      readMailRunOutcomeCounts(
        db,
        rows.flatMap((row) =>
          row.purpose === runPurpose.enum.mail_import ? [row.id] : [],
        ),
      ),
    );
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
          rows.map((row) => row.id),
        ),
      ]);
      const successorOf = new Map<string, string>();
      // Newest first: the first successor seen for a Run is its latest retry.
      for (const entry of successors)
        if (entry.predecessorRunId && !successorOf.has(entry.predecessorRunId))
          successorOf.set(entry.predecessorRunId, entry.shortcode);
      // Retry carries only unresolved targets; a row offers it only when
      // there are some, so the action is disabled rather than refused.
      const unresolvedOf = new Map<string, number>();
      await Promise.all(
        rows
          .filter(
            (row) =>
              AGENT_RETRYABLE.has(row.status) && !successorOf.has(row.id),
          )
          .map(async (row) => {
            const lifecycle = await runPurposeLifecycle(row.purpose);
            if (!lifecycle) return;
            const targets = await lifecycle.targets(
              unwrapDb(db),
              runEntityId.parse(row.id),
            );
            unresolvedOf.set(
              row.id,
              targets.filter((target) =>
                UNRESOLVED_TARGET_STATES.has(target.state),
              ).length,
            );
          }),
      );
      return {
        successorOf,
        unresolvedOf,
        rollupOf: new Map(rollups.map((rollup) => [rollup.runId, rollup])),
      };
    });
    // Linked records and Email subjects the phrases name: one query each.
    const links = bind.batch(async ({ db, rows }) => {
      const subjectIds = new Map<string, string[]>();
      for (const row of rows) {
        const sources = mailResearchRunInput.safeParse(row.input).data?.sources;
        if (sources)
          subjectIds.set(
            row.id,
            sources.map((source) => source.orderMailId),
          );
      }
      const importIds = rows.flatMap((row) => {
        const families = sweepRunInput.safeParse(row.input).data?.families;
        const statement = families?.find(
          (entry) => entry.family === "statement_transaction",
        );
        const importId =
          statement?.family === "statement_transaction" &&
          typeof statement.scope.importId === "string"
            ? statement.scope.importId
            : undefined;
        return importId ? [importId] : [];
      });
      const orderMailIds = [...new Set([...subjectIds.values()].flat())];
      const [runs, imports, subjects] = await Promise.all([
        lookupEntityReferences(
          db,
          "run",
          rows.flatMap((row) => [row.parentRunId, row.predecessorRunId]),
          { includeDeleted: true },
        ),
        lookupEntityReferences(db, "transactionImport", importIds, {
          includeDeleted: true,
        }),
        orderMailIds.length
          ? unwrapDb(db)
              .select({
                orderMailId: emailTable.orderMailId,
                subject: emailTable.subject,
              })
              .from(emailTable)
              .where(
                and(
                  inArray(emailTable.orderMailId, orderMailIds),
                  isNull(emailTable.deletedAt),
                ),
              )
          : Promise.resolve([]),
      ]);
      const subjectOf = new Map(
        subjects.flatMap((entry) =>
          entry.orderMailId && entry.subject?.trim()
            ? [[entry.orderMailId, entry.subject.trim()] as const]
            : [],
        ),
      );
      return {
        runs,
        importCodeOf: new Map(
          [...imports].map(([id, entry]) => [id, String(entry.id)]),
        ),
        subjectsOf: new Map(
          [...subjectIds].map(([runId, ids]) => [
            runId,
            ids.flatMap((id) => {
              const subject = subjectOf.get(id);
              return subject ? [subject] : [];
            }),
          ]),
        ),
      };
    });
    const phrases = bind.batch(async (page) => {
      const [actor, outcome, step, line, link] = await Promise.all([
        actors.load(page),
        outcomes.load(page),
        steps.load(page),
        lineage.load(page),
        links.load(page),
      ]);
      return { actor, outcome, step, line, link };
    });
    const summaries = bind.batch(async ({ db, rows }) =>
      readRunAiSummaries(db, rows),
    );
    const phraseContext = (
      row: RunRow,
      loaded: Awaited<ReturnType<typeof phrases.load>>,
      viewerUserId: string | null,
    ): RunPhraseContext => {
      const { actor, outcome, step, line, link } = loaded;
      const successor = line.successorOf.get(row.id) ?? null;
      const rollup = line.rollupOf.get(parseShortcodeFor("run", row.shortcode));
      const linked = (id: string | null) => {
        const found = id ? link.runs.get(id) : undefined;
        return found
          ? { entity: "run", code: found.id, label: found.name }
          : null;
      };
      const importId = sweepRunInput
        .safeParse(row.input)
        .data?.families.flatMap((entry) =>
          entry.family === "statement_transaction" &&
          typeof entry.scope.importId === "string" &&
          entry.scope.importId
            ? [entry.scope.importId]
            : [],
        )[0];
      const importCode = importId ? link.importCodeOf.get(importId) : undefined;
      return {
        viewerUserId,
        vendorName: row.vendorId
          ? (actor.vendors.get(row.vendorId)?.name ?? null)
          : null,
        partyName: row.ledgerPartyId
          ? (actor.parties.get(row.ledgerPartyId)?.name ?? null)
          : null,
        parent: linked(row.parentRunId),
        predecessor: linked(row.predecessorRunId),
        importRecord: importCode
          ? { entity: "transactionImport", code: importCode, label: null }
          : null,
        emailSubjects: link.subjectsOf.get(row.id) ?? [],
        successorCode: successor,
        displayStatus: runDisplayStatus.parse(row[DISPLAY_STATUS_INPUT]),
        stalled: rollup?.stalled ?? false,
        outcomeCounts:
          row.purpose === runPurpose.enum.mail_import
            ? (outcome.get(row.id) ?? emptyMailRunOutcomeCounts())
            : null,
        workProgress: runWorkProgressOf(row, step.byRun, step.now),
        wallTime: runWallTime(row),
      };
    };
    return [
      phrases.fields(
        rawRunOut.pick({
          displayName: true,
          whyLine: true,
          outcomeLine: true,
          stateReason: true,
          progressMeter: true,
        }),
        (row, loaded, { context }) => {
          const phrase = phraseContext(
            row,
            loaded,
            context.actor?.userId ?? null,
          );
          return {
            displayName: runTitle(row, phrase),
            whyLine: runWhyLine(row, phrase),
            outcomeLine: runOutcomeLine(row, phrase),
            stateReason: runStateReason(row, phrase),
            progressMeter: runProgressMeter(row, phrase),
          };
        },
      ),
      phrases.fields(
        rawRunOut.pick({ whatLine: true, openItems: true }),
        (row, loaded, { context }) => {
          const phrase = phraseContext(
            row,
            loaded,
            context.actor?.userId ?? null,
          );
          return {
            whatLine: runWhatLine(row, phrase),
            openItems: runOpenItems(row, phrase),
          };
        },
        { scope: "detail" },
      ),
      summaries.fields(
        rawRunOut.pick({ aiSummary: true }),
        (row, loaded) => ({ aiSummary: loaded.get(row.id) ?? null }),
        { scope: "detail" },
      ),
      costs.fields(
        rawRunOut.pick({
          chargedCost: true,
          chargedUnpricedCount: true,
          chargedCostLabel: true,
        }),
        (row, loaded) => {
          const chargedCost = loaded.get(row.id)?.chargedCost ?? 0;
          const chargedUnpricedCount =
            loaded.get(row.id)?.chargedUnpricedCount ?? 0;
          return {
            chargedCost,
            chargedUnpricedCount,
            chargedCostLabel: runCostLabel(chargedCost, chargedUnpricedCount),
          };
        },
      ),
      outcomes.fields(
        rawRunOut.pick({ outcomeCounts: true }),
        (row, loaded) => ({
          outcomeCounts:
            row.purpose === runPurpose.enum.mail_import
              ? (loaded.get(row.id) ?? emptyMailRunOutcomeCounts())
              : null,
        }),
      ),
      lineage.fields(
        rawRunOut.pick({
          successorRunId: true,
          waitingOn: true,
          stalled: true,
          actionReasons: true,
        }),
        (row, { successorOf, unresolvedOf, rollupOf }) => {
          const successor = successorOf.get(row.id) ?? null;
          const rollup = rollupOf.get(parseShortcodeFor("run", row.shortcode));
          return {
            successorRunId: successor
              ? parseShortcodeFor("run", successor)
              : null,
            waitingOn: rollup?.waitingOn ?? null,
            stalled: rollup?.stalled ?? false,
            actionReasons: runActionReasons({
              ...row,
              hasSuccessor: successor !== null,
              unresolvedTargets: unresolvedOf.get(row.id),
            }),
          };
        },
      ),
      actors.fields(
        rawRunOut.pick({ iconEntity: true }),
        (row, { vendors, parties }) => {
          const vendor = row.vendorId ? vendors.get(row.vendorId) : undefined;
          const party = row.ledgerPartyId
            ? parties.get(row.ledgerPartyId)
            : undefined;
          return {
            iconEntity: activityIconEntity({
              kind: runPurpose.parse(row.purpose),
              subjectId: vendor?.id ?? null,
              ledgerPartyId: party?.id ?? null,
            }),
          };
        },
      ),
      bind(rawRunOut.pick({ wallTime: true }), (row) => ({
        wallTime: runWallTime(row),
      })),
      steps.fields(
        rawRunOut.pick({ workProgress: true, activityAt: true }),
        (row, { byRun, now }) => {
          const runSteps = byRun.get(row.id) ?? [];
          const workProgress = runWorkProgressOf(row, byRun, now);
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

const runWallTime = (row: Pick<RunRow, "startedAt" | "endedAt">) =>
  row.endedAt
    ? formatDuration(
        Math.max(0, row.endedAt.getTime() - row.startedAt.getTime()),
      )
    : "In progress";

/** The step ledger's phases, else the live work samples, else none. */
function runWorkProgressOf(
  row: RunRow,
  byRun: ReadonlyMap<string, Awaited<ReturnType<typeof listRunStepsForRuns>>>,
  now: Date,
) {
  const runSteps = byRun.get(row.id) ?? [];
  const samples = runWorkSamples.safeParse(row.liveProgress?.work).data;
  return (
    readRunStepWorkProgress(runSteps, row.status, row.startedAt, now) ??
    (samples
      ? {
          current: readRunWorkPhase(samples.current, row.status, now),
          completed: samples.completed.map((sample) =>
            readRunWorkPhase(sample, "completed", now),
          ),
        }
      : null)
  );
}

const runPurposeSelection = z
  .object({
    purpose: z.unknown().optional(),
    ids: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Automatic work nobody opens: old grouping Runs always, routine passes once they ended,
 * and mail discovery once it completed, since its failures need a member.
 */
const runOpenedPopulationSql = () =>
  sql`${notInArray(runTable.purpose, ["ai_suggest", "background"])} AND (
    ${notInArray(runTable.purpose, ["ai_refresh", "connection_discovery", "derived_refresh"])}
    OR ${inArray(runTable.status, ["running", "paused", "paused_auth"])}
  ) AND (
    ${runTable.purpose} <> ${"mail_discovery"}
    OR ${runTable.status} <> ${"completed"}
  )`;

/**
 * The Runs a fresh Runs list shows: the opened population under the list's
 * `initialFilter` (no ephemeral grouping Runs, no routine kinds or passes),
 * without its phase bound, which only hides Runs finished before the
 * Recently finished window. The AI summary admission covers exactly these.
 */
export const runDefaultPopulationSql = () =>
  sql`${runOpenedPopulationSql()} AND ${runTable.trigger} <> ${"ephemeral"}
    AND ${inArray(runTable.purpose, [...VISIBLE_RUN_PURPOSES])}
    AND ${eq(runTable.routine, false)}`;

export const runScaffold = listScaffold("run", runTable, {
  readSchema: runRepositoryReadSchema,
  // An explicit purpose or identity filter keeps hidden history directly accessible.
  population: (filters) => {
    const { purpose, ids } = runPurposeSelection.parse(filters);
    return purpose === undefined && ids === undefined
      ? runOpenedPopulationSql()
      : sql`true`;
  },
  derived: {
    stalled: listReadValue(() => runStalledSql()),
    needsAttention: listReadValue(() => runNeedsAttentionSql()),
    displayStatus: listReadValue(() => runDisplayStatusSql()),
  },
  read: {
    ...runRead,
    title: sql`${runTable.purpose}`,
    // Keys outside the read schema are helper columns the bindings read.
    columns: { [DISPLAY_STATUS_INPUT]: () => runDisplayStatusSql() },
  },
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
      selectedListProjection(
        runRepositoryReadSchema,
        Object.keys(schema.shape),
      ),
    )
  ).data;
  return row === undefined ? undefined : schema.parse(row);
}

/** Declared `lifecycle: "readOnly"`: the run service and importers own writes. */
export const runRepository = defineRepository("run", {
  schemas: runSchemaBindings,
  scaffold: runScaffold,
});

/** One transaction for a Run's work step; services compose repo writes inside it. */
export async function withRunTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
}
