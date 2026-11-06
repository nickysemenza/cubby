import { taskCollectionReport } from "~/server/domains/task/repo/report-task";

export const reportBindings = {
  collection: { "task.briefing": taskCollectionReport },
};
