import type { EntityReportOut } from "@cubby/schemas/entity-report";
import { runShortcode } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";

import {
  loadRunDetail,
  loadRunLog,
} from "~/server/purchase-import/run-service";
import { listAiUsageForRun } from "~/server/repo/ai-usage";
import { getAuditLog } from "~/server/repo/audit-log";
import { getRunByID } from "~/server/repo/run";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { suggestionCounts } from "~/server/repo/suggestion-review";

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
  suggestionBlocks,
  type RunReportSlot,
} from "./run";

const PAGE_SIZE = 25;

const runHeader = reportDependency(async (execution) =>
  getRunByID(execution.request.db, await execution.read(runId)),
);
const runDetail = reportDependency((execution) =>
  loadRunDetail(
    execution.request.db,
    execution.request.id,
    execution.read(runHeader),
  ),
);

/** Import slots require the detail; other Run slots need only the cheap header. */
const runBase = reportDependency(async (execution) => {
  const code = runShortcode.parse(execution.request.id);
  const detail = execution.request.slots.some(isImportReportSlot)
    ? await execution.read(runDetail)
    : undefined;
  const header = detail ?? (await execution.read(runHeader));
  return {
    code,
    detail,
    status: runStatus.parse(header.status),
    purpose: header.purpose,
  };
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
    const { detail } = await execution.read(runBase);
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
  "run.import-timeline": importSlot("run.import-timeline"),
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
