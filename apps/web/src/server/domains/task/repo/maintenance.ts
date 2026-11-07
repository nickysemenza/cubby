import { maintenanceHistoryGroup } from "@cubby/schemas/household-maintenance";
import { type RawTaskListItemOut } from "@cubby/schemas/work-raw-read";
import { z } from "zod";

import { plainDateDaysBetween } from "~/lib/household-date";

/** Exact titles only: no stemming, fuzzy matching, or inferred equivalence. */
export function maintenanceHistory(
  tasks: Pick<
    RawTaskListItemOut,
    | "id"
    | "name"
    | "status"
    | "completedOn"
    | "subjectProductId"
    | "subjectProductName"
  >[],
): z.infer<typeof maintenanceHistoryGroup>[] {
  const groups = new Map<string, z.infer<typeof maintenanceHistoryGroup>>();
  for (const task of tasks) {
    const key = JSON.stringify([task.name, task.subjectProductId]);
    const group = groups.get(key) ?? {
      name: task.name,
      subjectProductId: task.subjectProductId,
      subjectProductName: task.subjectProductName,
      taskIds: [],
      completedDates: [],
      undatedCompletions: 0,
      medianIntervalDays: null,
    };
    group.taskIds.push(task.id);
    if (task.status === "done") {
      if (task.completedOn) group.completedDates.push(task.completedOn);
      else group.undatedCompletions++;
    }
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    // Same-day duplicate records cannot establish a zero-day cadence.
    group.completedDates = [...new Set(group.completedDates)].sort();
    const intervals = group.completedDates
      .slice(1)
      .map((date, index) =>
        plainDateDaysBetween(group.completedDates[index]!, date),
      )
      .sort((a, b) => a - b);
    if (intervals.length > 0) {
      const middle = Math.floor(intervals.length / 2);
      group.medianIntervalDays =
        intervals.length % 2
          ? intervals[middle]!
          : (intervals[middle - 1]! + intervals[middle]!) / 2;
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
