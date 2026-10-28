import { auditEntitySchema } from "@cubby/schemas/audit";
import { entityRefKey } from "@cubby/schemas/entity";
import type { EntityReportOut } from "@cubby/schemas/entity-report";
import { parseEntityRef, runShortcode } from "@cubby/schemas/identifiers";
import type { RunOut } from "@cubby/schemas/run";
import {
  hasImportRunReports,
  isExecutedRunPurpose,
  runPurpose,
  runStatus,
} from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import { listAiUsageForRun } from "~/server/ai/repo/ai-usage";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import { loadRunFindings } from "~/server/domains/purchase-import/repo/run-finding";
import {
  loadRunDetail,
  loadRunLog,
  loadRunTimeline,
} from "~/server/domains/purchase-import/repo/run-service";
import { getRunLiveProgress } from "~/server/domains/run/repo/run-progress";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import { identityShortcodes } from "~/server/entity-kernel/repo/entity-identity";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { suggestionCountsByFamily } from "~/server/generic/assessment/repo/suggestion-list";
import { getAuditLog } from "~/server/generic/audit-log/repo/audit-log";
import { runResultsBlocks } from "~/server/generic/entity-report/repo/run-results";
import { listRunJobs } from "~/server/generic/jobs/repo/job-diagnostics";
import { lookupEntityLabels } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { isStepRunPurpose } from "~/server/workflows/runs/contract";

import { reportDependency, type ReportExecution } from "./dependency";
import { runId } from "./record-dependencies";
import {
  aiUsageBlocks,
  changesBlocks,
  importReportBlocks,
  isImportReportSlot,
  isLiveRunStatus,
  liveProgressBlocks,
  runDiagnosticsBlocks,
  runFindingBlocks,
  runLogBlocks,
  runStepsBlocks,
  runTimelineBlocks,
  suggestionBlocks,
  type RunReportSlot,
} from "./run";

const PAGE_SIZE = 25;

const reportHeaderReader = createEntityReader<
  Pick<typeof runTable.$inferSelect, "purpose" | "status" | "input">,
  Pick<RunOut, "purpose" | "status"> &
    Pick<typeof runTable.$inferSelect, "input">,
  "run"
>({
  entity: "run",
  fetchById: async (db, id) => {
    const [row] = await getDb(db)
      .select({
        purpose: runTable.purpose,
        status: runTable.status,
        input: runTable.input,
      })
      .from(runTable)
      .where(and(eq(runTable.id, id), notDeleted(runTable)))
      .limit(1);
    return row;
  },
  fromDB: (_db, row) => ({
    input: row.input,
    purpose: runPurpose.parse(row.purpose),
    status: runStatus.parse(row.status),
  }),
});
const runHeader = reportDependency(async (execution) =>
  reportHeaderReader.getByID(execution.request.db, await execution.read(runId)),
);
const runDetail = reportDependency((execution) =>
  loadRunDetail(execution.request.db, execution.request.id),
);

/** Only applicable import reports need full detail. Findings and a standalone
 * timeline use their own evidence projections. */
const runBase = reportDependency(async (execution) => {
  const code = runShortcode.parse(execution.request.id);
  const header = await execution.read(runHeader);
  const needsDetail =
    hasImportRunReports(header.purpose) &&
    execution.request.slots.some(
      (slot) =>
        slot !== "run.import-findings" &&
        slot !== "run.import-timeline" &&
        isImportReportSlot(slot),
    );
  const detail = needsDetail ? await execution.read(runDetail) : undefined;
  return {
    code,
    detail,
    status: runStatus.parse((detail ?? header).status),
    purpose: (detail ?? header).purpose,
    input: header.input,
  };
});

const runTimeline = reportDependency(async (execution) => {
  const { detail } = await execution.read(runBase);
  return (
    detail?.operations ??
    loadRunTimeline(execution.request.db, await execution.read(runId))
  );
});

const runProgress = reportDependency(async (execution) => {
  const { code } = await execution.read(runBase);
  return getRunLiveProgress(execution.request.db, code);
});
const runSteps = reportDependency(async (execution) =>
  readRunSteps(execution.request.db, await execution.read(runId)),
);
const runLog = reportDependency(async (execution) => {
  const { code } = await execution.read(runBase);
  return loadRunLog(execution.request.db, code);
});
const runUsage = reportDependency(async (execution) => {
  const { db, cursor } = execution.request;
  return listAiUsageForRun(db, await execution.read(runId), {
    cursor,
    limit: PAGE_SIZE,
  });
});
const runChanges = reportDependency(async (execution) => {
  const { db, cursor } = execution.request;
  return getAuditLog(db, {
    runId: await execution.read(runId),
    cursor,
    limit: PAGE_SIZE,
  });
});
const runSuggestions = reportDependency(async (execution) => {
  const { code, purpose } = await execution.read(runBase);
  return purpose === "suggestion_sweep"
    ? suggestionBlocks(
        await suggestionCountsByFamily(execution.request.db, { runId: code }),
      )
    : [];
});

function runSlot(
  blocks: (
    execution: ReportExecution,
  ) => Promise<Pick<EntityReportOut, "blocks" | "nextCursor">>,
) {
  return reportDependency(async (execution): Promise<EntityReportOut> => {
    const { status } = await execution.read(runBase);
    return {
      ...(await blocks(execution)),
      status,
      live: isLiveRunStatus(status),
    };
  });
}

const importSlot = (slot: Parameters<typeof importReportBlocks>[0]) =>
  runSlot(async (execution) => {
    const { detail, purpose } = await execution.read(runBase);
    if (!hasImportRunReports(purpose)) return { blocks: [] };
    if (!detail) throw new Error("An import report requires the Run detail.");
    return { blocks: importReportBlocks(slot, detail) };
  });

export const RUN_REPORTS = {
  "run.results": runSlot(async (execution) => {
    const db = execution.request.db;
    const blocks = await runResultsBlocks(
      execution.request.db,
      await execution.read(runId),
      execution.request.id,
      await execution.read(runSteps),
    );
    const refs = blocks.flatMap((block) =>
      block.kind === "records"
        ? block.rows.flatMap((row) =>
            row.entity && row.id
              ? [parseEntityRef(auditEntitySchema.parse(row.entity), row.id)]
              : [],
          )
        : [],
    );
    const [names, identities] = await Promise.all([
      lookupEntityLabels(db, refs),
      identityShortcodes(
        db,
        refs.map((ref) => ref.id),
      ),
    ]);
    for (const block of blocks) {
      if (block.kind !== "records") continue;
      for (const row of block.rows) {
        if (!row.entity || !row.id) continue;
        const ref = parseEntityRef(auditEntitySchema.parse(row.entity), row.id);
        const identity = identities.get(ref.id);
        row.title =
          names.get(entityRefKey(ref.entity, ref.id)) ??
          identity?.shortcode ??
          ref.entity;
        const deleted = row.badges?.some((badge) => badge.label === "Deleted");
        row.entity = identity?.shortcode && !deleted ? ref.entity : null;
        row.id = identity?.shortcode && !deleted ? identity.shortcode : null;
      }
    }
    return { blocks };
  }),
  "run.steps": runSlot(async (execution) => {
    const { code, status, purpose, input } = await execution.read(runBase);
    if (!isStepRunPurpose(purpose)) return { blocks: [] };
    return {
      blocks: runStepsBlocks({
        input,
        code,
        purpose,
        status,
        steps: await execution.read(runSteps),
      }),
    };
  }),
  "run.live-progress": runSlot(async (execution) => {
    const { code } = await execution.read(runBase);
    const progress = await execution.read(runProgress);
    return {
      blocks: progress
        ? liveProgressBlocks(code, progress)
        : [{ kind: "note", text: "Run progress is unavailable." }],
    };
  }),
  "run.import-stats": importSlot("run.import-stats"),
  "run.import-progress-live": importSlot("run.import-progress-live"),
  "run.import-progress-stopped": importSlot("run.import-progress-stopped"),
  "run.import-purchases": importSlot("run.import-purchases"),
  "run.import-findings": runSlot(async (execution) => ({
    blocks: runFindingBlocks(
      await loadRunFindings(execution.request.db, await execution.read(runId)),
    ),
  })),
  "run.import-targets": importSlot("run.import-targets"),
  "run.import-prepared-orders": importSlot("run.import-prepared-orders"),
  "run.import-timeline": runSlot(async (execution) => ({
    blocks: runTimelineBlocks({
      operations: await execution.read(runTimeline),
    }),
  })),
  "run.import-debug-log": runSlot(async (execution) => ({
    blocks: runLogBlocks(await execution.read(runLog)),
  })),
  "run.ai-usage": runSlot(async (execution) => {
    const usage = await execution.read(runUsage);
    return {
      blocks: aiUsageBlocks(usage),
      nextCursor: usage.nextCursor ?? undefined,
    };
  }),
  "run.decisions": runSlot(async (execution) => {
    const { code, purpose } = await execution.read(runBase);
    if (!isStepRunPurpose(purpose)) return { blocks: [] };
    return {
      blocks: suggestionBlocks(
        await suggestionCountsByFamily(execution.request.db, { runId: code }),
      ),
    };
  }),
  "run.diagnostics": runSlot(async (execution) => {
    const { code, purpose } = await execution.read(runBase);
    if (!isExecutedRunPurpose(purpose)) return { blocks: [] };
    return {
      blocks: runDiagnosticsBlocks(
        await listRunJobs(execution.request.db, code),
      ),
    };
  }),
  "run.suggestions": runSlot(async (execution) => ({
    blocks: await execution.read(runSuggestions),
  })),
  "run.changes": runSlot(async (execution) => {
    const list = await execution.read(runChanges);
    return {
      blocks: changesBlocks(list),
      nextCursor: list.nextCursor ?? undefined,
    };
  }),
} satisfies Record<RunReportSlot, ReturnType<typeof runSlot>>;
