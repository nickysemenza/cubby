import type { EntityReportOut } from "@cubby/schemas/entity-report";
import { runShortcode } from "@cubby/schemas/identifiers";
import type { RunOut } from "@cubby/schemas/run";
import {
  hasImportRunReports,
  runPurpose,
  runStatus,
} from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import { listAiUsageForRun } from "~/server/ai/repo/ai-usage";
import { getDb, notDeleted } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import {
  loadRunDetail,
  loadRunLog,
  loadRunTimeline,
} from "~/server/domains/purchase-import/repo/run-service";
import { getRunLiveProgress } from "~/server/domains/run/repo/run-progress";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { suggestionCounts } from "~/server/generic/assessment/repo/suggestion-review";
import { getAuditLog } from "~/server/generic/audit-log/repo/audit-log";

import { reportDependency, type ReportExecution } from "./dependency";
import { runId } from "./record-dependencies";
import {
  aiUsageBlocks,
  changesBlocks,
  importReportBlocks,
  isImportReportSlot,
  isLiveRunStatus,
  liveProgressBlocks,
  runLogBlocks,
  runTimelineBlocks,
  suggestionBlocks,
  type RunReportSlot,
} from "./run";

const PAGE_SIZE = 25;

const reportHeaderReader = createEntityReader<
  Pick<typeof runTable.$inferSelect, "purpose" | "status">,
  Pick<RunOut, "purpose" | "status">,
  "run"
>({
  entity: "run",
  fetchById: async (db, id) => {
    const [row] = await getDb(db)
      .select({ purpose: runTable.purpose, status: runTable.status })
      .from(runTable)
      .where(and(eq(runTable.id, id), notDeleted(runTable)))
      .limit(1);
    return row;
  },
  fromDB: (_db, row) => ({
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

/** Only applicable import reports need full detail. Other purposes and a
 * standalone timeline use their own evidence projections. */
const runBase = reportDependency(async (execution) => {
  const code = runShortcode.parse(execution.request.id);
  const header = await execution.read(runHeader);
  const needsDetail =
    hasImportRunReports(header.purpose) &&
    execution.request.slots.some(
      (slot) => slot !== "run.import-timeline" && isImportReportSlot(slot),
    );
  const detail = needsDetail ? await execution.read(runDetail) : undefined;
  return {
    code,
    detail,
    status: runStatus.parse((detail ?? header).status),
    purpose: (detail ?? header).purpose,
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
        await suggestionCounts(execution.request.db, { runId: code }),
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
  "run.import-approvals": importSlot("run.import-approvals"),
  "run.import-findings": importSlot("run.import-findings"),
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
