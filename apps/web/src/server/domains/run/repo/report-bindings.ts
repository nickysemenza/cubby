import type { EntityReportOut } from "@cubby/schemas/entity-report";

import type { RunReportSlot } from "~/server/domains/run/repo/report-run";
import { reportDependency } from "~/server/generic/entity-report/repo/dependency";

/** Run service imports remain outside every other report's closure. */
const runBuilder = (slot: RunReportSlot) =>
  reportDependency(async (execution): Promise<EntityReportOut> => {
    const { RUN_REPORTS } =
      await import("~/server/domains/run/repo/report-run-dependencies");
    return execution.read(RUN_REPORTS[slot]);
  });

export const reportBindings = {
  "run.live-progress": runBuilder("run.live-progress"),
  "run.import-stats": runBuilder("run.import-stats"),
  "run.import-progress-live": runBuilder("run.import-progress-live"),
  "run.import-progress-stopped": runBuilder("run.import-progress-stopped"),
  "run.import-purchases": runBuilder("run.import-purchases"),
  "run.import-findings": runBuilder("run.import-findings"),
  "run.import-targets": runBuilder("run.import-targets"),
  "run.import-prepared-orders": runBuilder("run.import-prepared-orders"),
  "run.import-timeline": runBuilder("run.import-timeline"),
  "run.import-debug-log": runBuilder("run.import-debug-log"),
  "run.steps": runBuilder("run.steps"),
  "run.results": runBuilder("run.results"),
  "run.ai-usage": runBuilder("run.ai-usage"),
  "run.suggestions": runBuilder("run.suggestions"),
  "run.decisions": runBuilder("run.decisions"),
  "run.diagnostics": runBuilder("run.diagnostics"),
  "run.changes": runBuilder("run.changes"),
};
