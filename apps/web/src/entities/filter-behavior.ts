import { taskStatusSchema } from "@cubby/schemas/task-fields";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { match } from "ts-pattern";

import { resolveDueRange } from "~/app/tasks/task-options";
import type { FilterPatch } from "~/entities/filters";

interface ProductPurchaseDateRangeFilters {
  purchaseDateFrom?: string;
  purchaseDateTo?: string;
}

type ProductPurchaseDateFilters = FilterPatch &
  (
    | { purchaseDatePresenceFilter: "has" | "none" }
    | ProductPurchaseDateRangeFilters
  );

/**
 * Resolves a date-range preset (as read off a date column filter) into
 * inclusive "YYYY-MM-DD" bounds anchored on today's local date. An
 * unknown/undefined preset resolves to `{}` — no bound, matching every date
 * (see `plainDate` in `@cubby/schemas/project`; the dates are timezone-free,
 * so bounds are computed from local `today`, never UTC).
 */
export function resolveDateRange(preset: string | undefined): {
  dateFrom?: string;
  dateTo?: string;
} {
  const today = new Date();
  const dateTo = format(today, "yyyy-MM-dd");
  const dateFrom = match(preset)
    .with("30d", () => format(subDays(today, 30), "yyyy-MM-dd"))
    .with("90d", () => format(subDays(today, 90), "yyyy-MM-dd"))
    .with("ytd", () => format(startOfYear(today), "yyyy-MM-dd"))
    .with("1y", () => format(subMonths(today, 12), "yyyy-MM-dd"))
    .otherwise(() => undefined);
  return dateFrom ? { dateFrom, dateTo } : {};
}

export const resolveProductPurchaseDateFilter = (
  preset: string | undefined,
): ProductPurchaseDateFilters => {
  if (preset === "has" || preset === "none") {
    return { purchaseDatePresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  const filters: FilterPatch & ProductPurchaseDateRangeFilters = {};
  if (dateFrom) filters.purchaseDateFrom = dateFrom;
  if (dateTo) filters.purchaseDateTo = dateTo;
  return filters;
};

export const resolveExpenseCount = (value: string | undefined) =>
  value === "has" || value === "none"
    ? { expensePresenceFilter: value }
    : value
      ? { expenseCountMin: Number(value) }
      : {};

export const resolveVendorPurchases = (value: string | undefined) =>
  value === "none"
    ? { purchaseCountMax: 0 }
    : value === "has"
      ? { purchaseCountMin: 1 }
      : value
        ? { purchaseCountMin: Number(value) }
        : {};

export const resolveLatestPurchaseDate = (preset: string | undefined) => {
  if (preset === "has" || preset === "none") {
    return { latestPurchaseDatePresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return {
    latestPurchaseDateFrom: dateFrom,
    latestPurchaseDateTo: dateTo,
  };
};

export const resolveVerifiedDate = (preset: string | undefined) => {
  if (preset === "has" || preset === "none") {
    return { verifiedPresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { verifiedFrom: dateFrom, verifiedTo: dateTo };
};

export const resolveProductTaskFilter = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { taskPresenceFilter: value };
  }
  if (value === "open") return { taskOpenOnly: true };
  if (taskStatusSchema.safeParse(value).success) {
    return { taskStatusFilter: value };
  }
  const { dueFrom, dueTo } = resolveDueRange(value);
  return { taskDueFrom: dueFrom, taskDueTo: dueTo };
};

export const resolveTaskDueFilter = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { duePresenceFilter: value };
  }
  return resolveDueRange(value);
};

export const resolveRecountAge = (value: string | undefined) => {
  const days = Number(value);
  return Number.isInteger(days) && days > 0
    ? { lastBulkInventoryOlderThanDays: days }
    : {};
};

export const resolveLocationItems = (value: string | undefined) =>
  value === "none"
    ? { directItemCountMax: 0 }
    : value === "has"
      ? { directItemCountMin: 1 }
      : value
        ? { directItemCountMin: Number(value) }
        : {};

export const resolvePostedDate = (preset: string | undefined) => {
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { postedDateFrom: dateFrom, postedDateTo: dateTo };
};

export const resolveCreatedDate = (preset: string | undefined) => {
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { createdFrom: dateFrom, createdTo: dateTo };
};

export const resolveUpdatedDate = (preset: string | undefined) => {
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { updatedFrom: dateFrom, updatedTo: dateTo };
};

export const resolveImageCreatedDate = (value: string | undefined) => {
  if (value === "olderThan1h") return { uploadedAgeHoursMin: 1 };
  return resolveCreatedDate(value);
};
