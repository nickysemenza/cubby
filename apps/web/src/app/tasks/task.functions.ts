import { taskContract } from "~/contracts/task.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const task = defineOperationDomain(taskContract, {
  listActionable: { tags: [["task", "listActionable"]] },
  chartData: { tags: [["task", "chartData"]] },
  summary: { tags: [["task", "summary"]] },
  todayBriefing: { tags: [["task", "todayBriefing"]] },
  board: { tags: [["task", "board"]] },
  timeline: { tags: [["task", "timeline"]] },
  bulkReorder: { invalidates: ripple.task },
});
