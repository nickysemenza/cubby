import { aiUsageStatus } from "@cubby/schemas/ai";
import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { runShortcode } from "@cubby/schemas/identifiers";
import { runTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import {
  runTargetState,
  RUN_TARGET_BUCKET,
  importOperationStatusOut,
} from "@cubby/schemas/purchase-import";
import {
  runPurpose,
  RUN_PURPOSE_LABEL,
  type RunPurpose,
} from "@cubby/schemas/run-fields";
import {
  mailDiscoveryRunProgress,
  suggestionSweepRunProgress,
  runStatus,
  productResearchRunInput,
  purchaseValidationResearchRunInput,
  mailReclassifyRunInput,
} from "@cubby/schemas/run-fields";
import {
  runWorkSamples,
  type RunWorkItems,
  type RunWorkSample,
  type RunWorkSamples,
  type RunWorkProgress,
  type RunWorkPhase,
} from "@cubby/schemas/run-work-progress";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { run } from "~/server/db/schema";
import type { readRunProgressTargets } from "~/server/domains/purchase-import/repo/run-service";

import { listRunSteps, isTerminalStep } from "./run-step";

/** Samples are absolute, so child re-reads and Workflow handoffs never add counts twice. */
export function sampleRunWork(
  previous: RunWorkSamples | undefined,
  items: RunWorkItems,
  input: {
    startedAt: Date;
    sampledAt: Date;
    finished: boolean;
    reset?: boolean;
    baselineProcessed?: number;
  },
): RunWorkSamples {
  const compatible = (sample: RunWorkSample) =>
    sample.phase === items.phase && sample.unit === items.unit;
  const same = previous && compatible(previous.current);
  const prior = same
    ? previous.current
    : [...(previous?.completed ?? [])].reverse().find(compatible);
  const baseline =
    same && !input.reset && items.processed >= previous.current.processed
      ? previous.current
      : null;
  const elapsed =
    input.sampledAt.getTime() -
    (baseline ? Date.parse(baseline.sampledAt) : input.startedAt.getTime());
  const processed =
    items.processed - (baseline?.processed ?? input.baselineProcessed ?? 0);
  const ratePerSecond =
    processed > 0 && elapsed > 0
      ? (processed * 1_000) / elapsed
      : (prior?.ratePerSecond ?? null);
  const sampledAt =
    same && processed === 0 && !input.reset
      ? previous.current.sampledAt
      : (items.processed === 0
          ? input.startedAt
          : input.sampledAt
        ).toISOString();
  return {
    current: { ...items, ratePerSecond, sampledAt, finished: input.finished },
    completed: previous
      ? same
        ? previous.completed
        : [
            ...previous.completed.filter(
              (sample) =>
                sample.phase !== previous.current.phase ||
                sample.unit !== previous.current.unit,
            ),
            { ...previous.current, finished: true },
          ]
      : [],
  };
}

function phaseRead(
  sample: RunWorkSample,
  status: string,
  now: Date,
  waiting = false,
): RunWorkPhase {
  const paused = status.startsWith("paused") || status === "needs_review";
  const stale = now.getTime() - Date.parse(sample.sampledAt) > 120_000;
  const state =
    status === "failed" || status === "dispatch_failed"
      ? "failed"
      : sample.finished || status === "completed"
        ? sample.failures
          ? "failed"
          : "completed"
        : paused
          ? "paused"
          : waiting
            ? "waiting"
            : "running";
  const etaSeconds =
    sample.total !== null && sample.ratePerSecond !== null
      ? Math.max(
          0,
          Math.ceil((sample.total - sample.processed) / sample.ratePerSecond),
        )
      : null;
  return {
    ...sample,
    state,
    etaSeconds,
    estimateState:
      sample.ratePerSecond === null
        ? null
        : paused
          ? "paused"
          : stale
            ? "stale"
            : "current",
  };
}

const outcomeCounts = z.object({
  total: z.number().int(),
  processed: z.number().int(),
  failures: z.number().int(),
  at: z.string().nullable(),
});
const photoCounts = outcomeCounts.extend({
  preparing: z.boolean(),
  settled: z.number().int(),
});
const photoCountKey = photoCounts.keyof().enum;
const deviceState = runTargetDeviceWorkState.enum;
const runOwnerId = sql`${sql.identifier("Run")}.${sql.identifier("id")}`;
const operationState = importOperationStatusOut.shape.state.enum;
const processedTargetStates = Object.entries(RUN_TARGET_BUCKET).flatMap(
  ([state, bucket]) =>
    bucket === "completed" || bucket === "skipped"
      ? [runTargetState.parse(state)]
      : [],
);

/** Every purpose declares a useful fallback count source; unknown populations stay unknown. */
const countSources = {
  account_sync: "targets",
  mail_import: "targets",
  purchase_validation: "targets",
  product_enrichment: "targets",
  photo_inventory: "targets",
  ai_suggest: "calls",
  suggestion_sweep: "checkpoint",
  ai_refresh: "checkpoint",
  background: "operations",
  file_import: "records",
  mail_search: "operations",
  mail_discovery: "checkpoint",
  mail_reclassify: "checkpoint",
  maintenance: "steps",
  derived_refresh: "steps",
  sweep: "steps",
} satisfies Record<
  RunPurpose,
  "targets" | "calls" | "operations" | "checkpoint" | "records" | "steps"
>;

function targetWorkCounts(
  rows: Awaited<ReturnType<typeof readRunProgressTargets>>,
) {
  const latest = [
    ...new Map(
      [...rows]
        .sort(
          (left, right) =>
            (left.completedAt?.getTime() ?? 0) -
            (right.completedAt?.getTime() ?? 0),
        )
        .map((target) => [
          `${target.entityKind}:${target.entityId}:${target.workKey}`,
          target,
        ]),
    ).values(),
  ];
  return {
    total: latest.length,
    processed: latest.filter(
      (target) =>
        target.completedAt !== null ||
        processedTargetStates.includes(runTargetState.parse(target.state)),
    ).length,
    failures: 0,
    at: latest.at(-1)?.completedAt?.toISOString() ?? null,
  };
}

function checkpointWorkItems(
  owner: Pick<typeof run.$inferSelect, "progress" | "input">,
  purpose: RunPurpose,
  items: RunWorkItems,
  previous: RunWorkSamples | undefined,
): RunWorkItems {
  const ai =
    purpose === "ai_refresh"
      ? aiRefreshProgress.safeParse(owner.progress).data
      : undefined;
  const sweep =
    purpose === "suggestion_sweep"
      ? suggestionSweepRunProgress.safeParse(owner.progress).data
      : undefined;
  const mail =
    purpose === "mail_discovery"
      ? mailDiscoveryRunProgress.safeParse(owner.progress).data
      : undefined;
  const reclassification =
    purpose === "mail_reclassify"
      ? mailReclassificationCheckpoint.safeParse(owner.progress).data
      : undefined;
  if (ai)
    items = {
      ...items,
      phase: "evaluate",
      label: "Evaluating",
      unit: "evaluations",
      processed:
        ai.completed +
        ai.failed +
        ai.blocked +
        (ai.obsolete ?? 0) +
        (ai.cancelled ?? 0),
      total: ai.selected,
      failures: ai.failed,
    };
  if (sweep)
    items = {
      ...items,
      phase: "suggest",
      label: "Evaluating suggestions",
      unit: "targets",
      processed: sweep.done,
      total: sweep.rosterPrepared ? sweep.total : null,
      failures: sweep.failed,
    };
  if (mail) {
    const phase =
      mail.phase === "listing" || mail.phase === "fetching"
        ? mail.phase
        : (previous?.current.phase ?? "listing");
    items = {
      ...items,
      phase,
      label: phase === "listing" ? "Discovering mail" : "Reading mail",
      unit: phase === "listing" ? "pages" : "emails",
      processed:
        phase === "listing"
          ? mail.pagesDone
          : mail.saved + mail.deleted + mail.excluded + mail.unrelated,
      total: null,
      failures: items.failures,
    };
  }
  if (reclassification)
    items = {
      ...items,
      phase: "reclassify",
      label: "Reclassifying",
      unit: "emails",
      processed: reclassification.results.length,
      total:
        mailReclassifyRunInput.safeParse(owner.input).data?.emails.length ??
        null,
      failures: reclassification.results.filter(
        (result) => result.error !== null,
      ).length,
    };
  return items;
}

/** The same storage-only projection feeds reports and MCP work snapshots. */
export async function getRunWorkProgress(
  db: Database,
  shortcode: string,
  now = new Date(),
): Promise<RunWorkProgress | null> {
  const [owner] = await getDb(db)
    .select({
      id: run.id,
      purpose: run.purpose,
      status: run.status,
      input: run.input,
      progress: run.progress,
      work: sql<unknown>`${run.liveProgress}->'work'`,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      updatedAt: run.updatedAt,
      heartbeatAt: run.heartbeatAt,
      ordersSeen: run.ordersSeen,
      imported: run.imported,
      updated: run.updated,
      skipped: run.skipped,
      phase: sql<string | null>`${run.liveProgress}->>'phase'`,
      photos: sql<unknown>`(SELECT jsonb_build_object('total', count(*), 'processed', count(*) FILTER (WHERE p.state IN (${sql.join(
        processedTargetStates.map((state) => sql`${state}`),
        sql`, `,
      )}) OR p."deviceWorkState" IN (${deviceState.completed}, ${deviceState.failed})), ${photoCountKey.settled}::text, count(*) FILTER (WHERE p.state IN (${sql.join(
        processedTargetStates.map((state) => sql`${state}`),
        sql`, `,
      )})), ${photoCountKey.preparing}::text, count(*) FILTER (WHERE p."deviceWorkState" IN (${deviceState.queued}, ${deviceState.running}, ${deviceState.paused}, ${deviceState.failed})) > 0, 'failures', count(*) FILTER (WHERE p."deviceWorkState" = ${deviceState.failed}), 'at', greatest(max(p."completedAt"), max(p."deviceWorkUpdatedAt"))) FROM "PhotoRunImage" p WHERE p."runId" = ${runOwnerId})`,
      operations: sql<unknown>`(SELECT jsonb_build_object('total', count(*), 'processed', count(*) FILTER (WHERE o.state IN (${operationState.completed}, ${operationState.failed})), 'failures', count(*) FILTER (WHERE o.state = ${operationState.failed}), 'at', max(o."completedAt")) FROM "RunOperation" o WHERE o."runId" = ${runOwnerId})`,
      calls: sql<unknown>`(SELECT jsonb_build_object('total', count(*), 'processed', count(*), 'failures', count(*) FILTER (WHERE u.status = ${aiUsageStatus.enum.failed}), 'at', max(u."createdAt")) FROM "AiUsage" u WHERE u."runId" = ${runOwnerId} AND u."deletedAt" IS NULL)`,
    })
    .from(run)
    .where(
      and(eq(run.shortcode, runShortcode.parse(shortcode)), notDeleted(run)),
    )
    .limit(1);
  if (!owner) return null;
  const status = runStatus.parse(owner.status);
  const purpose = runPurpose.parse(owner.purpose);
  const previous = runWorkSamples.safeParse(owner.work).data;
  const steps =
    countSources[purpose] === "steps" ? await listRunSteps(db, owner.id) : [];
  const currentStep =
    steps.find((step) => !isTerminalStep(step.state)) ?? steps.at(-1);
  if (currentStep) {
    const samples =
      currentStep.meta?.work ??
      sampleRunWork(
        undefined,
        {
          phase: currentStep.key,
          label: currentStep.label,
          unit: "items",
          processed:
            currentStep.done + currentStep.skipped + currentStep.failed,
          total:
            currentStep.found > 0 || isTerminalStep(currentStep.state)
              ? currentStep.found
              : null,
          failures: currentStep.failed,
        },
        {
          startedAt: currentStep.startedAt ?? owner.startedAt,
          sampledAt: currentStep.updatedAt,
          finished: isTerminalStep(currentStep.state),
        },
      );
    const completed = steps
      .filter((step) => step.position < currentStep.position)
      .flatMap((step) =>
        step.meta?.work
          ? [...step.meta.work.completed, step.meta.work.current]
          : [],
      );
    return {
      current: phaseRead(
        {
          ...samples.current,
          finished:
            samples.current.finished || isTerminalStep(currentStep.state),
        },
        currentStep.state === "failed" ? "failed" : status,
        now,
        currentStep.state === "waiting",
      ),
      completed: [...completed, ...samples.completed].map((sample) =>
        phaseRead({ ...sample, finished: true }, "completed", now),
      ),
    };
  }
  const photos = photoCounts.parse(owner.photos);
  const source = countSources[purpose];
  const targetRows =
    source === "targets" && purpose !== "photo_inventory"
      ? await (
          await import("~/server/domains/purchase-import/repo/run-service")
        ).readRunProgressTargets(db, owner.id)
      : [];
  const targets =
    purpose === "photo_inventory" ? photos : targetWorkCounts(targetRows);
  const operations = outcomeCounts.parse(owner.operations);
  const calls = outcomeCounts.parse(owner.calls);
  const useCalls =
    source === "calls" || (purpose === "background" && !operations.total);
  const counts = source === "targets" ? targets : useCalls ? calls : operations;
  const targetTotal =
    purpose === "mail_import"
      ? targets.total
      : purpose === "product_enrichment"
        ? productResearchRunInput.safeParse(owner.input).data?.products.length
        : purpose === "purchase_validation"
          ? purchaseValidationResearchRunInput.safeParse(owner.input).data
              ?.purchases.length
          : undefined;
  let items: RunWorkItems = {
    phase: owner.phase ?? purpose,
    label: RUN_PURPOSE_LABEL[purpose],
    unit:
      purpose === "photo_inventory"
        ? "images"
        : source === "targets"
          ? "targets"
          : useCalls
            ? "model calls"
            : "operations",
    processed: counts.processed,
    failures: counts.failures,
    total: targetTotal ?? (status === "completed" ? counts.total : null),
  };
  if (purpose === "photo_inventory")
    items = {
      ...items,
      phase: photos.preparing ? "prepare_images" : "review_images",
      label: photos.preparing ? "Preparing images" : "Reviewing images",
      total: photos.total,
      processed: photos.preparing ? photos.processed : photos.settled,
    };
  if (source === "records")
    items = {
      ...items,
      phase: "import",
      label: "Importing",
      unit: "records",
      processed: owner.imported + owner.updated + owner.skipped,
      total:
        owner.ordersSeen > 0
          ? owner.ordersSeen
          : status === "completed"
            ? owner.imported + owner.updated + owner.skipped
            : null,
    };
  items = checkpointWorkItems(owner, purpose, items, previous);
  const sampledAt =
    source !== "checkpoint" && source !== "records" && counts.at
      ? new Date(
          `${counts.at.endsWith("Z") || /[+-]\d\d:\d\d$/u.test(counts.at) ? counts.at : `${counts.at}Z`}`,
        )
      : (owner.endedAt ?? owner.updatedAt);
  const samples = sampleRunWork(previous, items, {
    startedAt:
      (previous &&
        (previous.current.phase !== items.phase ||
          previous.current.unit !== items.unit)) ||
      (!previous && source === "checkpoint")
        ? sampledAt
        : owner.startedAt,
    sampledAt,
    finished: status === "completed",
  });
  return {
    current: phaseRead(samples.current, status, now),
    completed: samples.completed.map((sample) =>
      phaseRead(sample, "completed", now),
    ),
  };
}

/** Call beside a checkpoint write; read-only status calls never mutate samples. */
export async function checkpointRunWorkProgress(
  db: Database,
  shortcode: string,
  now = new Date(),
) {
  const progress = await getRunWorkProgress(db, shortcode, now);
  if (!progress) return;
  await getDb(db)
    .update(run)
    .set({
      liveProgress: sql`jsonb_set(${run.liveProgress}, '{work}', ${JSON.stringify(runWorkSamples.parse(progress))}::jsonb)`,
    })
    .where(
      and(
        eq(run.shortcode, runShortcode.parse(shortcode)),
        sql`${run.liveProgress} IS NOT NULL`,
        notDeleted(run),
      ),
    );
}
